import { expect, test } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { attachedCatalogSeed, catalogSeed, catalogTable, LARGE_CATALOG_TABLES, OVERFLOW_CATALOG_TABLES } from '../fixtures/large-catalog'

for (const engine of ['sqlite', 'duckdb'] as const) test(`large catalog ${engine}: relation inspection survives child and column truncation`, async () => {
  const events: DatabaseEvent[] = [], timings: Record<string, number> = {}
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const config: ConnectionConfig = { engine, name: 'Private large catalog', host: 'local', port: 1, database: '', user: 'local', password: '', tls: 'disable', sqliteMode: 'memory', duckdbMode: 'memory' }
  const session = await driver.connect(config)
  async function run(sql: string) {
    events.length = 0
    const id = driver.start({ sessionId: session.id, sql, maxRows: 1 }); await driver.wait(session.id)
    const done = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(done?.status, done?.error).toBe('completed')
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  async function seed(start: number, end: number) {
    for (let index = start; index < end; index += 150) await run(catalogSeed(index, Math.min(end, index + 150)))
  }
  try {
    let start = performance.now(); await seed(0, LARGE_CATALOG_TABLES); await run(attachedCatalogSeed(engine)); timings.seed = performance.now() - start
    await run(`INSERT INTO "${catalogTable(0)}"(id,label) VALUES (1,'committed'); BEGIN; UPDATE "${catalogTable(0)}" SET label='uncommitted' WHERE id=1;`)
    events.length = 0; start = performance.now(); const schema = await driver.schema(session.id); timings.refresh = performance.now() - start
    expect(schema.truncated).toBe(true); expect(schema.objects.flatMap(object => object.columns).length).toBeLessThanOrEqual(10000)
    expect(schema.catalog?.truncated).toBe(true); expect(schema.catalog?.objects).toHaveLength(2000)
    const relations = schema.catalog!.objects.filter(object => ['table', 'view'].includes(object.kind))
    expect(relations.filter(object => object.name.startsWith('bulk_'))).toHaveLength(LARGE_CATALOG_TABLES)
    const last = relations.find(object => object.name === catalogTable(LARGE_CATALOG_TABLES - 1))!
    const attached = relations.find(object => object.name === 'attached_tail')!
    expect(last).toBeDefined(); expect(attached).toBeDefined()
    expect(relations.some(object => object.name === 'attached_view' && object.kind === 'view')).toBe(true)
    expect(schema.objects.some(object => object.name === last.name)).toBe(false)
    start = performance.now(); const detail = await driver.inspectObject({ sessionId: session.id, object: last }); timings.inspect = performance.now() - start
    expect(detail.definition.sql).toContain(catalogTable(LARGE_CATALOG_TABLES - 1)); expect(detail.sections.find(section => section.title === 'Columns')!.rows).toHaveLength(8)
    expect((await driver.inspectObject({ sessionId: session.id, object: attached })).definition.sql).toContain('attached_tail')
    expect(events).toEqual([]); expect(driver.getSession(session.id).transaction).toBe('transaction')
    const before = await run(`SELECT label FROM "${catalogTable(0)}" WHERE id=1`); expect(before).toEqual([['uncommitted']])
    await run('ROLLBACK'); expect(await run(`SELECT label FROM "${catalogTable(0)}" WHERE id=1`)).toEqual([['committed']])
    await seed(LARGE_CATALOG_TABLES, OVERFLOW_CATALOG_TABLES); start = performance.now(); const overflow = await driver.schema(session.id); timings.overflowRefresh = performance.now() - start
    expect(overflow.truncated).toBe(true); expect(overflow.catalog?.truncated).toBe(true); expect(overflow.catalog?.objects).toHaveLength(2000)
    expect(overflow.catalog!.objects.every(object => object.kind === 'table')).toBe(true)
    expect(overflow.catalog!.objects.some(object => object.name === catalogTable(1999))).toBe(true)
    expect(overflow.catalog!.objects.some(object => object.name === catalogTable(2000))).toBe(false)
    expect(timings.refresh).toBeLessThan(10000); expect(timings.inspect).toBeLessThan(5000); expect(timings.overflowRefresh).toBeLessThan(10000)
  } finally {
    await driver.close()
    if (process.env.SQLCOMMANDER_CATALOG_EVIDENCE) { mkdirSync(process.env.SQLCOMMANDER_CATALOG_EVIDENCE, { recursive: true }); writeFileSync(resolve(process.env.SQLCOMMANDER_CATALOG_EVIDENCE, `${engine}-driver.json`), JSON.stringify({ engine, timings }, null, 2)) }
  }
}, 120_000)
