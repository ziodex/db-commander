import type { CatalogQuery } from '../catalog/common'
import type { SqlServerPrincipalChange } from '../shared/principal-changes'
import { previewSqlServerPrincipalChange } from '../shared/principals'
import { quoteIdentifier } from '../shared/sql/common'
import type { PrincipalPlan } from './reviews'
import { sqlServerPrincipalCatalog } from './sqlserver'

const quote = (value: string) => quoteIdentifier(value, 'sqlserver')
const reserved = /^(sa|dbo|guest|public|sys|information_schema|sysadmin|##.*##)$/i
const changed = 'The reviewed principal or permission changed. Refresh its details and prepare a new review.'

type Identity = ReturnType<typeof principalIdentity>
function principalIdentity(row: (string | null)[]) {
  const [id, name, type, sid, created, fixed, own, disabled] = row
  return { id: id!, name: name!, type, sid, created, fixed: fixed === '1', own: own === '1', disabled: disabled === '1' }
}

function validateName(value: string) {
  if (!value.trim() || value.length > 128 || reserved.test(value)) throw new Error('Enter a non-reserved name between 1 and 128 characters.')
  return quote(value)
}

export async function sqlServerLoginIdentity(query: CatalogQuery, name: string) {
  const [[edition]] = await query("SELECT CONVERT(int, SERVERPROPERTY('EngineEdition'))")
  const [row] = await query(`SELECT p.name, CONVERT(varchar(172), p.sid, 1) FROM ${sqlServerPrincipalCatalog(true, edition === '5')} p
    WHERE p.type IN ('S', 'U', 'G', 'E', 'X') AND p.name = @p1`, [name])
  if (!row) throw new Error('The login is missing or outside the server catalog’s visible scope.')
  return { name: row[0]!, sid: row[1]! }
}

async function checkLoginMappings(query: CatalogQuery, identity: Identity) {
  const [[admin]] = await query("SELECT IS_SRVROLEMEMBER('sysadmin')")
  if (admin !== '1') throw new Error('Reviewed login removal requires sysadmin visibility across every database.')
  const databases = await query('SELECT TOP (51) name, state, CONVERT(varchar(172), owner_sid, 1) FROM sys.databases ORDER BY database_id')
  if (!databases.length || databases.length > 50 || databases.some(([, state]) => state !== '0')) {
    throw new Error('Login removal requires all databases to be online and within the 50-database dependency check.')
  }
  for (const [database, , owner] of databases) {
    if (owner === identity.sid) throw new Error('The login owns a database. Transfer ownership before removing it.')
    const [mapped] = await query(`SELECT TOP (1) 1 FROM ${quote(database!)}.sys.database_principals
      WHERE sid = CONVERT(varbinary(85), @p1, 1) AND principal_id > 4`, [identity.sid])
    if (mapped) throw new Error('A database user maps to this login. Resolve the mapping before removing it.')
  }
  if ((await query(`SELECT TOP (1) 1 FROM msdb.dbo.sysjobs WHERE owner_sid = CONVERT(varbinary(85), @p1, 1)
    UNION ALL SELECT TOP (1) 1 FROM sys.dm_exec_sessions WHERE security_id = CONVERT(varbinary(85), @p1, 1)
      OR original_security_id = CONVERT(varbinary(85), @p1, 1)`, [identity.sid])).length) {
    throw new Error('The login owns an Agent job or has an active session. Resolve those dependencies before removing it.')
  }
}

async function checkRemoval(query: CatalogQuery, identity: Identity, server: boolean, logical: boolean) {
  if (server && logical) throw new Error('Logical Azure SQL login removal requires a separate cross-database mapping review.')
  if (server) {
    const [[admin]] = await query("SELECT IS_SRVROLEMEMBER('sysadmin')")
    if (admin !== '1') throw new Error('Reviewed server principal removal requires full sysadmin catalog visibility.')
  } else {
    const [[control]] = await query("SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL')")
    if (control !== '1') throw new Error('Reviewed database principal removal requires CONTROL on this database to check dependencies.')
  }
  const scope = server ? 'server' : 'database'
  const connectionGrant = identity.type !== 'R' ? `AND NOT (class = ${server ? 100 : 0} AND major_id = 0
    AND permission_name = '${server ? 'CONNECT SQL' : 'CONNECT'}' AND state = 'G')` : ''
  const checks = [
    `SELECT 1 FROM sys.${scope}_role_members WHERE member_principal_id = @p1 OR role_principal_id = @p1`,
    `SELECT 1 FROM sys.${scope}_permissions WHERE grantor_principal_id = @p1 OR (grantee_principal_id = @p1 ${connectionGrant})`,
    `SELECT 1 FROM sys.${scope}_principals WHERE owning_principal_id = @p1`,
    ...(server ? ['SELECT 1 FROM sys.endpoints WHERE principal_id = @p1']
      : ['SELECT 1 FROM sys.schemas WHERE principal_id = @p1', 'SELECT 1 FROM sys.objects WHERE principal_id = @p1',
        'SELECT 1 FROM sys.types WHERE principal_id = @p1', 'SELECT 1 FROM sys.assemblies WHERE principal_id = @p1',
        'SELECT 1 FROM sys.certificates WHERE principal_id = @p1', 'SELECT 1 FROM sys.symmetric_keys WHERE principal_id = @p1',
        'SELECT 1 FROM sys.asymmetric_keys WHERE principal_id = @p1'])
  ]
  if ((await query(`SELECT TOP (1) 1 FROM (${checks.map(sql => sql.replace('SELECT 1', 'SELECT 1 AS found')).join(' UNION ALL ')}) dependencies`,
    [identity.id])).length) throw new Error('This principal has ownership, role membership or permission dependencies. Resolve them before removal.')
  if (server && identity.type !== 'R') await checkLoginMappings(query, identity)
}

export async function planSqlServerPrincipalChange(
  query: CatalogQuery, change: SqlServerPrincipalChange, login: (name: string) => ReturnType<typeof sqlServerLoginIdentity>
): Promise<PrincipalPlan & { verify(): Promise<void> }> {
  const server = change.scope === 'server'
  const [[database, observer, edition]] = await query(`SELECT DB_NAME(), ${server ? 'SUSER_SNAME()' : 'USER_NAME()'},
    CONVERT(int, SERVERPROPERTY('EngineEdition'))`)
  const logical = edition === '5', catalog = sqlServerPrincipalCatalog(server, logical)
  if (server && database !== 'master') throw new Error('Server principal changes require the master database.')
  const notes = [server ? 'This change applies to the server in master.' : 'This change applies only to the selected database.',
    'The app uses a separate transaction and SQL Server checks the connected account’s authority.']
  const plan = (sql: string, state: unknown, verify: () => Promise<void>, requiresPassword?: true) => ({
    database: database!, observer: observer!, sql, notes, verify, requiresPassword,
    fingerprint: JSON.stringify([change.engine, change.scope, database, observer, edition, state])
  })
  async function read(column: 'principal_id' | 'name', value: string) {
    const own = server ? 'p.sid = SUSER_SID()' : 'p.principal_id = USER_ID()'
    const [row] = await query(`SELECT p.principal_id, p.name, p.type, CONVERT(varchar(172), p.sid, 1),
      CONVERT(varchar(33), p.create_date, 126), p.is_fixed_role, CASE WHEN ${own} THEN 1 ELSE 0 END,
      ${server ? 'p.is_disabled' : 'NULL'} FROM ${catalog} p WHERE p.${column} = @p1`, [value])
    return row && principalIdentity(row)
  }
  function manageable(identity: Identity, asRole = false) {
    const fixedMembership = asRole && identity.type === 'R' && (identity.fixed || logical && /^##MS_.*##$/i.test(identity.name)) && !/^(public|sysadmin)$/i.test(identity.name)
    if (identity.own || server && (identity.id === '1' || /^(?:NT AUTHORITY|NT SERVICE)\\/i.test(identity.name)) || (!fixedMembership && (identity.fixed || reserved.test(identity.name)))) {
      throw new Error('The connected principal, built-in principals and fixed-role definitions are outside reviewed changes.')
    }
    if (identity.type === 'A' || identity.type === 'C' || identity.type === 'K') {
      throw new Error('Application, certificate and key principals are outside reviewed changes.')
    }
  }
  async function ensureAvailable(name: string) {
    const quoted = validateName(name)
    if (await read('name', name)) throw new Error('That principal name already exists.')
    return quoted
  }

  if (!('roleId' in change)) {
    const name = await ensureAvailable(change.name)
    const role = change.action === 'create', createLogin = change.action === 'create-login'
    if (server && role && (logical || change.engine === 'azure-sql')) throw new Error('Azure SQL uses predefined server roles.')
    if (!role && server !== createLogin) throw new Error('Choose the matching scope for a login or database user.')
    const mapped = change.action === 'create-mapped-user' ? await login(change.login) : undefined
    const kind = role ? server ? 'SERVER ROLE' : 'ROLE' : createLogin ? 'LOGIN' : 'USER'
    const clause = role ? '' : createLogin ? ' WITH PASSWORD = @newPassword'
      : mapped ? ` FOR LOGIN ${quote(mapped.name)}` : ' WITHOUT LOGIN'
    if (createLogin) {
      notes.push('Enter the password at apply time. The login starts enabled and receives the native connection permission.')
      if (logical) notes.push('Azure SQL login passwords must avoid single quotes and the login name.')
    }
    return plan(`CREATE ${kind} ${name}${clause};`, mapped, async () => {
      const current = await read('name', change.name)
      if (!current || (mapped ? current.sid !== mapped.sid : current.type !== (role ? 'R' : 'S'))) throw new Error(changed)
    }, createLogin ? true : undefined)
  }

  const target = await read('principal_id', change.roleId)
  if (!target) throw new Error('This principal is no longer visible. Refresh the list and select it again.')
  const membership = 'member' in change
  manageable(target, membership)
  const name = quote(target.name), kind = target.type === 'R' ? server ? 'SERVER ROLE' : 'ROLE' : server ? 'LOGIN' : 'USER'
  async function sameIdentity(identity = target!, expected = identity.name) {
    const current = await read('principal_id', identity.id)
    if (!current || current.name !== expected || current.sid !== identity.sid || current.created !== identity.created || current.type !== identity.type) {
      throw new Error(changed)
    }
    return current
  }
  if (change.action === 'rename') {
    if (server && logical && target.type !== 'S') throw new Error('Logical Azure SQL rename is available for SQL logins.')
    const next = await ensureAvailable(change.name)
    const sql = `ALTER ${kind} ${name} WITH NAME = ${next};`
    return plan(sql, target, async () => { await sameIdentity(target, change.name) })
  }
  if (change.action === 'drop') {
    await checkRemoval(query, target, server, logical)
    if (target.type !== 'R') notes.push(`Removal also clears any plain ${server ? 'CONNECT SQL' : 'CONNECT'} grant on this principal.`)
    notes.push('The review checks visible dependencies. The server can reject removal if it finds other owned securables or concurrent activity.')
    return plan(`DROP ${kind} ${name};`, target, async () => {
      if (await read('principal_id', target.id)) throw new Error(changed)
      if (server && target.type !== 'R') await checkLoginMappings(query, target)
    })
  }
  if (change.action === 'enable-login' || change.action === 'disable-login') {
    if (!server || !['S', 'U', 'G', 'E', 'X'].includes(target.type ?? '')) throw new Error('Select a login in Server scope.')
    const disabled = change.action === 'disable-login'
    if (target.disabled === disabled) throw new Error('This login already has the requested setting.')
    notes.push('Changing login availability does not end existing sessions or remove permissions.')
    return plan(`ALTER LOGIN ${name} ${disabled ? 'DISABLE' : 'ENABLE'};`, target, async () => {
      if ((await sameIdentity()).disabled !== disabled) throw new Error(changed)
    })
  }
  if ('member' in change) {
    if (target.type !== 'R') throw new Error('Select a role before changing its membership.')
    const member = await read('name', change.member)
    if (!member) throw new Error('The member is missing or outside this scope’s visible catalog.')
    manageable(member)
    if (member.id === target.id) throw new Error('Choose two different principals.')
    const exists = async () => (await query(`SELECT 1 FROM sys.${server ? 'server' : 'database'}_role_members
      WHERE role_principal_id = @p1 AND member_principal_id = @p2`, [target.id, member.id])).length > 0
    const grant = change.action === 'grant'
    if ((await exists()) === grant) throw new Error(grant ? 'This direct membership already exists.' : 'This direct membership was not found.')
    notes.push(target.fixed ? 'This fixed role has built-in permissions. Membership can grant access beyond the visible permission rows.'
      : 'Other role memberships or grants can still affect effective access.')
    return plan(previewSqlServerPrincipalChange(change.engine, change.scope, { action: change.action, role: target.name, member: member.name }),
      [target, member], async () => {
        await sameIdentity(); await sameIdentity(member)
        if ((await exists()) !== grant) throw new Error(changed)
      })
  }

  if (!('relation' in change) || server) throw new Error('Select a database principal and a visible relation for table permissions.')
  const object = async () => (await query(`SELECT o.object_id, s.name, o.name, CONVERT(varchar(33), o.create_date, 126), o.type
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V') AND s.name = @p1 AND o.name = @p2`,
    [change.relation.schema, change.relation.name]))[0]
  const relation = await object()
  if (!relation) throw new Error('The relation is missing or outside the catalog connection’s visible scope.')
  const grants = () => query(`SELECT TOP (2) state, grantor_principal_id FROM sys.database_permissions
    WHERE class = 1 AND major_id = @p1 AND minor_id = 0 AND grantee_principal_id = @p2 AND permission_name = @p3
    ORDER BY grantor_principal_id`, [relation[0], target.id, change.privilege])
  const current = await grants(), revoke = change.action === 'revoke-relation'
  if (revoke && (current.length !== 1 || current[0][0] === 'R')) throw new Error('Reviewed revocation requires one direct grant or denial.')
  if (!revoke && current.length) throw new Error('A direct permission entry already exists. Review it before changing this privilege.')
  const effect = change.action === 'deny-relation' ? 'DENY' : revoke ? 'REVOKE' : 'GRANT'
  const qualified = quote(relation[1]!) + '.' + quote(relation[2]!)
  const sql = `${effect} ${change.privilege} ON OBJECT::${qualified} ${revoke ? 'FROM' : 'TO'} ${name};`
  notes.push(revoke && current[0][0] === 'D' ? 'Removing a denial can restore access through another grant.'
    : 'This changes one direct table-level permission. Other grants, denials and role memberships can still affect access.')
  return plan(sql, [target, relation, current], async () => {
    await sameIdentity()
    if (JSON.stringify(await object()) !== JSON.stringify(relation)) throw new Error(changed)
    const actual = await grants()
    if (revoke ? actual.length !== 0 : actual.length !== 1 || actual[0][0] !== (effect === 'DENY' ? 'D' : 'G')) throw new Error(changed)
  })
}
