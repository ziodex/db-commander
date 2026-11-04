import type { CatalogQuery } from '../catalog/common'
import { PRINCIPAL_LIMIT, type Bounded, type PrincipalRequest, type PrincipalRole, type PrincipalSnapshot } from '../shared/principals'
import { quoteIdentifier } from '../shared/sql/common'

const limit = PRINCIPAL_LIMIT + 1
const bounded = <T>(rows: T[]): Bounded<T> => ({ rows: rows.slice(0, PRINCIPAL_LIMIT), truncated: rows.length > PRINCIPAL_LIMIT })
const principal = ([id, name, type, description, fixed]: (string | null)[]): PrincipalRole => ({
  id: id!, name: name!, canGrantMembership: type === 'R' && name !== 'public',
  description: fixed === '1' ? 'Fixed role' : description?.toLowerCase().replaceAll('_', ' ')
})

export function sqlServerPrincipalCatalog(server: boolean, logical: boolean) {
  if (!server) return 'sys.database_principals'
  if (!logical) return 'sys.server_principals'
  return `(SELECT principal_id, name, type, type_desc, is_fixed_role, sid, create_date, is_disabled
    FROM sys.server_principals WHERE type <> 'S'
    UNION ALL SELECT principal_id, name, type, type_desc, CONVERT(bit, 0), sid, create_date, is_disabled FROM sys.sql_logins)`
}

