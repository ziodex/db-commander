import type { CatalogQuery } from '../catalog/common'
import { PRINCIPAL_LIMIT, decodeOraclePrincipalId, type Bounded, type PrincipalCatalogGrant, type PrincipalRequest, type PrincipalRole, type PrincipalSnapshot } from '../shared/principals'

const limit = PRINCIPAL_LIMIT + 1
const bounded = <T>(rows: T[]): Bounded<T> => ({ rows: rows.slice(0, PRINCIPAL_LIMIT), truncated: rows.length > PRINCIPAL_LIMIT })
const placeholders = (values: string[], offset = 1) => values.map((_, index) => ':' + (index + offset)).join(', ')
const principal = (name: string, kind: 'user' | 'role'): PrincipalRole => ({
  id: JSON.stringify(['oracle', name, kind]), name, description: kind === 'user' ? 'User' : 'Role', canGrantMembership: kind === 'role'
})

export async function readOraclePrincipals(query: CatalogQuery, request: PrincipalRequest): Promise<PrincipalSnapshot> {
  const [[database, observer]] = await query("SELECT SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'SESSION_USER') FROM dual")
  let restricted = false
  async function dictionary(sql: string, values: string[] = []) {
    try { return await query(sql, values) }
    catch (error) {
      if (![942, 1031].includes(Number((error as { errorNum?: number })?.errorNum))) throw error
      restricted = true
      return null
    }
  }
  const scope = () => ({ database: database!, observer: observer!, notice: restricted
    ? 'Some Oracle dictionary views are restricted. Only users, roles and grants visible in this container are shown.'
    : 'Shows Oracle users and roles in the current container.' })
  const visibleRoles = `(SELECT GRANTED_ROLE AS role FROM USER_ROLE_PRIVS
    UNION SELECT ROLE FROM ROLE_ROLE_PRIVS UNION SELECT GRANTED_ROLE FROM ROLE_ROLE_PRIVS UNION SELECT ROLE FROM SESSION_ROLES)`
  if (request.mode === 'roles') {
    const filter = `WHERE :1 IS NULL OR INSTR(LOWER(name), LOWER(:2)) > 0 ORDER BY name FETCH FIRST ${limit} ROWS ONLY`
    const values = [request.search, request.search]
    const users = await query(`SELECT name FROM (SELECT USERNAME AS name FROM ALL_USERS) ${filter}`, values)
    const roles = await dictionary(`SELECT name FROM (SELECT ROLE AS name FROM DBA_ROLES) ${filter}`, values)
      ?? await query(`SELECT name FROM (SELECT ROLE AS name FROM ${visibleRoles}) ${filter}`, values)
    const rows = [...users.map(([name]) => principal(name!, 'user')), ...roles.map(([name]) => principal(name!, 'role'))]
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return { ...scope(), mode: 'roles', roles: bounded(rows) }
  }

  const selected = decodeOraclePrincipalId(request.roleId)
  if (!selected) throw new Error('Select a visible Oracle user or role.')
  const { name, kind } = selected
  const exists = kind === 'user' ? await query('SELECT USERNAME FROM ALL_USERS WHERE USERNAME = :1', [name])
    : await dictionary('SELECT ROLE FROM DBA_ROLES WHERE ROLE = :1', [name])
      ?? await query(`SELECT ROLE FROM ${visibleRoles} WHERE ROLE = :1`, [name])
  if (!exists.length) throw new Error('This Oracle principal is no longer visible. Refresh and select it again.')
  const role = principal(name, kind)
  const own = kind === 'user' && name === observer
  const roleView = await dictionary('SELECT GRANTED_ROLE FROM DBA_ROLE_PRIVS FETCH FIRST 1 ROWS ONLY')
  const edges = roleView ? 'DBA_ROLE_PRIVS' : `(SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS grantee, GRANTED_ROLE, ADMIN_OPTION FROM USER_ROLE_PRIVS
    UNION ALL SELECT ROLE AS grantee, GRANTED_ROLE, ADMIN_OPTION FROM ROLE_ROLE_PRIVS)`
  const direct = bounded((await query(`SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION FROM ${edges}
    WHERE GRANTEE = :1 OR GRANTED_ROLE = :2 ORDER BY GRANTEE, GRANTED_ROLE, ADMIN_OPTION FETCH FIRST ${limit} ROWS ONLY`, [name, name]))
    .map(([member, role, admin]) => ({ role: role!, member: member!, admin: admin === 'YES', grantor: null, inherit: null, set: null })))
  const inherited = await query(`SELECT GRANTED_ROLE, MAX(depth) FROM (
      SELECT GRANTED_ROLE, LEVEL AS depth FROM ${edges}
      START WITH GRANTEE = :1 CONNECT BY NOCYCLE PRIOR GRANTED_ROLE = GRANTEE AND LEVEL <= 32
    ) GROUP BY GRANTED_ROLE ORDER BY GRANTED_ROLE FETCH FIRST ${limit} ROWS ONLY`, [name])
  const enabled = own ? bounded((await query(`SELECT ROLE FROM SESSION_ROLES ORDER BY ROLE FETCH FIRST ${limit} ROWS ONLY`)).map(([role]) => role!)) : null
  const memberships = bounded(inherited.map(([role]) => ({ role: role!, usable: enabled?.rows.includes(role!) ? true : null })))
  if (inherited.some(([, depth]) => depth === '32')) memberships.truncated = true

  let relation: typeof request.relation | null
  if (request.relation) {
    const [object] = await query(`SELECT OWNER, OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2
      AND OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') FETCH FIRST 1 ROWS ONLY`, [request.relation.schema, request.relation.name])
    relation = object ? { schema: object[0]!, name: object[1]! } : null
  }
  const sources = [...new Set([name, ...inherited.slice(0, PRINCIPAL_LIMIT).map(([role]) => role!), 'PUBLIC'])]
  const binds = placeholders(sources)
  const enabledHere = (source: string) => enabled?.rows.includes(source) ? true : undefined
  const grants: PrincipalCatalogGrant[] = []
  if (relation) {
    const args = [...sources, relation.schema, relation.name]
    const matches = `GRANTEE IN (${binds}) AND OWNER = :${sources.length + 1} AND TABLE_NAME = :${sources.length + 2}`
    const rows = await dictionary(`SELECT GRANTEE, PRIVILEGE, GRANTABLE FROM DBA_TAB_PRIVS WHERE ${matches}
      ORDER BY GRANTEE, PRIVILEGE, GRANTABLE FETCH FIRST ${limit} ROWS ONLY`, args)
      ?? await query(`SELECT GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE ${matches.replace('AND OWNER', 'AND TABLE_SCHEMA')}
      ORDER BY GRANTEE, PRIVILEGE, GRANTABLE FETCH FIRST ${limit} ROWS ONLY`, args)
    for (const [source, privilege, option] of rows) {
      grants.push({ scope: `Relation ${relation.schema}.${relation.name}`, privilege: privilege!, grantable: option === 'YES',
        via: source === name ? undefined : source!, enabled: enabledHere(source!) })
    }
  }
  const system = await dictionary(`SELECT GRANTEE, PRIVILEGE, ADMIN_OPTION FROM DBA_SYS_PRIVS WHERE GRANTEE IN (${binds})
    ORDER BY GRANTEE, PRIVILEGE FETCH FIRST ${limit} ROWS ONLY`, sources)
    ?? await query(`SELECT grantee, privilege, admin_option FROM (
      SELECT ROLE AS grantee, PRIVILEGE, ADMIN_OPTION FROM ROLE_SYS_PRIVS
      UNION ALL SELECT USERNAME AS grantee, PRIVILEGE, ADMIN_OPTION FROM USER_SYS_PRIVS
    ) WHERE grantee IN (${binds}) ORDER BY grantee, privilege FETCH FIRST ${limit} ROWS ONLY`, sources)
  for (const [source, privilege, option] of system) {
    grants.push({ scope: 'System', privilege: privilege!, grantable: null,
      effect: option === 'YES' ? 'ADMIN_OPTION' : undefined, via: source === name ? undefined : source!, enabled: enabledHere(source!) })
  }
  const effective = own ? bounded((await query(`SELECT PRIVILEGE FROM SESSION_PRIVS ORDER BY PRIVILEGE FETCH FIRST ${limit} ROWS ONLY`))
    .map(([privilege]) => ({ scope: 'System', privilege: privilege! }))) : undefined
  return { ...scope(), mode: 'role', role, direct, memberships, databasePrivileges: [],
    catalog: { relation, enabled, grants: bounded(grants), effective,
      grantNotice: 'Shows visible system and selected-relation grants, including role and PUBLIC sources. Column grants and policy-dependent access are outside this view.',
      membershipNotice: 'Shows visible direct and inherited role memberships. Enabled roles are shown for the connected user on the separate catalog connection.' } }
}
