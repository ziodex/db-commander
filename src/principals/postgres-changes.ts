import type { CatalogQuery } from '../catalog/common'
import type { PostgresPrincipalChange } from '../shared/principal-changes'
import { previewPrincipalChange } from '../shared/principals'
import { quoteIdentifier } from '../shared/sql/common'
import { postgresPrincipalRelation } from './postgres'
import type { PrincipalPlan } from './reviews'

type Change = PostgresPrincipalChange
const roleColumns = 'oid, rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls'
const changed = 'The reviewed principal or grant changed. Refresh its details and prepare a new review.'

function manageable(row: (string | null)[] | undefined, observer: string) {
  if (!row) throw new Error('The principal no longer exists. Refresh the role list.')
  const [id, name, login, superuser] = row
  if (!name || name === observer || superuser === 'true' || /^pg_/i.test(name)) {
    throw new Error('The connected role, superusers and predefined PostgreSQL roles are outside reviewed changes.')
  }
  return { id: id!, name, login: login === 'true', row }
}

function newName(value: string, maxBytes: number) {
  if (!value.trim() || new TextEncoder().encode(value).length > maxBytes || /^pg_|^public$|^none$/i.test(value)) {
    throw new Error(`Enter a non-reserved role name of at most ${maxBytes} UTF-8 bytes.`)
  }
  return quoteIdentifier(value)
}

export async function planPostgresPrincipalChange(query: CatalogQuery, change: Change): Promise<PrincipalPlan & { verify(): Promise<void> }> {
  const [[database, observer, maxBytes]] = await query("SELECT current_database(), current_user, current_setting('max_identifier_length')")
  const notes = ['PostgreSQL roles are cluster-wide. The app uses a separate transaction on this connection and PostgreSQL checks the connected account’s authority.']
  const plan = (sql: string, state: unknown, verify: () => Promise<void>) =>
    ({ database: database!, observer: observer!, sql, notes, fingerprint: JSON.stringify([database, observer, state]), verify })
  const byName = async (name: string) => (await query(`SELECT ${roleColumns} FROM pg_roles WHERE rolname::text = $1`, [name]))[0]
  const byId = async (id: string) => (await query(`SELECT ${roleColumns} FROM pg_roles WHERE oid = $1::oid`, [id]))[0]

  if (!('roleId' in change)) {
    const name = newName(change.name, Number(maxBytes))
    if (await byName(change.name)) throw new Error('That PostgreSQL role already exists.')
    const login = change.action === 'create-login'
    if (login) notes.push('Creates a role with LOGIN and no password. Server authentication methods other than passwords can still permit a connection.')
    return plan(`CREATE ROLE ${name} ${login ? 'LOGIN PASSWORD NULL' : 'NOLOGIN'};`, null, async () => {
      if ((await byName(change.name))?.[2] !== String(login)) throw new Error(changed)
    })
  }

  const role = manageable(await byId(change.roleId), observer!)
  const identifier = quoteIdentifier(role.name)
  const checkIdentity = async (id = role.id, name = role.name) => {
    const current = await byId(id)
    if (current?.[1] !== name) throw new Error(changed)
    return current
  }
  if (change.action === 'rename') {
    const name = newName(change.name, Number(maxBytes))
    if (await byName(change.name)) throw new Error('That PostgreSQL role already exists.')
    if (role.login) notes.push('PostgreSQL clears an MD5-encrypted password when a login role is renamed. Verify how the account authenticates.')
    return plan(`ALTER ROLE ${identifier} RENAME TO ${name};`, role.row, async () => { await checkIdentity(role.id, change.name) })
  }
  if (change.action === 'drop') {
    if ((await byName(observer!))?.[3] !== 'true') {
      throw new Error('Reviewed removal requires a superuser to lock the PostgreSQL role catalogs during the dependency check.')
    }
    const [[dependencies, memberships]] = await query(`SELECT
      (SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = $1::oid),
      (SELECT count(*) FROM pg_auth_members WHERE roleid = $1::oid OR member = $1::oid OR grantor = $1::oid)`, [role.id])
    if (dependencies !== '0' || memberships !== '0') {
      throw new Error(`PostgreSQL role removal is blocked. Review shared dependency records (${dependencies}) and membership grants (${memberships}) before dropping the role.`)
    }
    notes.push('The cluster catalogs show no shared dependency records or membership grants for this role. PostgreSQL checks dependencies again when it executes DROP ROLE.')
    return plan(`DROP ROLE ${identifier};`, role.row, async () => { if (await byId(role.id)) throw new Error(changed) })
  }
  if (change.action === 'enable-login' || change.action === 'disable-login') {
    const login = change.action === 'enable-login'
    if (role.login === login) throw new Error('The role already has the requested login setting.')
    notes.push(login ? 'Enabling LOGIN uses existing server authentication rules. This does not set a password.'
      : 'Disabling LOGIN blocks new direct logins. Existing sessions and role memberships are unaffected.')
    return plan(`ALTER ROLE ${identifier} ${login ? 'LOGIN' : 'NOLOGIN'};`, role.row, async () => {
      if ((await checkIdentity())[2] !== String(login)) throw new Error(changed)
    })
  }
  if ('member' in change) {
    const member = manageable(await byName(change.member), observer!)
    const grants = () => query(`SELECT to_jsonb(m)::text FROM pg_auth_members m
      WHERE roleid = $1::oid AND member = $2::oid ORDER BY grantor LIMIT 2`, [role.id, member.id])
    const rows = await grants(), grant = change.action === 'grant'
    if (grant && rows.length) throw new Error('A direct membership grant already exists.')
    if (!grant && rows.length !== 1) throw new Error('Reviewed revocation requires exactly one direct membership grant.')
    notes.push(grant ? 'Membership can confer inherited privileges or allow SET ROLE under PostgreSQL’s default membership options.'
      : 'Revocation uses RESTRICT. Other membership paths can still confer access.')
    return plan(previewPrincipalChange({ action: change.action, role: role.name, member: member.name }), [role.row, member.row, rows], async () => {
      await checkIdentity()
      await checkIdentity(member.id, member.name)
      if ((await grants()).length !== Number(grant)) throw new Error('PostgreSQL did not produce the reviewed direct membership state.')
    })
  }

  if (!('relation' in change)) throw new Error('Unsupported PostgreSQL principal change.')
  const { relation, privilege } = change
  const readRelation = () => postgresPrincipalRelation(query, role.id, relation)
  const table = await readRelation()
  if (!table) throw new Error('The relation is missing or outside the catalog connection’s visible scope.')
  const grants = () => query(`SELECT a.grantor, a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid = $1::oid AND a.grantee = $2::oid AND a.privilege_type = $3
    ORDER BY a.grantor LIMIT 2`, [table[0], role.id, privilege])
  const rows = await grants(), grant = change.action === 'grant-relation'
  if (grant && rows.length) throw new Error('A direct grant for this privilege already exists.')
  if (!grant && rows.length !== 1) throw new Error('Reviewed revocation requires exactly one direct relation grant for this privilege.')
  notes.push(grant ? 'This grants a table-level privilege. Schema permissions, row policies and session context still affect access.'
    : 'Revocation uses RESTRICT. Ownership, PUBLIC and role memberships can still confer access.')
  return plan(previewPrincipalChange({ action: change.action, role: role.name, relation, privilege }), [role.row, table, rows], async () => {
    await checkIdentity()
    if ((await readRelation())?.[0] !== table[0] || (await grants()).length !== Number(grant)) {
      throw new Error('PostgreSQL did not produce the reviewed direct relation grant state.')
    }
  })
}
