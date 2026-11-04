import type { CatalogQuery } from '../catalog/common'
import { PRINCIPAL_LIMIT, relationPrivileges, type PrincipalPrivilege, type PrincipalRelation, type PrincipalRequest, type PrincipalRole, type PrincipalSnapshot } from '../shared/principals'

const roleColumns = 'r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls'
const limit = PRINCIPAL_LIMIT + 1
const flag = (value: string | null) => value === 'true'
const nullableFlag = (value: string | null) => value === null ? null : flag(value)
const bounded = <T>(rows: (string | null)[][], convert: (row: (string | null)[]) => T) =>
  ({ rows: rows.slice(0, PRINCIPAL_LIMIT).map(convert), truncated: rows.length > PRINCIPAL_LIMIT })
const role = (r: (string | null)[]): PrincipalRole => ({
  id: r[0]!, name: r[1]!, login: flag(r[2]), superuser: flag(r[3]), inherit: flag(r[4]),
  createRole: flag(r[5]), createDatabase: flag(r[6]), replication: flag(r[7]), bypassRls: flag(r[8])
})
const privileges = (rows: (string | null)[][]): PrincipalPrivilege[] =>
  rows.map(r => ({ privilege: r[0]!, effective: flag(r[1]), grantable: flag(r[2]) }))

/** Each request runs on a dedicated read-only PostgreSQL catalog connection. */
export async function readPostgresPrincipals(query: CatalogQuery, request: PrincipalRequest): Promise<PrincipalSnapshot> {
  const [[database, observer]] = await query('SELECT current_database(), current_user')
  const scope = { database: database!, observer: observer! }
  if (request.mode === 'roles') {
    const rows = await query(`SELECT ${roleColumns} FROM pg_roles r
      WHERE strpos(lower(r.rolname), lower($1)) > 0
      ORDER BY r.rolname, r.oid LIMIT ${limit}`, [request.search])
    return { ...scope, mode: 'roles', roles: bounded(rows, role) }
  }

  if (!/^\d{1,10}$/.test(request.roleId)) throw new Error('Select a PostgreSQL role.')
  const values = [request.roleId]
  const [selected] = await query(`SELECT ${roleColumns} FROM pg_roles r WHERE r.oid = $1::oid`, values)
  if (!selected) throw new Error('This PostgreSQL role is no longer visible. Refresh roles and select it again.')
  const direct = bounded(await query(`SELECT r.rolname, u.rolname, COALESCE(g.rolname, m.grantor::text),
      m.admin_option, to_jsonb(m)->>'inherit_option', to_jsonb(m)->>'set_option'
    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member LEFT JOIN pg_roles g ON g.oid = m.grantor
    WHERE m.member = $1::oid OR m.roleid = $1::oid
    ORDER BY r.rolname, u.rolname, m.grantor LIMIT ${limit}`, values),
  r => ({ role: r[0]!, member: r[1]!, grantor: r[2]!, admin: flag(r[3]), inherit: nullableFlag(r[4]), set: nullableFlag(r[5]) }))
  const memberships = bounded(await query(`SELECT r.rolname, pg_has_role($1::oid, r.oid, 'USAGE')
    FROM pg_roles r WHERE r.oid <> $1::oid AND pg_has_role($1::oid, r.oid, 'MEMBER')
    ORDER BY r.rolname LIMIT ${limit}`, values), r => ({ role: r[0]!, usable: flag(r[1]) }))
  const databasePrivileges = privileges(await query(`SELECT p.name, has_database_privilege($1::oid, current_database(), p.name),
    has_database_privilege($1::oid, current_database(), p.name || ' WITH GRANT OPTION')
    FROM (VALUES ('CONNECT'), ('CREATE'), ('TEMPORARY')) p(name)`, values))
  const result: Extract<PrincipalSnapshot, { mode: 'role' }> = { ...scope, mode: 'role', role: role(selected), direct, memberships, databasePrivileges }
  if (!request.relation) return result

  const table = await postgresPrincipalRelation(query, request.roleId, request.relation)
  if (!table) return { ...result, relation: null }

  const target = [request.roleId, table[0]]
  const tablePrivileges = privileges(await query(`SELECT p.name, has_table_privilege($1::oid, $2::oid, p.name),
    has_table_privilege($1::oid, $2::oid, p.name || ' WITH GRANT OPTION')
    FROM (VALUES ${relationPrivileges.map(privilege => `('${privilege}')`).join(', ')}) p(name)`, target))
  const grants = bounded(await query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      pg_get_userbyid(a.grantor), a.privilege_type, a.is_grantable
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid = $2::oid AND a.grantee IN (0, $1::oid)
    ORDER BY a.grantee, a.grantor, a.privilege_type LIMIT ${limit}`, target),
  r => ({ grantee: r[0]!, grantor: r[1]!, privilege: r[2]!, grantable: flag(r[3]) }))
  return { ...result, relation: { target: request.relation, schemaUsage: flag(table[1]), rowSecurity: flag(table[2]), owner: table[3]!, privileges: tablePrivileges, grants } }
}

export async function postgresPrincipalRelation(query: CatalogQuery, roleId: string, relation: PrincipalRelation) {
  const [table] = await query(`SELECT c.oid, has_schema_privilege($1::oid, n.oid, 'USAGE'), c.relrowsecurity, pg_get_userbyid(c.relowner)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $2::text AND c.relname = $3::text AND c.relkind IN ('r','p','v','m','f')
      AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
      AND has_schema_privilege(n.oid, 'USAGE')
      AND (pg_has_role(c.relowner, 'USAGE') OR has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
        OR has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))`,
  [roleId, relation.schema, relation.name])
  return table
}
