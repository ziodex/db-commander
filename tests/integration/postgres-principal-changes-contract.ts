import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import pg from 'pg'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig } from '../../src/shared/contracts'
import type { PreparePrincipalChange, PrincipalChangeReview } from '../../src/shared/principal-changes'
import { quoteIdentifier } from '../../src/shared/sql/common'

export async function verifyPostgresPrincipalChanges(config: ConnectionConfig) {
  const prefix = 'reviewed_' + randomUUID().slice(0, 8)
  const name = prefix + '_"team', member = prefix + '_member', renamed = prefix + '_renamed'
  const q = (value: string) => quoteIdentifier(value)
  const admin = new pg.Client({ host: config.host, port: config.port, user: config.user, password: config.password,
    database: config.database, ssl: { rejectUnauthorized: true, ca: config.ca } })
  const driver = new DriverRegistry(() => {}, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  await admin.connect()
  try {
    const session = await driver.connect(config)
    const other = await driver.connect(config)
    const locked = await driver.connect({ ...config, name: 'Principal review production', environment: 'production' })
    const prepare = (change: PreparePrincipalChange['change'], sessionId = session.id) =>
      Promise.resolve().then(() => driver.preparePrincipalChange({ sessionId, change }))
    const apply = (review: PrincipalChangeReview, sessionId = session.id, confirmation = review.confirmation) =>
      Promise.resolve().then(() => driver.applyPrincipalChange({ sessionId, reviewId: review.id, acknowledge: true, confirmation }))
    const readRole = async (role: string) => (await admin.query('SELECT oid::text, rolcanlogin FROM pg_roles WHERE rolname::text = $1', [role])).rows[0]
    const execute = async (sql: string) => {
      driver.start({ sessionId: session.id, sql, maxRows: 1 })
      await driver.wait(session.id)
    }

    const preview = await prepare({ action: 'create', name })
    expect(preview.sql).toBe(`CREATE ROLE ${q(name)} NOLOGIN;`)
    expect(await readRole(name)).toBeUndefined()
    await expect(apply(preview, other.id)).rejects.toThrow('connection that will apply')
    await expect(apply(preview, session.id, 'APPLY WRONG')).rejects.toThrow('confirmation did not match')
    await expect(apply(preview)).rejects.toThrow('connection that will apply')

    const protectedReview = await prepare({ action: 'create', name }, locked.id)
    await expect(apply(protectedReview, locked.id)).rejects.toThrow('protected connection is locked')
    driver.unlockSession(locked.id, 'Principal review production')
    expect(await apply(await prepare({ action: 'create', name }, locked.id), locked.id)).toMatchObject({ status: 'applied' })
    expect(await readRole(name)).toMatchObject({ rolcanlogin: false })
    const roleId = (await readRole(name)).oid
    const login = await prepare({ action: 'create-login', name: member })
    expect(login.sql).toContain('LOGIN PASSWORD NULL')
    expect(await apply(login)).toMatchObject({ status: 'applied' })
    expect(await readRole(member)).toMatchObject({ rolcanlogin: true })

    const enable = await prepare({ action: 'enable-login', roleId })
    await execute('BEGIN')
    await expect(apply(enable)).rejects.toThrow('settle the transaction')
    expect(await readRole(name)).toMatchObject({ rolcanlogin: false })
    await execute('ROLLBACK')
    expect(await apply(await prepare({ action: 'disable-login', roleId: (await readRole(member)).oid }))).toMatchObject({ status: 'applied' })

    const rename = await prepare({ action: 'rename', roleId, name: renamed })
    await admin.query(`ALTER ROLE ${q(name)} LOGIN`)
    await expect(apply(rename)).rejects.toThrow('changed')
    expect(await apply(await prepare({ action: 'rename', roleId, name: renamed }))).toMatchObject({ status: 'applied' })
    expect(await readRole(renamed)).toMatchObject({ oid: roleId })

    const grant = await prepare({ action: 'grant', roleId, member })
    expect(await apply(grant)).toMatchObject({ status: 'applied' })
    await expect(prepare({ action: 'drop', roleId })).rejects.toThrow('membership grants (1)')
    expect(await apply(await prepare({ action: 'revoke', roleId, member }))).toMatchObject({ status: 'applied' })

    const relation = { schema: prefix, name: 't' }, table = q(prefix) + '.t'
    await admin.query(`CREATE SCHEMA ${q(prefix)}; CREATE TABLE ${table} (id int); INSERT INTO ${table} VALUES (42)`)
    const maxLengthName = 'x'.repeat(63)
    await admin.query(`CREATE TABLE ${q(prefix)}.${q(maxLengthName)} (id int)`)
    await expect(prepare({
      action: 'grant-relation', roleId, relation: { schema: prefix, name: maxLengthName + 'z' }, privilege: 'SELECT'
    })).rejects.toThrow('relation is missing')
    const grantRelation = await prepare({ action: 'grant-relation', roleId, relation, privilege: 'SELECT' })
    await admin.query(`DROP TABLE ${table}; CREATE TABLE ${table} (id int); INSERT INTO ${table} VALUES (42)`)
    await expect(apply(grantRelation)).rejects.toThrow('changed')
    expect(await apply(await prepare({ action: 'grant-relation', roleId, relation, privilege: 'SELECT' }))).toMatchObject({ status: 'applied' })
    await expect(prepare({ action: 'drop', roleId })).rejects.toThrow('shared dependency records (1)')
    await admin.query(`GRANT USAGE ON SCHEMA ${q(prefix)} TO ${q(renamed)}; GRANT SELECT ON ${table} TO ${q(renamed)} WITH GRANT OPTION; SET ROLE ${q(renamed)}; GRANT SELECT ON ${table} TO ${q(member)}; RESET ROLE`)
    const restricted = await apply(await prepare({ action: 'revoke-relation', roleId, relation, privilege: 'SELECT' }))
    expect(restricted).toMatchObject({ status: 'rolled-back' })
    await admin.query(`SET ROLE ${q(renamed)}; REVOKE SELECT ON ${table} FROM ${q(member)}; RESET ROLE`)
    expect(await apply(await prepare({ action: 'revoke-relation', roleId, relation, privilege: 'SELECT' }))).toMatchObject({ status: 'applied' })

    await admin.query(`REVOKE USAGE ON SCHEMA ${q(prefix)} FROM ${q(renamed)}`)
    const staleDrop = await prepare({ action: 'drop', roleId })
    await admin.query(`GRANT ${q(renamed)} TO ${q(member)}`)
    await expect(apply(staleDrop)).rejects.toThrow('membership grants')
    expect(await readRole(renamed)).toMatchObject({ oid: roleId })
    await admin.query(`REVOKE ${q(renamed)} FROM ${q(member)}`)
    expect(await apply(await prepare({ action: 'drop', roleId }))).toMatchObject({ status: 'applied' })
    expect(await readRole(renamed)).toBeUndefined()
    expect((await admin.query(`SELECT id FROM ${table}`)).rows).toEqual([{ id: 42 }])
    expect(driver.getSession(session.id).transaction).toBe('idle')
  } finally {
    await driver.close()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${q(prefix)} CASCADE; DROP ROLE IF EXISTS ${[name, renamed, member].map(q).join(', ')}`) }
    finally { await admin.end() }
  }
}
