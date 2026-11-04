import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { AdministrationChange, AdministrationReview } from '../../src/shared/database-administration'

export async function verifyMysqlAdministration(config: ConnectionConfig) {
  const admin = { ...config, user: 'root', password: 'local-root-test-only' }
  const fixture = await openMysqlTransport(admin)
  const events: DatabaseEvent[] = []
  const registry = new DriverRegistry(event => { events.push(event) })
  const suffix = randomUUID().slice(0, 8), database = `a2_${suffix}`, table = `a2_stats_${suffix}`, reference = `a2_ref_${suffix}`
  const quote = (name: string) => '`' + name.replaceAll('`', '``') + '`'
  const exists = async (name: string) => (await fixture.bound('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY ?', [name])).rows.length === 1
  try {
    const session = await registry.connect({ ...admin, environment: 'production' })
    const limited = await registry.connect(config)
    const prepare = (change: AdministrationChange, sessionId = session.id) => registry.prepareAdministration({ sessionId, change })
    const apply = (review: AdministrationReview, sessionId = session.id) =>
      registry.applyAdministration({ sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true })
    const create = { action: 'create-database', database } as const
    const drop = { action: 'drop-database', database } as const
    async function execute(sql: string) {
      events.length = 0
      registry.start({ sessionId: session.id, sql, maxRows: 10 })
      await registry.wait(session.id)
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'completed' })
    }

    const locked = await prepare(create)
    expect(locked.sql).toBe(`CREATE DATABASE ${quote(database)};`)
    await expect(async () => apply(locked)).rejects.toThrow('protected connection is locked')
    expect(await exists(database)).toBe(false)
    registry.unlockSession(session.id, config.name)
    await expect(async () => prepare({ action: 'rename-database', database, destination: 'a2_other' })).rejects.toThrow('unavailable')
    await expect(async () => prepare({ ...create, database: 'mysql' })).rejects.toThrow('non-system')

    expect(await apply(await prepare(create, limited.id), limited.id)).toMatchObject({ status: 'rejected' })
    expect(await exists(database)).toBe(false)
    expect(await apply(await prepare(create))).toMatchObject({ status: 'applied' })
    expect(await exists(database)).toBe(true)
    await expect(async () => prepare(create)).rejects.toThrow('already exists')
    await expect(async () => prepare({ action: 'drop-database', database: config.database })).rejects.toThrow('different database')
    await fixture.query(`GRANT DROP ON ${quote(database)}.* TO 'dbcommander'@'%'`)
    await expect(async () => prepare(drop, limited.id)).rejects.toThrow('direct global')

    const occupied = await openMysqlTransport({ ...admin, database })
    try { await expect(async () => prepare(drop)).rejects.toThrow('Close sessions') }
    finally { await occupied.end() }

    const first = await prepare(drop)
    const target = `${quote(database)}.items`
    await fixture.query(`CREATE TABLE ${target}(id INT PRIMARY KEY) ENGINE=InnoDB`)
    await fixture.query(`INSERT INTO ${target} VALUES (7)`)
    await expect(async () => apply(first)).rejects.toThrow('reviewed database or table changed')
    expect(await exists(database)).toBe(true)

    const replaced = await prepare(drop)
    await fixture.query(`DROP TABLE ${target}`)
    await fixture.query(`CREATE TABLE ${target}(id INT PRIMARY KEY) ENGINE=InnoDB`)
    await expect(async () => apply(replaced)).rejects.toThrow('reviewed database or table changed')
    await fixture.query(`CREATE TABLE ${quote(reference)}(id INT, FOREIGN KEY(id) REFERENCES ${target}(id)) ENGINE=InnoDB`)
    await expect(async () => prepare(drop)).rejects.toThrow('foreign key')
    await fixture.query(`DROP TABLE ${quote(reference)}`)

    const review = await prepare(drop)
    expect(review.sql).toBe(`DROP DATABASE ${quote(database)};`)
    expect(review.notes.join(' ')).toContain('1 catalog objects')
    expect(await apply(review)).toMatchObject({ status: 'applied' })
    expect(await exists(database)).toBe(false)

    await execute('CREATE TEMPORARY TABLE a2_retained(value int); INSERT INTO a2_retained VALUES (42)')
    await fixture.query(`CREATE TABLE ${quote(table)}(id INT PRIMARY KEY, value VARCHAR(24), INDEX a2_idx(value)) ENGINE=InnoDB`)
    await fixture.query(`INSERT INTO ${quote(table)} VALUES (1, 'preserved')`)
    await execute('SET autocommit = 0')
    await expect(async () => prepare({ action: 'analyze-table', schema: config.database, table })).rejects.toThrow('enable autocommit')
    await execute('SET autocommit = 1')
    for (const [action, command] of [['analyze-table', 'ANALYZE TABLE'], ['optimize-table', 'OPTIMIZE TABLE'], ['check-table', 'CHECK TABLE']] as const) {
      const plan = await prepare({ action, schema: config.database, table })
      expect(plan.sql).toBe(`${command} ${quote(config.database)}.${quote(table)};`)
      expect(await apply(plan)).toMatchObject({ status: 'applied' })
      expect(await fixture.query(`SELECT value FROM ${quote(table)}`)).toEqual([['preserved']])
    }
    await execute('SELECT value FROM a2_retained')
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : [])).toEqual([['42']])
  } finally {
    try {
      await registry.close()
      await fixture.query(`DROP TABLE IF EXISTS ${quote(reference)}`)
      await fixture.query(`DROP TABLE IF EXISTS ${quote(table)}`)
      await fixture.query(`DROP DATABASE IF EXISTS ${quote(database)}`)
      await fixture.query(`REVOKE DROP ON ${quote(database)}.* FROM 'dbcommander'@'%'`).catch(() => {})
    } finally { await fixture.end().catch(() => fixture.destroy()) }
  }
}
