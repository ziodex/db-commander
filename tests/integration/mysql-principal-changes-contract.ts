import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'
import type { MysqlAccountChange, PrincipalChangeReview } from '../../src/shared/principal-changes'
import { mysqlPrincipalSql, type MysqlPrincipal } from '../../src/shared/principals'

type ChangeFields<T> = T extends MysqlAccountChange ? Omit<T, 'engine'> : never

export async function verifyMysqlPrincipalChanges(config: ConnectionConfig) {
  const engine = config.engine === 'mariadb' ? 'mariadb' : 'mysql'
  const registry = new DriverRegistry(() => {})
  const adminConfig = { ...config, user: 'root', password: 'local-root-test-only' }
  const admin = await openMysqlTransport(adminConfig)
  const prefix = 'a1_' + randomUUID().slice(0, 8)
  const account = { user: prefix + '`@member', host: '%' }, renamed = { user: prefix + '_renamed', host: '%' }
  const role = { user: prefix + '_role', host: engine === 'mysql' ? '%' : '' }
  const secret = 'Local-Principal-Test-Only!'
  const relation = { schema: config.database, name: 'customers' }
  const view = `dbcommander.${prefix}_view`
  const sql = (value: MysqlPrincipal) => mysqlPrincipalSql(engine, value)
  const id = ({ user, host }: MysqlPrincipal) => JSON.stringify([user, host])
  const exists = async ({ user, host }: MysqlPrincipal) =>
    (await admin.bound('SELECT User FROM mysql.user WHERE BINARY User = BINARY ? AND Host = ?', [user, host])).rows.length > 0
  try {
    const session = await registry.connect(adminConfig)
    const other = await registry.connect({ ...adminConfig, environment: 'production', name: 'Principal review production' })
    const prepare = (change: ChangeFields<MysqlAccountChange>, sessionId = session.id) =>
      Promise.resolve().then(() => registry.preparePrincipalChange({ sessionId, change: { engine, ...change } }))
    const apply = (review: PrincipalChangeReview, sessionId = session.id, acknowledge = true) =>
      Promise.resolve().then(() => registry.applyPrincipalChange({
        sessionId, reviewId: review.id, acknowledge: true, confirmation: review.confirmation,
        ...(acknowledge ? { acknowledgeImplicitCommit: true as const } : {})
      }))
    const run = async (statement: string) => {
      registry.start({ sessionId: session.id, sql: statement, maxRows: 1 })
      await registry.wait(session.id)
    }

    const create = await prepare({ action: 'create-login', account })
    expect(create).toMatchObject({ implicitCommit: true, sql: `CREATE USER ${sql(account)} ACCOUNT LOCK;` })
    expect(await exists(account)).toBe(false)
    await expect(apply(create, other.id)).rejects.toThrow('connection that will apply')
    await expect(apply(create, session.id, false)).rejects.toThrow('automatic commit')
    await expect(apply(create)).rejects.toThrow('connection that will apply')

    const protectedReview = await prepare({ action: 'create-login', account }, other.id)
    await expect(apply(protectedReview, other.id)).rejects.toThrow('protected connection is locked')
    registry.unlockSession(other.id, 'Principal review production')
    expect(await apply(await prepare({ action: 'create-login', account }, other.id), other.id)).toMatchObject({ status: 'applied' })
    expect(await exists(account)).toBe(true)
    await admin.query(`ALTER USER ${sql(account)} IDENTIFIED BY '${secret}'`)
    const loginConfig = { ...config, database: '', user: account.user, password: secret }
    await expect(openMysqlTransport(loginConfig)).rejects.toThrow(/locked/i)

    const unlock = await prepare({ action: 'enable-login', roleId: id(account) })
    await run('START TRANSACTION')
    await expect(apply(unlock)).rejects.toThrow('settle the transaction')
    await run('ROLLBACK')
    expect(await apply(await prepare({ action: 'enable-login', roleId: id(account) }))).toMatchObject({ status: 'applied' })
    const connected = await openMysqlTransport(loginConfig)
    await connected.end()
    expect(await apply(await prepare({ action: 'disable-login', roleId: id(account) }))).toMatchObject({ status: 'applied' })
    await expect(openMysqlTransport(loginConfig)).rejects.toThrow(/locked/i)

    const rename = await prepare({ action: 'rename', roleId: id(account), account: renamed })
    await admin.query(`CREATE DEFINER=${sql(account)} VIEW ${view} AS SELECT 1 AS value`)
    await expect(apply(rename)).rejects.toThrow('definer')
    await expect(prepare({ action: 'drop', roleId: id(account) })).rejects.toThrow('definer')
    await admin.query(`DROP VIEW ${view}`)
    await admin.query(`CREATE DEFINER=${sql(renamed)} VIEW ${view} AS SELECT 1 AS value`)
    await expect(prepare({ action: 'create-login', account: renamed })).rejects.toThrow('definer')
    await expect(prepare({ action: 'rename', roleId: id(account), account: renamed })).rejects.toThrow('definer')
    await admin.query(`DROP VIEW ${view}`)
    const renameWithGrant = { action: 'rename' as const, roleId: id(account), account: renamed }
    await admin.query(`GRANT SELECT ON dbcommander.customers TO ${sql(account)}`)
    expect(await apply(await prepare(renameWithGrant))).toMatchObject({ status: 'applied' })
    expect(await exists(account)).toBe(false)
    expect(await exists(renamed)).toBe(true)
    await expect(prepare({ action: 'drop', roleId: id(renamed) })).rejects.toThrow('blocked by grants')
    expect(await apply(await prepare({ action: 'revoke-relation', roleId: id(renamed), relation, privilege: 'SELECT' }))).toMatchObject({ status: 'applied' })

    expect(await apply(await prepare({ action: 'create', account: role }))).toMatchObject({ status: 'applied' })
    if (engine === 'mariadb') {
      await expect(prepare({ action: 'rename', roleId: id(role), account: renamed })).rejects.toThrow('native role rename')
    }
    const grant = { action: 'grant' as const, roleId: id(role), member: renamed }
    expect(await apply(await prepare(grant))).toMatchObject({ status: 'applied' })
    await admin.query(engine === 'mysql' ? `SET DEFAULT ROLE ${sql(role)} TO ${sql(renamed)}` : `SET DEFAULT ROLE ${sql(role)} FOR ${sql(renamed)}`)
    await expect(prepare({ action: 'drop', roleId: id(role) })).rejects.toThrow('role memberships')
    const revoke = { ...grant, action: 'revoke' as const }
    expect(await apply(await prepare(revoke))).toMatchObject({ status: 'applied' })
    if (engine === 'mariadb') await expect(prepare({ action: 'drop', roleId: id(role) })).rejects.toThrow('default roles')
    await admin.query(engine === 'mysql' ? `SET DEFAULT ROLE NONE TO ${sql(renamed)}` : `SET DEFAULT ROLE NONE FOR ${sql(renamed)}`)

    const grantRelation = { action: 'grant-relation' as const, roleId: id(role), relation, privilege: 'SELECT' as const }
    const grantReview = await prepare(grantRelation)
    await admin.query(`GRANT SELECT ON dbcommander.customers TO ${sql(role)}`)
    await expect(apply(grantReview)).rejects.toThrow('direct privilege already exists')
    expect(await apply(await prepare({ ...grantRelation, action: 'revoke-relation' }))).toMatchObject({ status: 'applied' })

    const dropRole = await prepare({ action: 'drop', roleId: id(role) })
    if (engine === 'mariadb') expect(dropRole.notes.join(' ')).toContain('administrative membership')
    expect(await apply(dropRole)).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'drop', roleId: id(renamed) }))).toMatchObject({ status: 'applied' })
    expect(await exists(role)).toBe(false)
    expect(await exists(renamed)).toBe(false)
    expect(registry.getSession(session.id).transaction).toBe('idle')
  } finally {
    await registry.close()
    try {
      await admin.query(`DROP VIEW IF EXISTS ${view}`)
      await admin.query(`DROP USER IF EXISTS ${sql(account)}, ${sql(renamed)}`)
      await admin.query(`DROP ROLE IF EXISTS ${sql(role)}`)
    } finally { await admin.end() }
  }
}
