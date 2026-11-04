import type { CatalogQuery } from '../catalog/common'
import type { MysqlAccountChange } from '../shared/principal-changes'
import { decodeMysqlPrincipalId, mysqlPrincipalSql, previewMysqlPrincipalChange, type MysqlPrincipal, type MysqlPrincipalEngine, type PrincipalRelation } from '../shared/principals'
import { quoteIdentifier } from '../shared/sql/common'
import type { PrincipalPlan } from './reviews'

const accountFilter = 'BINARY User = BINARY ? AND LOWER(Host) = LOWER(?)'
const values = ({ user, host }: MysqlPrincipal) => [user, host]
const equal = (left: MysqlPrincipal, right: MysqlPrincipal) => left.user === right.user && left.host.toLowerCase() === right.host.toLowerCase()

async function readAccount(query: CatalogQuery, engine: MysqlPrincipalEngine, account: MysqlPrincipal) {
  const columns = engine === 'mysql' ? "account_locked, 'N'" : `IF(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(g.Priv, '$.account_locked')), 'false') IN ('true','1'), 'Y', 'N'), u.is_role`
  const table = engine === 'mysql' ? 'mysql.user' : 'mysql.user u JOIN mysql.global_priv g USING (User, Host)'
  const [row] = await query(`SELECT User, Host, ${columns}, Super_priv FROM ${table} WHERE ${accountFilter}`, values(account))
  if (!row) return
  return { account: { user: row[0]!, host: row[1]! }, locked: row[2] === 'Y', role: row[3] === 'Y', privileged: row[4] === 'Y' }
}

async function relationIdentity(query: CatalogQuery, relation: PrincipalRelation) {
  if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(relation.schema.toLowerCase())) return
  return (await query(`SELECT TABLE_TYPE, ENGINE, CAST(CREATE_TIME AS CHAR) FROM information_schema.TABLES
    WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ?
      AND TABLE_TYPE IN ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED') LIMIT 1`, [relation.schema, relation.name]))[0]
}

async function checkDefiners(query: CatalogQuery, observer: MysqlPrincipal, engine: MysqlPrincipalEngine, account: MysqlPrincipal) {
  const [[visible]] = await query(`SELECT BINARY Select_priv = 'Y' AND BINARY Show_view_priv = 'Y' AND BINARY Trigger_priv = 'Y' AND BINARY Event_priv = 'Y'
    ${engine === 'mysql' ? 'AND @@GLOBAL.partial_revokes = 0' : ''} FROM mysql.user WHERE ${accountFilter}`, values(observer))
  if (visible !== '1') throw new Error('Reviewing this change requires unrestricted direct global SELECT, SHOW VIEW, TRIGGER and EVENT to check stored-object definers.')
  const prefix = account.user + '@'
  for (const table of ['VIEWS', 'ROUTINES', 'TRIGGERS', 'EVENTS']) {
    const rows = await query(`SELECT 1 FROM information_schema.${table} WHERE
      BINARY LEFT(DEFINER, CHAR_LENGTH(?)) = BINARY ? AND BINARY LOWER(SUBSTRING(DEFINER, CHAR_LENGTH(?) + 1)) = BINARY LOWER(?) LIMIT 1`,
    [prefix, prefix, prefix, account.host])
    if (rows.length) throw new Error('A stored object names this account as its definer. Resolve that dependency before changing the account identity.')
  }
}

async function mariaAdminMembership(query: CatalogQuery, role: MysqlPrincipal, member: MysqlPrincipal) {
  return (await query(`SELECT 1 FROM mysql.roles_mapping
    WHERE BINARY Role = BINARY ? AND ${accountFilter} AND BINARY Admin_option = 'Y' LIMIT 1`,
  [role.user, ...values(member)])).length > 0
}