export async function readSqlServerPrincipals(query: CatalogQuery, request: PrincipalRequest): Promise<PrincipalSnapshot> {
  const server = request.scope === 'server'
  const [[database, observer, edition, current]] = await query(`SELECT DB_NAME(), ${server ? 'SUSER_SNAME()' : 'USER_NAME()'},
    CONVERT(int, SERVERPROPERTY('EngineEdition')), ${server ? 'NULL' : 'USER_ID()'}`)
  const azure = edition === '5'
  const scope = { database: database!, observer: observer!,
    notice: server ? 'Shows server principals visible to the catalog login.' : 'Shows database principals visible to the catalog user.' }
  const principals = sqlServerPrincipalCatalog(server, azure)
  const membershipTable = server ? 'sys.server_role_members' : 'sys.database_role_members'
  const roleColumns = 'p.principal_id, p.name, p.type, p.type_desc, p.is_fixed_role'
  if (request.mode === 'roles') {
    const rows = await query(`SELECT TOP (${limit}) ${roleColumns} FROM ${principals} p
      WHERE CHARINDEX(LOWER(@p1), LOWER(p.name)) > 0 ORDER BY p.name, p.principal_id`, [request.search])
    return { ...scope, mode: 'roles', roles: bounded(rows.map(principal)) }
  }
  if (!/^\d{1,10}$/.test(request.roleId) || Number(request.roleId) > 2147483647) throw new Error('Select a SQL Server principal.')
  const [row] = await query(`SELECT ${roleColumns}${server ? ', CASE WHEN p.sid = SUSER_SID() THEN 1 ELSE 0 END' : ''} FROM ${principals} p WHERE p.principal_id = CONVERT(int, @p1)`, [request.roleId])
  if (!row) throw new Error('This principal is no longer visible. Refresh the list and select it again.')
  const role = principal(row)
  const own = server ? row[5] === '1' : role.id === current
  const logicalServer = server && azure
  const direct = bounded((await query(`SELECT TOP (${limit}) r.name, m.name
    FROM ${membershipTable} e JOIN ${principals} r ON r.principal_id = e.role_principal_id
    JOIN ${principals} m ON m.principal_id = e.member_principal_id
    WHERE e.role_principal_id = CONVERT(int, @p1) OR e.member_principal_id = CONVERT(int, @p1)
    ORDER BY r.name, m.name, r.principal_id, m.principal_id`, [role.id]))
    .map(([role, member]) => ({ role: role!, member: member!, grantor: null, admin: null, inherit: null, set: null })))
  const inherited = await query(`WITH granted(role_id, depth) AS (
      SELECT role_principal_id, 1 FROM ${membershipTable} WHERE member_principal_id = CONVERT(int, @p1)
      UNION ALL SELECT e.role_principal_id, g.depth + 1 FROM ${membershipTable} e
        JOIN granted g ON g.role_id = e.member_principal_id WHERE g.depth < 32
    ) SELECT TOP (${limit}) p.principal_id, p.name, MAX(g.depth)
      FROM granted g JOIN ${principals} p ON p.principal_id = g.role_id
      GROUP BY p.principal_id, p.name ORDER BY p.name, p.principal_id OPTION (MAXRECURSION 32)`, [role.id])
  const token = own && !logicalServer ? await query(`SELECT TOP (${limit}) name FROM sys.${server ? 'login_token' : 'user_token'} WHERE type = ${server ? "'SERVER ROLE'" : "'ROLE'"} ORDER BY name`) : null
  const enabled = token ? bounded(token.map(([name]) => name!)) : null
  const memberships = bounded(inherited.map(([, name]) => ({ role: name!, usable: enabled?.rows.includes(name!) ? true : null })))
  if (inherited.some(([, , depth]) => depth === '32')) memberships.truncated = true

  if (logicalServer) return { ...scope, mode: 'role', role, direct, memberships, databasePrivileges: [],
    catalog: { enabled: null, grants: bounded([]),
      grantNotice: 'Azure SQL logical-server access is represented by its predefined server roles. Inspect database permissions in the Current database scope.',
      membershipNotice: 'Shows server role memberships visible in logical-server master.' } }

  let relation: { schema: string; name: string } | null | undefined
  let objectId: string | null = null
  if (!server && request.relation) {
    const candidate = request.relation
    const [object] = await query(`SELECT o.object_id, s.name, o.name
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V') AND s.name = @p1 AND o.name = @p2`, [candidate.schema, candidate.name])
    relation = object ? { schema: object[1]!, name: object[2]! } : null
    objectId = object?.[0] ?? null
  }

  const qualifiedRelation = relation ? relation.schema + '.' + relation.name : ''
  const sourceIds = [...new Set([role.id, ...inherited.slice(0, PRINCIPAL_LIMIT).map(([id]) => id!)])]
  const parameters = sourceIds.map((_, index) => `CONVERT(int, @p${index + 2})`).join(', ')
  const grants = bounded((await query(`SELECT TOP (${limit}) p.name, a.permission_name, a.state_desc,
      ${server ? "a.class_desc" : "CASE WHEN a.class = 0 THEN 'Database' WHEN a.class = 3 THEN CONCAT('Schema ', SCHEMA_NAME(a.major_id)) WHEN a.minor_id = 0 THEN 'Relation' ELSE CONCAT('Column ', COL_NAME(a.major_id, a.minor_id)) END"},
      a.grantee_principal_id
    FROM sys.${server ? 'server_permissions' : 'database_permissions'} a JOIN ${principals} p ON p.principal_id = a.grantee_principal_id
    WHERE (a.grantee_principal_id IN (${parameters}) OR p.name = 'public')
      ${server ? '' : 'AND (a.class IN (0,3) OR a.class = 1 AND a.major_id = CONVERT(int, @p1))'}
    ORDER BY CASE WHEN a.grantee_principal_id = CONVERT(int, ${server ? '@p1' : '@p2'}) THEN 0 ELSE 1 END,
      a.class, a.major_id, ${server ? '' : 'a.minor_id,'} p.name, a.permission_name, a.state_desc`,
  [server ? role.id : objectId, ...sourceIds])).map(([name, privilege, effect, scope, id]) =>
    ({ scope: scope === 'Relation' ? `Relation ${qualifiedRelation}` : scope?.startsWith('Column ') ? `Column ${qualifiedRelation}.${scope.slice(7)}` : scope!, privilege: privilege!, effect: effect!, grantable: effect === 'GRANT_WITH_GRANT_OPTION',
      via: id === role.id ? undefined : name!, enabled: enabled?.rows.includes(name!) ? true : undefined })))

  const native = own ? await query(`SELECT TOP (${limit}) permission_name FROM sys.fn_my_permissions(NULL, '${server ? 'SERVER' : 'DATABASE'}') ORDER BY permission_name`) : undefined
  const effective = native?.map(([privilege]) => ({ scope: server ? 'Server' : 'Database', privilege: privilege! }))
  if (effective && relation) {
    const qualified = quoteIdentifier(relation.schema, 'sqlserver') + '.' + quoteIdentifier(relation.name, 'sqlserver')
    const objectPermissions = await query(`SELECT TOP (${limit}) subentity_name, permission_name FROM sys.fn_my_permissions(@p1, 'OBJECT')
      ORDER BY subentity_name, permission_name`, [qualified])
    effective.unshift(...objectPermissions.map(([column, privilege]) => ({ scope: column ? `Column ${qualifiedRelation}.${column}` : `Relation ${qualifiedRelation}`, privilege: privilege! })))
  }
  return { ...scope, mode: 'role', role, direct, memberships, databasePrivileges: [],
    catalog: { relation, enabled, grants, effective: effective ? bounded(effective) : undefined,
      grantNotice: 'Catalog entries include grants, denials and role sources. Fixed-role permissions, ownership and external groups can affect actual access.',
      membershipNotice: 'Shows direct and inherited memberships visible in the catalog. For the connected principal, the catalog connection’s security token shows active roles.',
      enabledLabel: 'Roles in the catalog connection’s security token' } }
}
