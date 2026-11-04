import type { CatalogQuery } from '../catalog/common'
import { PRINCIPAL_LIMIT, decodeMysqlPrincipalId, mysqlPrincipalSql, type Bounded, type MysqlPrincipal, type MysqlPrincipalEngine, type PrincipalCatalogGrant, type PrincipalMembership, type PrincipalRequest, type PrincipalRole, type PrincipalSnapshot } from '../shared/principals'

const limit = PRINCIPAL_LIMIT + 1
const hiddenSchemas = ['information_schema', 'mysql', 'performance_schema', 'sys']
const databasePrivileges = {
  Select_priv: 'SELECT', Insert_priv: 'INSERT', Update_priv: 'UPDATE', Delete_priv: 'DELETE',
  Create_priv: 'CREATE', Drop_priv: 'DROP', References_priv: 'REFERENCES', Index_priv: 'INDEX', Alter_priv: 'ALTER',
  Create_tmp_table_priv: 'CREATE TEMPORARY TABLES', Lock_tables_priv: 'LOCK TABLES',
  Create_view_priv: 'CREATE VIEW', Show_view_priv: 'SHOW VIEW', Trigger_priv: 'TRIGGER',
  Create_routine_priv: 'CREATE ROUTINE', Alter_routine_priv: 'ALTER ROUTINE', Execute_priv: 'EXECUTE', Event_priv: 'EVENT'
}
const globalPrivileges = {
  ...databasePrivileges, Reload_priv: 'RELOAD', Shutdown_priv: 'SHUTDOWN', Process_priv: 'PROCESS',
  File_priv: 'FILE', Show_db_priv: 'SHOW DATABASES', Super_priv: 'SUPER', Repl_slave_priv: 'REPLICATION SLAVE',
  Repl_client_priv: 'REPLICATION CLIENT', Create_user_priv: 'CREATE USER'
}
const mysqlGlobalPrivileges = {
  ...globalPrivileges, Create_tablespace_priv: 'CREATE TABLESPACE', Create_role_priv: 'CREATE ROLE', Drop_role_priv: 'DROP ROLE'
}

const bounded = <T>(rows: T[]): Bounded<T> => ({ rows: rows.slice(0, PRINCIPAL_LIMIT), truncated: rows.length > PRINCIPAL_LIMIT })
const yes = (value: string | null) => value === 'Y' || value === 'YES'
const identity = (user: string | null, host: string | null): MysqlPrincipal => ({ user: user ?? '', host: host ?? '' })
const key = (account: MysqlPrincipal) => JSON.stringify([account.user, account.host])
const equal = (a: MysqlPrincipal, b: MysqlPrincipal) => a.user === b.user && a.host.toLowerCase() === b.host.toLowerCase()
const permissionDenied = (error: unknown) => [1044, 1142, 1143, 1227].includes(Number((error as { errno?: number })?.errno))

