import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { AdministrationChange, AdministrationReview } from '../../src/shared/database-administration'

export async function verifyPostgresAdministration(config: ConnectionConfig) {
  const events: DatabaseEvent[] = []
  const registry = new DriverRegistry(event => { events.push(event) })
  const fixtureConfig = { host: config.host, port: config.port, user: config.user, password: config.password,
    database: config.database, ssl: { ca: config.ca } }
  const fixture = new pg.Client(fixtureConfig)
  const suffix = randomUUID().slice(0, 8)
  const database = `A2 "${suffix}"`, destination = `A2 renamed ${suffix}`, table = `a2_${suffix}`, index = `${table}_idx`
  const reader = `a2_reader_${suffix}`, readerPassword = 'local-admin-contract-only'
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  await fixture.connect()
  try {
    const session = await registry.connect({ ...config, environment: 'production' })
    const other = await registry.connect(config)
    const prepare = (change: AdministrationChange) => registry.prepareAdministration({ sessionId: session.id, change })
    const apply = (review: AdministrationReview, sessionId = session.id, confirmation = review.confirmation) =>
      registry.applyAdministration({ sessionId, reviewId: review.id, confirmation, acknowledge: true })
    const create = { action: 'create-database', database } as const
    const rename = { action: 'rename-database', database, destination } as const
    const drop = (target: string) => ({ action: 'drop-database', database: target } as const)
    const current = (name: string) => fixture.query('SELECT oid FROM pg_catalog.pg_database WHERE datname::text = $1', [name])
    async function execute(sql: string) {
      registry.start({ sessionId: session.id, sql, maxRows: 10 })
      await registry.wait(session.id)
    }

    const locked = await prepare(create)
    await expect(async () => apply(locked)).rejects.toThrow('protected connection is locked')
    expect((await current(database)).rowCount).toBe(0)
    registry.unlockSession(session.id, config.name)
    await expect(async () => prepare({ ...create, database: 'é'.repeat(32) })).rejects.toThrow('UTF-8 bytes')
    await expect(async () => prepare(drop(config.database))).rejects.toThrow('different database')
    await expect(async () => prepare(drop('postgres'))).rejects.toThrow('non-system')
    await execute('BEGIN')
    await expect(async () => prepare(create)).rejects.toThrow('settle the transaction')
    await execute('ROLLBACK')
    await execute('CREATE TEMP TABLE a2_retained(value int); INSERT INTO a2_retained VALUES (42)')

    const first = await prepare(create)
    expect(first.sql).toBe(`CREATE DATABASE ${quote(database)} TEMPLATE template0;`)
    await expect(async () => apply(first, other.id)).rejects.toThrow('connection that will apply it')
    await expect(async () => apply(first, session.id, 'wrong')).rejects.toThrow('confirmation did not match')
    await expect(async () => apply(first)).rejects.toThrow('connection that will apply it')
    expect((await current(database)).rowCount).toBe(0)
    expect(await apply(await prepare(create))).toMatchObject({ status: 'applied' })
    await expect(async () => prepare(create)).rejects.toThrow('already exists')

    const occupied = new pg.Client({ ...fixtureConfig, database })
    await occupied.connect()
    try {
      await expect(async () => prepare(rename)).rejects.toThrow('Close connections')
      await expect(async () => prepare(drop(database))).rejects.toThrow('Close connections')
    } finally { await occupied.end() }

    const stale = await prepare(drop(database))
    const old = (await current(database)).rows[0].oid
    await fixture.query(`DROP DATABASE ${quote(database)}`)
    await fixture.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0`)
    expect((await current(database)).rows[0].oid).not.toBe(old)
    await expect(async () => apply(stale)).rejects.toThrow('reviewed database or table changed')
    expect((await current(database)).rowCount).toBe(1)

    const renameReview = await prepare(rename)
    expect(renameReview.sql).toBe(`ALTER DATABASE ${quote(database)} RENAME TO ${quote(destination)};`)
    expect(await apply(renameReview)).toMatchObject({ status: 'applied' })
    expect((await current(database)).rowCount).toBe(0)
    expect((await current(destination)).rowCount).toBe(1)
    const dropReview = await prepare(drop(destination))
    expect(dropReview.sql).toBe(`DROP DATABASE ${quote(destination)};`)
    expect(await apply(dropReview)).toMatchObject({ status: 'applied' })
    expect((await current(destination)).rowCount).toBe(0)

    await fixture.query(`CREATE TABLE public.${table}(id int); INSERT INTO public.${table} SELECT generate_series(1, 128)`)
    await fixture.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${readerPassword}'; GRANT SELECT ON public.${table} TO ${reader}`)
    const restricted = await registry.connect({ ...config, user: reader, password: readerPassword })
    await expect(async () => registry.prepareAdministration({ sessionId: restricted.id, change: create })).rejects.toThrow('requires CREATEDB')
    await expect(async () => registry.prepareAdministration({
      sessionId: restricted.id, change: { action: 'analyze-table', schema: 'public', table }
    })).rejects.toThrow('lacks permission')
    await registry.disconnect(restricted.id)
    await expect(async () => prepare({ action: 'reindex-table', schema: 'public', table })).rejects.toThrow('no indexes')
    await fixture.query(`CREATE INDEX ${index} ON public.${table}(id)`)
    const before = await fixture.query('SELECT pg_relation_filenode($1::regclass) AS node', [`public.${index}`])
    const operations = [['analyze-table', 'ANALYZE'], ['vacuum-table', 'VACUUM'], ['reindex-table', 'REINDEX TABLE']] as const
    for (const [action, command] of operations) {
      const review = await prepare({ action, schema: 'public', table })
      expect(review.sql).toBe(`${command} "public"."${table}";`)
      expect(await apply(review)).toMatchObject({ status: 'applied' })
    }
    const after = await fixture.query('SELECT pg_relation_filenode($1::regclass) AS node', [`public.${index}`])
    expect(after.rows[0].node).not.toBe(before.rows[0].node)
    expect((await fixture.query('SELECT attname FROM pg_stats WHERE schemaname = $1 AND tablename = $2', ['public', table])).rows).toEqual([{ attname: 'id' }])
    events.length = 0
    await execute('SELECT value FROM a2_retained')
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : [])).toEqual([['42']])
    expect(registry.getSession(session.id)).toMatchObject({ transaction: 'idle', database: config.database })
  } finally {
    try {
      await registry.close()
      await fixture.query(`DROP TABLE IF EXISTS public.${table}`)
      await fixture.query(`DROP ROLE IF EXISTS ${reader}`)
      await fixture.query(`DROP DATABASE IF EXISTS ${quote(database)}`)
      await fixture.query(`DROP DATABASE IF EXISTS ${quote(destination)}`)
    } finally { await fixture.end() }
  }
}
