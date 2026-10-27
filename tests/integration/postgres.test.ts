import { verifyLargeServerCatalog } from './server-catalog-contract'
import { verifyCatalogPerformance } from './catalog-performance-contract'
import { verifyInsertExport } from './insert-export-contract'
import { verifyJsonImport } from './json-import-contract'
import { verifyArrayParameters } from './array-parameters-contract'
import { verifyTimezoneParameters } from './timezone-parameters-contract'
import { verifyTypedParameters } from './typed-parameters-contract'
import { verifySnippetExchange } from './snippet-contract'
import { verifyParameterExport } from './parameter-export-contract'
import { verifyExecution } from './execution-contract'
import { verifyRollbackInspection } from './rollback-contract'
import { verifyActivityControls } from './activity-control-contract'
import { verifyActivity } from './activity-contract'
import { verifyQueryBuilder } from './query-builder-contract'
import { verifyMigrations } from './migration-contract'
import { verifyDataComparison } from './data-compare-contract'
import { verifySchemaComparison } from './schema-compare-contract'
import { verifyDiagram } from './diagram-contract'
import { verifyParameters } from './parameters-contract'
import { verifyInspection } from './inspection-contract'
import { verifyExplain } from './explain-contract'
import { verifyConnectionSafeguards, verifySshLoss, verifySshAgent, verifySshPostgresBackup } from './connection-contract'
import { verifySchemaChanges } from './schema-change-contract'
import { verifyCatalog } from './catalog-contract'
import { verifyDataTransfer } from './transfer-contract'
import { verifyTableBrowsing } from './browsing-contract'
import { verifyBackups } from './backup-contract'
import { verifyDatabaseBrowsing } from './database-contract'
import { verifyEditableGrid } from './grid-contract'
import { verifyLanguageTools } from './language-contract'
import { verifySessionIsolation } from './session-isolation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { PostgresDriver } from '../../src/driver/postgres'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

if (!process.env.SQLCOMMANDER_PG_CA) throw new Error('Run integration tests using pnpm test:integration so PostgreSQL is managed by Docker.')
const config: ConnectionConfig = { engine: 'postgres', name: 'Docker PostgreSQL', host: 'localhost', port: Number(process.env.SQLCOMMANDER_PG_PORT), database: 'dbcommander', user: 'dbcommander', password: 'local-test-only', tls: 'verify-full', ca: readFileSync(process.env.SQLCOMMANDER_PG_CA, 'utf8') }
let driver: PostgresDriver
let session: SessionInfo
let events: DatabaseEvent[] = []
async function execute(sql: string, maxRows = 1000) {
  events = []
  const id = driver.start({ sessionId: session.id, sql, maxRows })
  await driver.wait(session.id)
  return { id, events: [...events], complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>, rows: events.flatMap(event => event.type === 'rows' ? event.rows : []) }
}
beforeAll(async () => { driver = new PostgresDriver(event => { events.push(event) }); session = await driver.connect(config) })
afterAll(async () => { await driver?.close() })