export async function readMysqlPrincipals(engine: MysqlPrincipalEngine, query: CatalogQuery, request: PrincipalRequest): Promise<PrincipalSnapshot> {
  const maria = engine === 'mariadb'
  const [[database, observer]] = await query('SELECT DATABASE(), CURRENT_USER()')
  const at = observer!.lastIndexOf('@')
  const own = identity(observer!.slice(0, at), observer!.slice(at + 1))
  const scope = { database: database ?? '', observer: observer! }
  const label = (account: MysqlPrincipal) => mysqlPrincipalSql(engine, account)
  const principal = (account: MysqlPrincipal, flag: string | null = null): PrincipalRole => ({
    id: key(account), name: label(account), account,
    description: flag === null ? 'Connected account' : maria ? yes(flag) ? 'Role' : 'User account' : yes(flag) ? 'Locked account or role' : 'Account'
  })
  const column = maria ? 'is_role' : 'account_locked'
  if (request.mode === 'roles') {
    try {
      const rows = await query(`SELECT User, Host, ${column} FROM mysql.user
        WHERE LOCATE(LOWER(?), LOWER(CONCAT(User, '@', Host))) > 0
        ORDER BY BINARY User, BINARY Host LIMIT ${limit}`, [request.search])
      return { ...scope, mode: 'roles', roles: bounded(rows.map(([user, host, flag]) => principal(identity(user, host), flag))) }
    } catch (error) {
      if (!permissionDenied(error)) throw error
      const matches = observer!.toLowerCase().includes(request.search.toLowerCase())
      return { ...scope, mode: 'roles', roles: bounded(matches ? [principal(own)] : []), notice: 'The account catalog is restricted. Only the connected account can be listed.' }
    }
  }

  const account = decodeMysqlPrincipalId(request.roleId)
  if (!account) throw new Error('Select an account or role from this server.')
  const values = [account.user, account.host]
  let selected: PrincipalRole
  let restricted = false
  try {
    const [row] = await query(`SELECT User, Host, ${column} FROM mysql.user WHERE BINARY User = BINARY ? AND LOWER(Host) = LOWER(?)`, values)
    if (!row) throw new Error('This account or role is no longer visible. Refresh the list and select it again.')
    selected = principal(identity(row[0], row[1]), row[2])
  } catch (error) {
    if (!permissionDenied(error)) throw error
    if (!equal(account, own)) throw new Error('This connection can inspect only its own account.')
    selected = principal(own); restricted = true
  }

  async function visible(sql: string, binds: (string | null)[] = []) {
    try { return await query(sql, binds) }
    catch (error) {
      if (!permissionDenied(error)) throw error
      restricted = true
      return []
    }
  }

  const isOwn = equal(account, own)
  const enabled = isOwn ? bounded((await query(`SELECT ROLE_NAME${maria ? '' : ', ROLE_HOST'} FROM information_schema.ENABLED_ROLES
    WHERE ROLE_NAME IS NOT NULL ORDER BY ROLE_NAME${maria ? '' : ', ROLE_HOST'} LIMIT ${limit}`)).map(row => label(identity(row[0], row[1])))) : null
  const direct: PrincipalMembership[] = (await visible(maria
    ? `SELECT Role, '', User, Host, Admin_option FROM mysql.roles_mapping
       WHERE (BINARY User = BINARY ? AND LOWER(Host) = LOWER(?)) OR (BINARY Role = BINARY ? AND ? = '')
       ORDER BY Role, User, Host LIMIT ${limit}`
    : `SELECT FROM_USER, FROM_HOST, TO_USER, TO_HOST, WITH_ADMIN_OPTION FROM mysql.role_edges
       WHERE (BINARY TO_USER = BINARY ? AND LOWER(TO_HOST) = LOWER(?)) OR (BINARY FROM_USER = BINARY ? AND LOWER(FROM_HOST) = LOWER(?))
       ORDER BY FROM_USER, FROM_HOST, TO_USER, TO_HOST LIMIT ${limit}`, [...values, ...values])
  ).map(row => ({ role: label(identity(row[0], row[1])), member: label(identity(row[2], row[3])), admin: yes(row[4]), grantor: null, inherit: null, set: null }))
  const ancestors = await visible(maria
    ? `WITH RECURSIVE granted(role_name) AS (
         SELECT Role FROM mysql.roles_mapping WHERE BINARY User = BINARY ? AND LOWER(Host) = LOWER(?)
         UNION DISTINCT SELECT m.Role FROM mysql.roles_mapping m JOIN granted g ON BINARY m.User = BINARY g.role_name WHERE m.Host = ''
       ) SELECT role_name, '' FROM granted ORDER BY BINARY role_name LIMIT ${limit}`
    : `WITH RECURSIVE granted(role_name, role_host) AS (
         SELECT FROM_USER, FROM_HOST FROM mysql.role_edges WHERE BINARY TO_USER = BINARY ? AND LOWER(TO_HOST) = LOWER(?)
         UNION DISTINCT SELECT m.FROM_USER, m.FROM_HOST FROM mysql.role_edges m JOIN granted g
           ON BINARY m.TO_USER = BINARY g.role_name AND LOWER(m.TO_HOST) = LOWER(g.role_host)
       ) SELECT role_name, role_host FROM granted ORDER BY BINARY role_name, BINARY role_host LIMIT ${limit}`, values)
  const applicable = isOwn && restricted ? await query(maria
    ? `SELECT ROLE_NAME, '', IS_GRANTABLE FROM information_schema.APPLICABLE_ROLES WHERE BINARY GRANTEE = BINARY CURRENT_USER()
       ORDER BY ROLE_NAME LIMIT ${limit}`
    : `SELECT ROLE_NAME, ROLE_HOST, IS_GRANTABLE FROM information_schema.APPLICABLE_ROLES
       WHERE BINARY GRANTEE = BINARY ? AND LOWER(GRANTEE_HOST) = LOWER(?) AND IS_MANDATORY = 'NO'
       ORDER BY ROLE_NAME, ROLE_HOST LIMIT ${limit}`, maria ? [] : values) : []
  if (!direct.length) for (const [user, host, grantable] of applicable) {
    direct.push({ role: label(identity(user, host)), member: selected.name, admin: yes(grantable), grantor: null, inherit: null, set: null })
  }
  const inherited = new Set([...ancestors, ...applicable].map(([user, host]) => label(identity(user, host))))
  for (const role of enabled?.rows ?? []) inherited.add(role)
  inherited.delete(selected.name)
  const memberships = bounded([...inherited].map(role => ({ role, usable: enabled?.rows.includes(role) ? true : null })))
  if (enabled?.truncated) memberships.truncated = true

  const grants: PrincipalCatalogGrant[] = []
  async function addStatic(table: 'mysql.user' | 'mysql.db', columns: Record<string, string>) {
    const byDatabase = table === 'mysql.db'
    const rows = await visible(`SELECT ${byDatabase ? 'Db' : 'NULL'}, Grant_priv, ${Object.keys(columns).join(', ')}
      FROM ${table} WHERE BINARY User = BINARY ? AND LOWER(Host) = LOWER(?) ${byDatabase ? 'ORDER BY BINARY Db' : ''} LIMIT ${limit}`, values)
    for (const [name, grant, ...flags] of rows) for (const [i, privilege] of Object.values(columns).entries()) {
      if (yes(flags[i])) grants.push({ scope: byDatabase ? `Database grant ${name}` : 'Global', privilege, grantable: yes(grant) })
    }
  }
  await addStatic('mysql.user', maria ? globalPrivileges : mysqlGlobalPrivileges)
  await addStatic('mysql.db', databasePrivileges)
  if (!maria) {
    for (const [name, grant] of await visible(`SELECT PRIV, WITH_GRANT_OPTION FROM mysql.global_grants WHERE BINARY USER = BINARY ? AND LOWER(HOST) = LOWER(?) ORDER BY PRIV LIMIT ${limit}`, values)) {
      grants.push({ scope: 'Global', privilege: name!, grantable: yes(grant) })
    }
  }

  let relationVisible: boolean | undefined
  if (request.relation) {
    const relation = request.relation
    relationVisible = !hiddenSchemas.includes(relation.schema.toLowerCase()) && (await query(`SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED') LIMIT 1`, [relation.schema, relation.name])).length > 0
    if (relationVisible) {
      const roles = ancestors.map(([user, host]) => identity(user, host)).filter(role => !equal(role, account))
      const conditions = Array.from({ length: roles.length + 1 }, () => '(BINARY User = BINARY ? AND LOWER(Host) = LOWER(?))')
      const rows = await visible(`SELECT User, Host, Table_priv FROM mysql.tables_priv
        WHERE BINARY Db = BINARY ? AND BINARY Table_name = BINARY ? AND (${conditions.join(' OR ')})
        ORDER BY BINARY User, BINARY Host LIMIT ${limit}`,
      [relation.schema, relation.name, ...values, ...roles.flatMap(role => [role.user, role.host])])
      const tableScope = `Table ${relation.schema}.${relation.name}`
      const tableGrants: PrincipalCatalogGrant[] = []
      for (const [user, host, raw] of rows) {
        const grantee = identity(user, host)
        const via = equal(account, grantee) ? undefined : label(grantee)
        const enabledHere = via && enabled?.rows.includes(via) ? true : undefined
        const listed = (raw ?? '').split(',').filter(Boolean).map(value => value.toUpperCase())
        for (const privilege of listed.filter(value => value !== 'GRANT')) {
          tableGrants.push({ scope: tableScope, privilege, grantable: listed.includes('GRANT'), via, enabled: enabledHere })
        }
      }
      grants.unshift(...tableGrants)
    }
  }

  // The server exposes own grants even without SELECT on its grant tables.
  // Skip the text-form grantee comparison for identities requiring quoting.
  if (restricted && isOwn && ![account.user, account.host].some(value => /['\\]/.test(value))) {
    const grantee = `'${account.user}'@'${account.host}'`
    const known = new Set(grants.filter(grant => !grant.via).map(grant => JSON.stringify([grant.scope, grant.privilege])))
    const fallback = (rows: (string | null)[][]) => {
      for (const [scope, privilege, grantable] of rows) {
        const key = JSON.stringify([scope, privilege])
        if (!known.has(key)) grants.push({ scope: scope!, privilege: privilege!, grantable: yes(grantable) })
        known.add(key)
      }
    }
    if (relationVisible && request.relation) fallback(await query(`SELECT CONCAT('Table ', TABLE_SCHEMA, '.', TABLE_NAME), PRIVILEGE_TYPE, IS_GRANTABLE
      FROM information_schema.TABLE_PRIVILEGES WHERE BINARY GRANTEE = BINARY ? AND BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ?
      ORDER BY PRIVILEGE_TYPE LIMIT ${limit}`, [grantee, request.relation.schema, request.relation.name]))
    fallback(await query(`SELECT 'Global', PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES
      WHERE BINARY GRANTEE = BINARY ? AND PRIVILEGE_TYPE <> 'USAGE' ORDER BY PRIVILEGE_TYPE LIMIT ${limit}`, [grantee]))
    fallback(await query(`SELECT CONCAT('Database grant ', TABLE_SCHEMA), PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES
      WHERE BINARY GRANTEE = BINARY ? ORDER BY TABLE_SCHEMA, PRIVILEGE_TYPE LIMIT ${limit}`, [grantee]))
  }

  return { ...scope, mode: 'role', role: selected, direct: bounded(direct), memberships, databasePrivileges: [],
    catalog: { grants: bounded(grants), enabled, relation: request.relation ? relationVisible ? request.relation : null : undefined }, notice: restricted ? 'Some grant catalogs are restricted by this connection’s permissions. Missing rows do not imply missing access.' : undefined }
}
