import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import oracledb from 'oracledb'
import { DriverRegistry } from '../../src/driver/registry'
import { oracleConnectionOptions } from '../../src/driver/oracle'
import type { ConnectionConfig } from '../../src/shared/contracts'
import type { OraclePrincipalChange, PrincipalChangeReview } from '../../src/shared/principal-changes'

type ChangeFields<T> = T extends OraclePrincipalChange ? Omit<T, 'engine'> : never

export async function verifyOraclePrincipalChanges(config: ConnectionConfig) {
  const adminConfig = { ...config, user: 'system', password: 'Local-Admin-Only2026' }
  const admin = await oracledb.getConnection(oracleConnectionOptions(adminConfig))
  const driver = new DriverRegistry(() => {})
  const prefix = 'A1_' + randomUUID().slice(0, 8).toUpperCase()
  const role = prefix + '_ROLE', user = prefix + '_LOGIN', schema = prefix + '_SCHEMA', scratch = prefix + '_SCRATCH'
  const secret = "Local-Test-Only!'2026"
  const relation = { schema: 'DBCOMMANDER', name: 'CUSTOMERS' }
  const id = (name: string, kind: 'user' | 'role') => JSON.stringify(['oracle', name, kind])
  const execute = async (sql: string) => { await admin.execute(sql) }
  const read = async (sql: string, values: string[]) =>
    (await admin.execute(sql, values, { outFormat: oracledb.OUT_FORMAT_ARRAY })).rows
  const status = (name: string) => read('SELECT AUTHENTICATION_TYPE, ACCOUNT_STATUS FROM DBA_USERS WHERE USERNAME = :1', [name])
  try {
    await execute(`CREATE TABLE "${scratch}" (id NUMBER)`)
    const session = await driver.connect(adminConfig)
    const prepare = (change: ChangeFields<OraclePrincipalChange>) =>
      Promise.resolve().then(() => driver.preparePrincipalChange({ sessionId: session.id, change: { engine: 'oracle', ...change } }))
    const apply = (review: PrincipalChangeReview, newPassword?: string, acknowledge = true) =>
      Promise.resolve().then(() => driver.applyPrincipalChange({
        sessionId: session.id, reviewId: review.id, acknowledge: true, confirmation: review.confirmation, newPassword,
        ...(acknowledge ? { acknowledgeImplicitCommit: true as const } : {})
      }))
    const run = async (sql: string) => {
      driver.start({ sessionId: session.id, sql, maxRows: 1 })
      await driver.wait(session.id)
    }

    const draft = await prepare({ action: 'create-login', name: user })
    expect(draft).toMatchObject({ database: config.database, requiresPassword: true, implicitCommit: true,
      sql: `CREATE USER "${user}" IDENTIFIED BY :newPassword ACCOUNT LOCK CONTAINER = CURRENT;` })
    expect(draft.sql).not.toContain(secret)
    expect(await status(user)).toEqual([])
    await expect(apply(draft, secret, false)).rejects.toThrow('automatic commit')
    const active = await prepare({ action: 'create-login', name: user })
    await run(`INSERT INTO "${scratch}" VALUES (42)`)
    await expect(apply(active, secret)).rejects.toThrow('settle the transaction')
    await run('ROLLBACK')
    expect(await read(`SELECT id FROM "${scratch}"`, [])).toEqual([])

    expect(await apply(await prepare({ action: 'create-login', name: user }), secret)).toMatchObject({ status: 'applied' })
    expect(await status(user)).toEqual([['PASSWORD', 'LOCKED']])
    const userId = id(user, 'user'), roleId = id(role, 'role')
    expect(await apply(await prepare({ action: 'grant-session', roleId: userId }))).toMatchObject({ status: 'applied' })
    const loginConfig = { ...config, user, password: secret }
    await expect(oracledb.getConnection(oracleConnectionOptions(loginConfig))).rejects.toThrow(/locked/i)
    expect(await apply(await prepare({ action: 'enable-login', roleId: userId }))).toMatchObject({ status: 'applied' })
    const login = await oracledb.getConnection(oracleConnectionOptions(loginConfig))
    await login.close()
    expect(await apply(await prepare({ action: 'disable-login', roleId: userId }))).toMatchObject({ status: 'applied' })

    expect(await apply(await prepare({ action: 'create-user', name: schema }))).toMatchObject({ status: 'applied' })
    expect(await status(schema)).toMatchObject([['NONE', expect.any(String)]])
    expect(await apply(await prepare({ action: 'create', name: role }))).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'grant', roleId, member: user }))).toMatchObject({ status: 'applied' })
    await expect(prepare({ action: 'drop', roleId })).rejects.toThrow('dependencies')
    expect(await apply(await prepare({ action: 'revoke', roleId, member: user }))).toMatchObject({ status: 'applied' })

    const grant = { action: 'grant-relation' as const, roleId: userId, relation, privilege: 'SELECT' as const }
    const revoke = { ...grant, action: 'revoke-relation' as const }
    const stale = await prepare(grant)
    await execute(`GRANT SELECT ON DBCOMMANDER.CUSTOMERS TO "${user}" WITH GRANT OPTION`)
    await expect(apply(stale)).rejects.toThrow('already exists')
    await expect(prepare(revoke)).rejects.toThrow('without grant or hierarchy options')
    await execute(`REVOKE SELECT ON DBCOMMANDER.CUSTOMERS FROM "${user}"`)
    expect(await apply(await prepare(grant))).toMatchObject({ status: 'applied' })
    await execute(`CREATE VIEW "${user}".DEPENDENT_VIEW AS SELECT * FROM DBCOMMANDER.CUSTOMERS`)
    await expect(prepare(revoke)).rejects.toThrow('dependent schema object')
    await execute(`DROP VIEW "${user}".DEPENDENT_VIEW`)
    expect(await apply(await prepare(revoke))).toMatchObject({ status: 'applied' })

    await expect(prepare({ action: 'drop', roleId: userId })).rejects.toThrow('dependencies')
    expect(await apply(await prepare({ action: 'revoke-session', roleId: userId }))).toMatchObject({ status: 'applied' })
    await expect(prepare({ action: 'drop', roleId: id('SYSTEM', 'user') })).rejects.toThrow('Oracle-maintained')
    const userDrop = await prepare({ action: 'drop', roleId: userId })
    expect(userDrop.notes.join(' ')).toContain('default PUBLIC inheritance grant')
    expect(await apply(userDrop)).toMatchObject({ status: 'applied' })
    const roleDrop = await prepare({ action: 'drop', roleId })
    expect(roleDrop.notes.join(' ')).toContain('administrative membership')
    expect(await apply(roleDrop)).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'drop', roleId: id(schema, 'user') }))).toMatchObject({ status: 'applied' })
    expect(driver.getSession(session.id).transaction).toBe('idle')
  } finally {
    await driver.close()
    try {
      for (const sql of [`DROP VIEW "${user}".DEPENDENT_VIEW`, `DROP USER "${user}"`, `DROP USER "${schema}"`,
        `DROP ROLE "${role}"`, `DROP TABLE "${scratch}" PURGE`]) {
        try { await execute(sql) }
        catch (error) { if (![942, 1918, 1919].includes(Number((error as { errorNum?: number }).errorNum))) throw error }
      }
    } finally { await admin.close() }
  }
}
