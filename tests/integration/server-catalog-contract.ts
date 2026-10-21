import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { SERVER_CATALOG_TABLES, SERVER_CATALOG_OVERFLOW, serverCatalogSeed, serverCatalogTable } from '../fixtures/server-catalog'

export async function verifyLargeServerCatalog(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) })
  const session = await driver.connect(config), prefix = 'scale_' + randomUUID().replaceAll('-', '').slice(0, 8) + '_'
  const q = (name: string) => quoteIdentifier(name, config.engine), table = (index: number) => serverCatalogTable(prefix, index)
  const timings: Record<string, number> = {}, counts: Record<string, number> = {}
  let created = 0, failed = false, completed = false
  async function run(sql: string) {
    events.length = 0
    const id = driver.start({ sessionId: session.id, sql, maxRows: 1 }); await driver.wait(session.id)
    const done = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(done?.status, done?.error).toBe('completed')
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  async function seed(end: number) {
    while (created < end) { const start = created; created = Math.min(end, start + 150); await run(serverCatalogSeed(config.engine, prefix, start, created)) }
  }
  try {
    let start = performance.now(); await seed(SERVER_CATALOG_TABLES)
    await run(`CREATE VIEW ${q(prefix+'view')} AS SELECT id FROM ${q(table(0))}`)
    if (['postgres','oracle'].includes(config.engine)) await run(`CREATE MATERIALIZED VIEW ${q(prefix+'materialized')} AS SELECT id FROM ${q(table(0))}`)
    timings.seed = performance.now() - start
    await run(`INSERT INTO ${q(table(0))}(id,label) VALUES (1,'committed')`)
    if (config.engine === 'oracle') await run('COMMIT')
    await run(`${config.engine === 'oracle' ? '' : config.engine === 'sqlserver' ? 'BEGIN TRANSACTION;' : 'BEGIN;'} UPDATE ${q(table(0))} SET label='uncommitted' WHERE id=1`)
    events.length = 0; start = performance.now(); const schema = await driver.schema(session.id); timings.refresh = performance.now() - start
    expect(schema.truncated).toBe(true); expect(schema.objects.flatMap(object => object.columns).length).toBeLessThanOrEqual(10000)
    expect(schema.catalog?.truncated).toBe(true); expect(schema.catalog?.objects).toHaveLength(2000)
    const parents = schema.catalog!.objects.filter(object => object.name.startsWith(prefix) && object.kind === 'table')
    counts.initialTables = parents.length; expect(parents).toHaveLength(SERVER_CATALOG_TABLES)
    const view = schema.catalog!.objects.find(object => object.name === prefix+'view' && object.kind === 'view')!
    expect(view).toBeDefined()
    const last = parents.find(object => object.name === table(SERVER_CATALOG_TABLES - 1))!
    expect(schema.objects.some(object => object.name === last.name)).toBe(false)
    start = performance.now(); const detail = await driver.inspectObject({ sessionId: session.id, object: last }); timings.inspect = performance.now() - start
    expect(detail.definition.sql).toContain(last.name); expect(detail.sections.find(section => section.title === 'Columns')!.rows).toHaveLength(8)
    expect((await driver.inspectObject({ sessionId: session.id, object: view })).definition.sql).toContain(view.name)
    if (['postgres','oracle'].includes(config.engine)) {
      const materialized = schema.catalog!.objects.find(object => object.name === prefix+'materialized' && object.kind === 'materialized view')!
      expect(materialized).toBeDefined()
      expect(schema.catalog!.objects.filter(object => object.name === materialized.name)).toHaveLength(1)
      start = performance.now(); const detail = await driver.inspectObject({ sessionId: session.id, object: materialized }); timings.materializedInspect = performance.now()-start
      expect(detail.definition.sql).toContain('CREATE MATERIALIZED VIEW')
      if (config.engine === 'oracle') {
        expect(detail.definition.source).toBe('generated'); expect(detail.definition.notice).toContain('not full native DDL')
        expect(schema.catalog!.objects.every(object => object.schema === 'SQLCOMMANDER')).toBe(true)
        await expect(driver.inspectObject({ sessionId: session.id, object: { ...last, schema: 'SQLCOMMANDER_COMPARE' } })).rejects.toThrow(/scope|catalog/i)
        expect(timings.materializedInspect).toBeLessThan(5000)
      }
    }
    if (config.engine === 'sqlserver') {
      // The Azure profile shares this local TDS server; no Azure service access.
      const azure = await driver.connect({ ...config, engine: 'azure-sql' })
      try {
        start = performance.now(); const catalog = await driver.schema(azure.id); timings.azureProfileRefresh = performance.now() - start
        expect(catalog.catalog?.objects.filter(object => object.name.startsWith(prefix) && object.kind === 'table')).toHaveLength(SERVER_CATALOG_TABLES)
        expect((await driver.inspectObject({ sessionId: azure.id, object: last })).definition.sql).toContain(last.name)
      } finally { await driver.disconnect(azure.id) }
    }
    expect(events).toEqual([]); expect(driver.getSession(session.id).transaction).toBe('transaction')
    expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`)).toEqual([['uncommitted']])
    await run('ROLLBACK'); expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`)).toEqual([['committed']])
    await seed(SERVER_CATALOG_OVERFLOW); start = performance.now(); const overflow = await driver.schema(session.id); timings.overflowRefresh = performance.now() - start
    expect(overflow.truncated).toBe(true); expect(overflow.catalog?.truncated).toBe(true); expect(overflow.catalog?.objects).toHaveLength(2000)
    expect(overflow.catalog!.objects.every(object => ['table','view','materialized view'].includes(object.kind))).toBe(true)
    counts.overflowTables = overflow.catalog!.objects.filter(object => object.name.startsWith(prefix) && object.kind === 'table').length
    expect(counts.overflowTables).toBeLessThan(SERVER_CATALOG_OVERFLOW)
    expect(overflow.catalog!.objects.some(object => object.name === table(0))).toBe(true)
    expect(overflow.catalog!.objects.some(object => object.name === table(SERVER_CATALOG_OVERFLOW - 1))).toBe(false)
    for (const name of ['refresh','overflowRefresh']) expect(timings[name], name).toBeLessThan(10000)
    expect(timings.inspect).toBeLessThan(5000); completed = true
  } catch (error) { failed = true; throw error }
  finally {
    try {
      if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK')
      await run(`DROP VIEW IF EXISTS ${q(prefix+'view')}`)
      if (['postgres','oracle'].includes(config.engine)) await run(`DROP MATERIALIZED VIEW IF EXISTS ${q(prefix+'materialized')}`)
      for (let start = 0; start < created; start += 150) await run(Array.from({ length: Math.min(150, created-start) }, (_, offset) => `DROP TABLE IF EXISTS ${q(table(start+offset))}${config.engine === 'oracle' ? ' PURGE' : ''};`).join('\n'))
    } catch (error) { if (!failed) throw error; console.error('Large-catalog fixture cleanup failed:', config.engine, prefix, String(error)) }
    finally {
      await driver.close()
      if (process.env.SQLCOMMANDER_CATALOG_EVIDENCE) {
        mkdirSync(process.env.SQLCOMMANDER_CATALOG_EVIDENCE, { recursive: true })
        writeFileSync(resolve(process.env.SQLCOMMANDER_CATALOG_EVIDENCE, `${config.engine}-server.json`), JSON.stringify({ engine: config.engine, version: session.version, node: process.versions.node, platform: `${process.platform}/${process.arch}`, completed, counts, timings }, null, 2))
      }
    }
  }
}
