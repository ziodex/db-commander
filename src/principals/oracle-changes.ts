import type { CatalogQuery } from '../catalog/common'
import type { OraclePrincipalChange } from '../shared/principal-changes'
import { decodeOraclePrincipalId, previewOraclePrincipalChange, quoteOraclePrincipal } from '../shared/principals'
import type { PrincipalPlan } from './reviews'

const reserved = /^(SYS|SYSTEM|PUBLIC|PDBADMIN|ORA\$.*|C##.*)$/i
const locked = (status: string | null) => Boolean(status?.includes('LOCKED'))

async function readPrincipal(query: CatalogQuery, name: string) {
  const [row] = await query(`SELECT USERNAME, 'user', TO_CHAR(USER_ID), TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS'),
    COMMON, ORACLE_MAINTAINED, INHERITED, AUTHENTICATION_TYPE, ACCOUNT_STATUS FROM DBA_USERS WHERE USERNAME = :1
    UNION ALL SELECT ROLE, 'role', TO_CHAR(ROLE_ID), NULL, COMMON, ORACLE_MAINTAINED, INHERITED,
    AUTHENTICATION_TYPE, NULL FROM DBA_ROLES WHERE ROLE = :2`, [name, name])
  if (!row) return
  const [actual, kind, id, created, common, maintained, inherited, auth, status] = row
  return { name: actual!, kind, id, created, common, maintained, inherited, auth, status }
}
type Identity = NonNullable<Awaited<ReturnType<typeof readPrincipal>>>

function eligible(principal: Identity, observer: string) {
  if (principal.name === observer || reserved.test(principal.name) ||
      principal.common !== 'NO' || principal.maintained !== 'N' || principal.inherited !== 'NO') {
    throw new Error('The connected principal, common principals and Oracle-maintained principals are outside reviewed changes.')
  }
  quoteOraclePrincipal(principal.name)
  return principal
}

async function administrativeMembership(query: CatalogQuery, name: string, observer: string) {
  return (await query(`SELECT 1 FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE = :1 AND GRANTEE = :2
    AND ADMIN_OPTION = 'YES' AND COMMON = 'NO' AND INHERITED = 'NO' FETCH FIRST 1 ROWS ONLY`, [name, observer])).length > 0
}

async function checkRemoval(query: CatalogQuery, target: Identity, observer: string) {
  const { name, kind } = target
  const admin = kind === 'role' && await administrativeMembership(query, name, observer)
  const grants = await query(`SELECT GRANTEE, OWNER, TABLE_NAME, GRANTOR, PRIVILEGE, GRANTABLE, TYPE, COMMON, INHERITED
    FROM DBA_TAB_PRIVS WHERE GRANTEE = :1 OR GRANTOR = :2 FETCH FIRST 2 ROWS ONLY`, [name, name])
  const defaultGrant = ['PUBLIC', 'SYS', name, name, 'INHERIT PRIVILEGES', 'NO', 'USER', 'NO', 'NO']
  const publicInheritance = kind === 'user' && grants.length === 1 && grants[0].every((value, index) => value === defaultGrant[index])
  if (grants.length && !publicInheritance) throw new Error('Removal is blocked by object grants. Resolve those dependencies first.')
  const checks: [string, string, string[]][] = [
    ['role memberships', `SELECT 1 FROM DBA_ROLE_PRIVS WHERE (GRANTEE = :1 OR GRANTED_ROLE = :2)
      ${admin ? "AND NOT (GRANTEE = :3 AND GRANTED_ROLE = :4 AND ADMIN_OPTION = 'YES' AND COMMON = 'NO' AND INHERITED = 'NO')" : ''}`,
    admin ? [name, name, observer, name] : [name, name]],
    ['system grants', 'SELECT 1 FROM DBA_SYS_PRIVS WHERE GRANTEE = :1', [name]],
    ['column grants', 'SELECT 1 FROM DBA_COL_PRIVS WHERE GRANTEE = :1 OR GRANTOR = :2', [name, name]],
    ['proxy access', 'SELECT 1 FROM DBA_PROXIES WHERE PROXY = :1 OR CLIENT = :2 OR ROLE = :3', [name, name, name]],
    ['roles granted to program units', 'SELECT 1 FROM DBA_CODE_ROLE_PRIVS WHERE ROLE = :1 OR OWNER = :2', [name, name]]
  ]
  if (kind === 'user') checks.push(
    ['owned schema objects', 'SELECT 1 FROM DBA_OBJECTS WHERE OWNER = :1', [name]],
    ['recycle-bin entries', 'SELECT 1 FROM DBA_RECYCLEBIN WHERE OWNER = :1', [name]],
    ['tablespace quotas', 'SELECT 1 FROM DBA_TS_QUOTAS WHERE USERNAME = :1', [name]],
    ['active sessions', "SELECT 1 FROM GV$SESSION WHERE USERNAME = :1 AND CON_ID = TO_NUMBER(SYS_CONTEXT('USERENV', 'CON_ID'))", [name]]
  )
  for (const [reason, sql, binds] of checks) {
    if ((await query(sql + ' FETCH FIRST 1 ROWS ONLY', binds)).length) {
      throw new Error(`Removal is blocked by ${reason}. Resolve those dependencies first.`)
    }
  }
  return { admin, publicInheritance }
}

export async function planOraclePrincipalChange(
  query: CatalogQuery, change: OraclePrincipalChange
): Promise<PrincipalPlan & { verify(): Promise<boolean> }> {
  const [[database, observer, containerId, databaseId]] = await query(`SELECT
    COALESCE(SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'DB_NAME')),
    SYS_CONTEXT('USERENV', 'SESSION_USER'), SYS_CONTEXT('USERENV', 'CON_ID'), SYS_CONTEXT('USERENV', 'DB_UNIQUE_NAME') FROM dual`)
  if (!database || !observer || !containerId || !databaseId || ['1', '2'].includes(containerId)) {
    throw new Error('Reviewed Oracle principal changes require a local container other than CDB root or seed.')
  }
  const notes = ['This change applies to the current Oracle container. It commits on a separate connection and cannot be rolled back here.',
    'Changes made outside Db Commander can race the final catalog check.']
  const plan = (sql: string, state: unknown, verify: () => Promise<boolean>, requiresPassword?: true) => ({
    database, observer, sql, notes, verify, requiresPassword, implicitCommit: true as const,
    fingerprint: JSON.stringify([database, databaseId, observer, containerId, state])
  })

  if (!('roleId' in change)) {
    const name = quoteOraclePrincipal(change.name), role = change.action === 'create', login = change.action === 'create-login'
    if (reserved.test(change.name)) throw new Error('Choose a non-reserved name for a local Oracle principal.')
    if (await readPrincipal(query, change.name)) throw new Error('That Oracle user or role already exists.')
    if (role) notes.push('Oracle grants the connected account administrative membership in the new role.')
    if (login) notes.push('The new user starts locked. Enter a password without double quotes or line breaks. Direct login also requires CREATE SESSION.')
    else if (!role) notes.push('This creates a schema-only user without direct authentication.')
    const statement = role ? previewOraclePrincipalChange({ action: 'create', name: change.name }).slice(0, -1)
      : `CREATE USER ${name} ${login ? 'IDENTIFIED BY :newPassword ACCOUNT LOCK' : 'NO AUTHENTICATION'}`
    const sql = statement + (containerId === '0' ? ';' : ' CONTAINER = CURRENT;')
    return plan(sql, null, async () => {
      const current = await readPrincipal(query, change.name)
      if (!current || current.kind !== (role ? 'role' : 'user') || current.common !== 'NO' || current.maintained !== 'N') return false
      if (role) return administrativeMembership(query, current.name, observer)
      return login ? current.auth === 'PASSWORD' && locked(current.status) : current.auth === 'NONE'
    }, login ? true : undefined)
  }

  const selected = decodeOraclePrincipalId(change.roleId)
  const current = selected && await readPrincipal(query, selected.name)
  if (!current || current.kind !== selected?.kind) throw new Error('This Oracle user or role is no longer visible. Refresh the principal list.')
  const target = eligible(current, observer), name = quoteOraclePrincipal(target.name)
  async function sameIdentity(identity = target) {
    const current = await readPrincipal(query, identity.name)
    return current && current.id === identity.id && current.kind === identity.kind && current.created === identity.created ? current : undefined
  }

  if (change.action === 'drop') {
    const dependencies = await checkRemoval(query, target, observer)
    if (dependencies.publicInheritance) notes.push('Dropping this user removes its default PUBLIC inheritance grant.')
    if (dependencies.admin) notes.push('Dropping this role also removes the connected account’s administrative membership.')
    notes.push(target.kind === 'user' ? 'This uses DROP USER without CASCADE. Schema objects and recycle-bin entries block removal.'
      : 'Existing sessions that enabled the role may retain its privileges until they disconnect.')
    return plan(`DROP ${target.kind === 'user' ? 'USER' : 'ROLE'} ${name};`, [target, dependencies],
      async () => !(await readPrincipal(query, target.name)))
  }

  if (change.action === 'enable-login' || change.action === 'disable-login') {
    if (target.kind !== 'user' || target.auth === 'NONE') throw new Error('Inspect an Oracle user with a login authentication method.')
    const lock = change.action === 'disable-login'
    if (locked(target.status) === lock) throw new Error('This user already has the requested lock state.')
    notes.push(lock ? 'Locking the account prevents new direct logins. Existing sessions are unaffected.'
      : 'Unlocking leaves authentication, expiration and CREATE SESSION requirements in place.')
    return plan(`ALTER USER ${name} ACCOUNT ${lock ? 'LOCK' : 'UNLOCK'};`, target, async () => {
      const account = await sameIdentity()
      return Boolean(account && locked(account.status) === lock)
    })
  }

  if (change.action === 'grant-session' || change.action === 'revoke-session') {
    const grants = () => query(`SELECT ADMIN_OPTION, COMMON, INHERITED FROM DBA_SYS_PRIVS
      WHERE GRANTEE = :1 AND PRIVILEGE = 'CREATE SESSION' FETCH FIRST 2 ROWS ONLY`, [target.name])
    const rows = await grants(), grant = change.action === 'grant-session'
    if (grant ? rows.length : rows.length !== 1 || rows[0][0] === 'YES' || rows[0][1] !== 'NO' || rows[0][2] !== 'NO') {
      throw new Error(grant ? 'This principal already has a direct CREATE SESSION grant.' : 'Reviewed revocation requires a local CREATE SESSION grant without the admin option.')
    }
    notes.push('This changes the direct CREATE SESSION grant. Account lock, authentication and other role grants are separate.')
    return plan(`${grant ? 'GRANT CREATE SESSION TO' : 'REVOKE CREATE SESSION FROM'} ${name};`, [target, rows],
      async () => Boolean(await sameIdentity()) && (await grants()).length === Number(grant))
  }

  if ('member' in change) {
    if (target.kind !== 'role') throw new Error('Inspect an Oracle role before changing its membership.')
    const found = await readPrincipal(query, change.member)
    if (!found) throw new Error('The member is missing or outside this container’s visible catalog.')
    const member = eligible(found, observer)
    if (target.name === member.name) throw new Error('Choose two different principals.')
    const edges = () => query(`SELECT ADMIN_OPTION, DELEGATE_OPTION, DEFAULT_ROLE, COMMON, INHERITED FROM DBA_ROLE_PRIVS
      WHERE GRANTED_ROLE = :1 AND GRANTEE = :2 FETCH FIRST 2 ROWS ONLY`, [target.name, member.name])
    const rows = await edges(), grant = change.action === 'grant'
    if (grant ? rows.length : rows.length !== 1 || rows[0][3] !== 'NO' || rows[0][4] !== 'NO') {
      throw new Error(grant ? 'That direct role membership already exists.' : 'Reviewed revocation requires one direct local role membership.')
    }
    notes.push(grant ? 'The role can confer access when enabled. Oracle controls the member’s default role state.'
      : 'Other memberships and roles already enabled in existing sessions can still confer access.')
    return plan(previewOraclePrincipalChange({ action: change.action, role: target.name, member: member.name }), [target, member, rows],
      async () => Boolean(await sameIdentity()) && Boolean(await sameIdentity(member)) && (await edges()).length === Number(grant))
  }

  if (!('relation' in change)) throw new Error('Unsupported Oracle principal change.')
  const { relation, privilege } = change
  const targetRelation = () => query(`SELECT OBJECT_ID, OBJECT_TYPE, TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS')
    FROM ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
    AND ORACLE_MAINTAINED = 'N' ORDER BY OBJECT_ID FETCH FIRST 3 ROWS ONLY`, [relation.schema, relation.name])
  const objects = await targetRelation()
  if (!objects.length) throw new Error('The relation is missing or outside the visible local catalog.')
  if (target.kind === 'user' && target.name === relation.schema) throw new Error('The relation owner already controls its privileges.')
  const grants = () => query(`SELECT GRANTOR, GRANTABLE, HIERARCHY, COMMON, INHERITED FROM DBA_TAB_PRIVS
    WHERE OWNER = :1 AND TABLE_NAME = :2 AND PRIVILEGE = :3 AND GRANTEE = :4 FETCH FIRST 2 ROWS ONLY`,
  [relation.schema, relation.name, privilege, target.name])
  const rows = await grants(), grant = change.action === 'grant-relation'
  if (grant && rows.length) throw new Error('A direct relation privilege already exists.')
  if (!grant) {
    if (rows.length !== 1 || rows[0].slice(1).some(flag => flag !== 'NO')) {
      throw new Error('Reviewed revocation requires one direct local table grant without grant or hierarchy options.')
    }
    const bindings = [target.name, relation.schema, relation.name]
    const [dependency] = await query(`SELECT 1 FROM (
      SELECT 1 FROM DBA_DEPENDENCIES WHERE OWNER = :1 AND REFERENCED_OWNER = :2 AND REFERENCED_NAME = :3
      UNION ALL SELECT 1 FROM DBA_COL_PRIVS WHERE GRANTEE = :4 AND OWNER = :5 AND TABLE_NAME = :6 AND PRIVILEGE = :7
    ) FETCH FIRST 1 ROWS ONLY`, [...bindings, ...bindings, privilege])
    if (dependency) throw new Error('Revocation is blocked by a dependent schema object or column grant.')
  }
  notes.push(grant ? 'This grants a table-level privilege. Role activation and row policies can still affect access.'
    : 'This removes one direct table-level privilege. Other grant paths can still confer access.')
  return plan(previewOraclePrincipalChange({ action: change.action, role: target.name, relation, privilege }), [target, objects, rows],
    async () => Boolean(await sameIdentity()) && JSON.stringify(await targetRelation()) === JSON.stringify(objects) &&
      (await grants()).length === Number(grant))
}