async function checkAccountDependencies(
  query: CatalogQuery, engine: MysqlPrincipalEngine, account: MysqlPrincipal, dropping: boolean, observer: MysqlPrincipal
) {
  const binds = values(account)
  const mysql = engine === 'mysql'
  const ownAdmin = !mysql && dropping && !account.host && await mariaAdminMembership(query, account, observer)
  const mariaEdges = `mysql.roles_mapping WHERE ((${accountFilter}) OR (BINARY Role = BINARY ? AND ? = ''))
    ${ownAdmin ? `AND NOT ((${accountFilter}) AND BINARY Admin_option = 'Y')` : ''}`
  const tests: [string, string[]][] = [
    [mysql ? `mysql.role_edges WHERE (BINARY FROM_USER = BINARY ? AND LOWER(FROM_HOST) = LOWER(?))
      OR (BINARY TO_USER = BINARY ? AND LOWER(TO_HOST) = LOWER(?))` : mariaEdges,
    [...binds, ...binds, ...(ownAdmin ? values(observer) : [])]],
    [mysql ? `mysql.default_roles WHERE (${accountFilter}) OR (BINARY DEFAULT_ROLE_USER = BINARY ? AND LOWER(DEFAULT_ROLE_HOST) = LOWER(?))` :
      `mysql.user WHERE ((${accountFilter}) AND BINARY COALESCE(default_role, '') <> '') OR (BINARY default_role = BINARY ? AND ? = '')`, [...binds, ...binds]],
    [`mysql.proxies_priv WHERE (${accountFilter}) OR (BINARY Proxied_user = BINARY ? AND LOWER(Proxied_host) = LOWER(?))`, [...binds, ...binds]]
  ]
  if (dropping) {
    for (const table of ['db', 'tables_priv', 'columns_priv', 'procs_priv']) {
      tests.push([`mysql.${table} WHERE ${accountFilter}`, binds])
    }
    if (mysql) tests.push([`mysql.global_grants WHERE ${accountFilter}`, binds])
    // Discover only privilege flags so this stays accurate across grant-table
    // versions. Authentication fields never enter the query or review.
    const columns = (await query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user' AND RIGHT(LOWER(COLUMN_NAME), 5) = '_priv'
      ORDER BY COLUMN_NAME LIMIT 101`)).map(([name]) => name!)
    if (!columns.length || columns.length > 100 || columns.some(name => !/^[a-z_]+_priv$/i.test(name))) {
      throw new Error('The global grant catalog could not be verified for this account.')
    }
    const flags = columns.map(name => `BINARY ${quoteIdentifier(name, engine)} = 'Y'`).join(' OR ')
    tests.push([`mysql.user WHERE (${accountFilter}) AND (${flags})`, binds])
  }
  for (const [from, parameters] of tests) {
    if ((await query(`SELECT 1 FROM ${from} LIMIT 1`, parameters)).length) {
      throw new Error('Account change is blocked by grants, role memberships, default roles or proxy access. Resolve those dependencies first.')
    }
  }
  return ownAdmin
}

function newAccount(engine: MysqlPrincipalEngine, account: MysqlPrincipal, role: boolean) {
  const limit = engine === 'mysql' ? 32 : 128
  if (!account.user.trim() || Array.from(account.user).length > limit || /^(root$|mysql\.|mariadb\.)/i.test(account.user)) {
    throw new Error(`Enter a non-reserved name between 1 and ${limit} characters.`)
  }
  if (engine === 'mariadb' && role && /^(public|none)$/i.test(account.user)) throw new Error('Choose a non-reserved MariaDB role name.')
  if (engine === 'mariadb' && role ? Boolean(account.host) : !account.host.trim()) {
    throw new Error(engine === 'mariadb' && role ? 'MariaDB roles have no host.' : 'Enter the exact account host.')
  }
  return mysqlPrincipalSql(engine, account)
}

export async function planMysqlPrincipalChange(query: CatalogQuery, change: MysqlAccountChange): Promise<PrincipalPlan & { verify(): Promise<boolean> }> {
  const { engine } = change
  const [[database, observer]] = await query('SELECT DATABASE(), CURRENT_USER()')
  const observerName = observer!, separator = observerName.lastIndexOf('@')
  const own = { user: observerName.slice(0, separator), host: observerName.slice(separator + 1) }
  const scope = 'relation' in change ? 'This changes a privilege on the named relation.' : 'This is a server-wide account or role change.'
  const notes = [
    scope + ' The statement commits on a separate connection and cannot be rolled back here.',
    'Account and relation privileges use names. Changes made outside Db Commander can race the final catalog check.'
  ]
  const plan = (sql: string, state: unknown, verify: () => Promise<boolean>) => ({
    database: database ?? '', observer: observerName, sql, notes, implicitCommit: true as const,
    fingerprint: JSON.stringify([engine, database, observer, state]), verify
  })
  async function selected(account: MysqlPrincipal) {
    const result = await readAccount(query, engine, account)
    if (!result) throw new Error('This account or role is no longer visible. Refresh the principal list.')
    if (result.role && /^(public|none)$/i.test(account.user)) throw new Error('Predefined MariaDB roles are outside reviewed changes.')
    if (!account.user || equal(result.account, own) || result.privileged || /^(root$|mysql\.|mariadb\.)/i.test(account.user)) {
      throw new Error('The connected account, anonymous accounts and privileged or system accounts are outside reviewed changes.')
    }
    if (engine === 'mysql' && (await query(`SELECT 1 FROM mysql.global_grants WHERE ${accountFilter} AND PRIV = 'SYSTEM_USER' LIMIT 1`, values(account))).length) {
      throw new Error('Accounts with SYSTEM_USER are outside reviewed changes.')
    }
    return result
  }

  if (!('roleId' in change)) {
    const role = change.action === 'create', { account } = change
    const name = newAccount(engine, account, role)
    if (await readAccount(query, engine, account)) throw new Error('That account or role already exists.')
    await checkDefiners(query, own, engine, account)
    if (role && engine === 'mariadb') notes.push('MariaDB grants the connected account administrative membership in the new role.')
    if (!role) notes.push('The new account is locked and has no password. Set up authentication separately before unlocking it.')
    return plan(role ? previewMysqlPrincipalChange(engine, { action: 'create', role: account }) : `CREATE USER ${name} ACCOUNT LOCK;`, null, async () => {
      const current = await readAccount(query, engine, account)
      return Boolean(current && (engine === 'mariadb' && role ? current.role && await mariaAdminMembership(query, account, own) : current.locked))
    })
  }

  const account = decodeMysqlPrincipalId(change.roleId)
  if (!account) throw new Error('Select a visible MySQL or MariaDB account or role.')
  const target = await selected(account)
  const name = mysqlPrincipalSql(engine, target.account)

  if (change.action === 'rename' || change.action === 'drop') {
    const rename = change.action === 'rename'
    if (rename && target.role) throw new Error('MariaDB does not provide a native role rename.')
    await checkDefiners(query, own, engine, target.account)
    const ownAdmin = await checkAccountDependencies(query, engine, target.account, !rename, own)
    if (rename) {
      const destination = newAccount(engine, change.account, false)
      if (await readAccount(query, engine, change.account)) throw new Error('The destination account already exists.')
      await checkDefiners(query, own, engine, change.account)
      notes.push('Account rename moves its direct grants. Sessions already connected may retain their current identity.')
      return plan(`RENAME USER ${name} TO ${destination};`, target, async () => {
        const renamed = await readAccount(query, engine, change.account)
        return !(await readAccount(query, engine, target.account)) && renamed?.locked === target.locked && renamed.role === target.role
      })
    }
    if (ownAdmin) notes.push('Dropping this role also removes the connected account’s administrative membership.')
    notes.push('The review checks for other grant, default-role, proxy and stored-object definer dependencies. Existing sessions may retain access until they disconnect.')
    return plan(`DROP ${target.role ? 'ROLE' : 'USER'} ${name};`, [target, ownAdmin], async () => !(await readAccount(query, engine, target.account)))
  }

  if (change.action === 'enable-login' || change.action === 'disable-login') {
    if (target.role) throw new Error('MariaDB roles cannot log in. Inspect a user account.')
    const locked = change.action === 'disable-login'
    if (target.locked === locked) throw new Error('The account already has the requested login setting.')
    notes.push(locked ? 'Locking prevents new direct logins. It does not end active sessions or change definer privileges.'
      : 'Verify authentication has been configured before unlocking. An unlocked account follows existing server authentication rules, which can permit login without a password.')
    return plan(`ALTER USER ${name} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'};`, target, async () =>
      (await readAccount(query, engine, target.account))?.locked === locked)
  }

  if ('member' in change) {
    if (engine === 'mariadb' && !target.role) throw new Error('Inspect a MariaDB role before changing its membership.')
    const member = await selected(change.member)
    if (equal(target.account, member.account)) throw new Error('Choose two different principals.')
    const binds = [...values(target.account), ...values(member.account)]
    const edges = () => query(engine === 'mysql'
      ? `SELECT WITH_ADMIN_OPTION FROM mysql.role_edges WHERE BINARY FROM_USER = BINARY ? AND LOWER(FROM_HOST) = LOWER(?)
        AND BINARY TO_USER = BINARY ? AND LOWER(TO_HOST) = LOWER(?) LIMIT 1`
      : `SELECT Admin_option FROM mysql.roles_mapping WHERE BINARY Role = BINARY ? AND ? = '' AND ${accountFilter} LIMIT 1`, binds)
    const current = await edges(), grant = change.action === 'grant'
    if (Boolean(current.length) === grant) throw new Error(grant ? 'That direct membership already exists.' : 'No matching direct membership was found.')
    const defaultRole = engine === 'mysql'
      ? await query(`SELECT 1 FROM mysql.default_roles WHERE BINARY DEFAULT_ROLE_USER = BINARY ? AND LOWER(DEFAULT_ROLE_HOST) = LOWER(?)
        AND ${accountFilter} LIMIT 1`, binds)
      : await query(`SELECT 1 FROM mysql.user WHERE BINARY default_role = BINARY ? AND ? = '' AND ${accountFilter} LIMIT 1`, binds)
    notes.push(grant ? 'The role can confer privileges when it is enabled. This does not configure a default role.'
      : 'Other grants and active sessions can still confer access. Review the member’s default role separately.')
    return plan(previewMysqlPrincipalChange(engine, { action: change.action, role: target.account, member: member.account }),
      [target, member, current, defaultRole], async () => Boolean((await edges()).length) === grant)
  }

  if (!('relation' in change)) throw new Error('Unsupported MySQL principal change.')
  const { relation, privilege } = change
  const table = await relationIdentity(query, relation)
  if (!table) throw new Error('The relation is missing or outside the catalog connection’s visible scope.')
  const grants = () => query(`SELECT Table_priv FROM mysql.tables_priv WHERE ${accountFilter}
    AND BINARY Db = BINARY ? AND BINARY Table_name = BINARY ? LIMIT 1`, [...values(target.account), relation.schema, relation.name])
  const has = (rows: (string | null)[][]) => (rows[0]?.[0] ?? '').toUpperCase().split(',').includes(privilege)
  const current = await grants(), grant = change.action === 'grant-relation'
  if (has(current) === grant) throw new Error(grant ? 'That direct privilege already exists.' : 'No matching direct relation privilege was found.')
  notes.push('This changes a direct table-level privilege. Global, database, column and role grants may still affect access.')
  return plan(previewMysqlPrincipalChange(engine, { action: change.action, role: target.account, relation, privilege }),
    [target, table, current], async () => Boolean(await relationIdentity(query, relation)) && has(await grants()) === grant)
}