describe('Docker PostgreSQL driver contract', () => {
  it('browses accessible databases and safely replaces only the selected session', async () => { await verifyDatabaseBrowsing(config) })
  it('backs up and restores native schema/data with target protection, constraints and cancellation', async () => { await verifyBackups(config) }, 180000)
  it('isolates concurrent tab sessions, transaction state and cached exports', async () => { await verifySessionIsolation(config) })
  it('compares keyed bounded data with exact values and preserved sessions', async () => { await verifyDataComparison(config) }, 180000)
  it('compares same-engine schemas with reviewable target SQL and session isolation', async () => { await verifySchemaComparison(config) }, 180000)
  it('reads ER diagrams with ordered keys, catalog scope and session isolation', async () => { await verifyDiagram(config) }, 180000)
  it('executes current statements with source-aware failures and native preflight guards', async () => { await verifyExecution(config) }, 120000)
  it('imports and exports snippets without executing SQL or changing sessions', async () => { await verifySnippetExchange(config) }, 120000)
  it('exports bound parameters with exact values, isolation and cancellation', async () => { await verifyParameterExport(config) }, 120000)
  it('binds array parameters with exact elements, empty lists and safe operations', async () => { await verifyArrayParameters(config) }, 120000)
  it('binds timezone-aware timestamp parameters with exact instants and safe operations', async () => { await verifyTimezoneParameters(config) }, 120000)
  it('binds decimal date and timestamp parameters with exact values and safe operations', async () => { await verifyTypedParameters(config) }, 120000)
  it('binds query parameters with native types, isolation and preflight checks', async () => { await verifyParameters(config) }, 120000)
  it('inspects large values and follows composite foreign keys safely', async () => { await verifyInspection(config) }, 180000)
  it('captures engine-specific plans while preserving transactions and results', async () => { await verifyExplain(config) }, 180000)
  it('protects production sessions and verifies SSH transport where supported', async () => { await verifyConnectionSafeguards(config) }, 180000)
  it('reports SSH loss without replay and cleans up forwarded connections', async () => { await verifySshLoss(config) }, 60000)
  it('authenticates SSH through a private disposable agent', async () => { await verifySshAgent(config) }, 30000)
  it('backs up and restores PostgreSQL through SSH with native verified-TLS tools', async () => { await verifySshPostgresBackup(config) }, 120000)
  it('inspects rollback progress without changing or retargeting transactions', async () => { await verifyRollbackInspection(config) }, 180000)
  it('reviews cancellation and termination with identity revalidation', async () => { await verifyActivityControls(config) }, 180000)
  it('inspects sessions and real lock waits without changing query state', async () => { await verifyActivity(config) }, 180000)
  it('builds visual SELECT queries with native joins, grouping and parameters', async () => { await verifyQueryBuilder(config) }, 180000)
  it('exports reviewed migration files with native DDL semantics', async () => { await verifyMigrations(config) }, 180000)
  it('reviews and applies schema changes with native transaction handling', async () => { await verifySchemaChanges(config) }, 300000)
  it('explores rich catalog objects and definitions without changing session state', async () => { await verifyCatalog(config) }, 180000)
  it('keeps large server catalogs inspectable beyond child and column limits', async () => { await verifyLargeServerCatalog(config) }, 360000)
  if(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE==='1') it('catalog performance postgres: 10000 and 20000 constrained tables',()=>verifyCatalogPerformance(config),1200000)
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('verifies TLS and rejects an untrusted certificate', async () => {
    expect(session.tls).toBe(true)
    expect(session.version).toContain('PostgreSQL 17')
    await expect(driver.connect({ ...config, ca: '' })).rejects.toThrow()
  })
  it('retains the physical session and temporary tables across executions', async () => {
    expect((await execute('CREATE TEMP TABLE retained(value int); INSERT INTO retained VALUES(41)')).complete.status).toBe('completed')
    expect((await execute('SELECT value + 1 FROM retained')).rows).toEqual([['42']])
  })
  it('preserves exact types, NULL, empty strings, and duplicate column names', async () => {
    const result = await execute(`SELECT 9007199254740993::bigint AS duplicate, 1234567890123456.12345678::numeric AS duplicate, NULL::text, ''::text, '2026-10-12 12:34:56.123456'::timestamp`)
    expect(result.rows[0]).toEqual(['9007199254740993', '1234567890123456.12345678', null, '', '2026-10-12 12:34:56.123456'])
    const metadata = result.events.find(event => event.type === 'result') as Extract<DatabaseEvent, { type: 'result' }>
    expect(metadata.result.columns.slice(0, 2).map(column => column.name)).toEqual(['duplicate', 'duplicate'])
  })
  it('reports multiple results and handles dollar-quoted procedures', async () => {
    const result = await execute(`DO $body$ BEGIN RAISE NOTICE 'message;with separator'; END $body$; SELECT 1; SELECT 2;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['1'], ['2']])
    expect(result.events.some(event => event.type === 'notice' && event.message.includes('message;'))).toBe(true)
  })
  it('tracks transactions, aborted states, rollback, savepoints and commit', async () => {
    expect((await execute('BEGIN; UPDATE retained SET value=99')).complete.transaction).toBe('transaction')
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await execute('SELECT 1/0')).complete.transaction).toBe('failed')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['41']])
    expect((await execute('BEGIN; SAVEPOINT before_edit; UPDATE retained SET value=43; ROLLBACK TO before_edit; UPDATE retained SET value=42; COMMIT')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['42']])
  })
  it('bounds large results and explicitly reports truncation', async () => {
    const result = await execute('SELECT generate_series(1, 10000000) AS n', 275)
    expect(result.rows).toHaveLength(275)
    expect(result.complete.status).toBe('completed')
    expect(result.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true } })
    const next = await execute('SELECT 1')
    expect(next.complete.status, next.complete.error).toBe('completed')
  })
  it('cancels on a control connection and leaves the console reusable', async () => {
    events = []
    driver.start({ sessionId: session.id, sql: 'SELECT pg_sleep(30)', maxRows: 1 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 2', maxRows: 1 })).toThrow('running')
    expect((await driver.cancel(session.id)).requested).toBe(true)
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled' })
    expect((await execute('SELECT 5')).rows).toEqual([['5']])
  })
  it('loads metadata separately while a transaction is aborted', async () => {
    await execute('BEGIN; SELECT 1/0')
    const tables = await driver.tables(session.id)
    expect(tables.some(table => table.schema === 'public' && table.name === 'customers')).toBe(true)
    expect(driver.getSession(session.id).transaction).toBe('failed')
    await execute('ROLLBACK')
  })
  it('exports fetched results without re-executing SQL or changing precision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-csv-'))
    try {
      const result = await execute(`SELECT 'a,b' AS text, 9007199254740993::bigint AS id, NULL::text AS missing, '' AS empty`)
      const path = join(directory, 'result.csv')
      await driver.exportCsv(result.id, 0, path)
      expect(readFileSync(path, 'utf8')).toBe('"text","id","missing","empty"\r\n"a,b","9007199254740993",,""\r\n')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('rejects unsupported COPY before opening a protocol stream', async () => {
    expect(() => driver.start({ sessionId: session.id, sql: 'COPY customers TO STDOUT', maxRows: 1 })).toThrow('COPY')
    expect(() => driver.start({ sessionId: session.id, sql: '/* a /* b */ c */ COPY customers TO STDOUT', maxRows: 1 })).toThrow('COPY')
  })
  it('reports a lost connection as an unknown outcome without retrying', async () => {
    const victim = await driver.connect({ ...config, name: 'fault test' })
    const observer = new pg.Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, ssl: { rejectUnauthorized: true, ca: config.ca } })
    await observer.connect()
    try {
      events = []
      driver.start({ sessionId: victim.id, sql: 'SELECT pg_sleep(30) /* dbcommander_fault */', maxRows: 1 })
      await new Promise(resolve => setTimeout(resolve, 200))
      const done = driver.wait(victim.id)
      await observer.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='Db Commander' AND query LIKE '%dbcommander_fault%' AND state='active'")
      await done
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'unknown' })
      await expect(driver.disconnect(victim.id)).resolves.toBeUndefined()
    } finally { await observer.end() }
  })
})
