import { verifyTransferWorkflows } from './transfer-workflows-contract'
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
import { verifyConnectionSafeguards } from './connection-contract'
import { verifySchemaChanges } from './schema-change-contract'
import { verifyCatalog } from './catalog-contract'
import { verifyObjectSource, verifyRoutineSource, verifyTriggerSource, verifyProcedureCall } from './object-source-contract'
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
import { DriverRegistry } from '../../src/driver/registry'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

const engines = (['mysql', 'mariadb'] as const).filter(engine => (process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine))
if (!engines.length) throw new Error('Run using pnpm test:integration [--driver mysql|mariadb] to manage the Docker fixtures.')
for (const engine of engines) describe(`Docker ${engine} driver contracts`, () => {
  const prefix = `SQLCOMMANDER_${engine.toUpperCase()}`
  const config: ConnectionConfig = { engine, name: `Docker ${engine}`, host: 'localhost', port: Number(process.env[`${prefix}_PORT`]), database: 'dbcommander', user: 'dbcommander', password: 'local-test-only', tls: 'verify-full', ca: readFileSync(process.env[`${prefix}_CA`]!, 'utf8') }
  let driver: DriverRegistry, session: SessionInfo, events: DatabaseEvent[] = []
  async function execute(sql: string, maxRows = 1000) {
    events = []
    const id = driver.start({ sessionId: session.id, sql, maxRows })
    await driver.wait(session.id)
    return { id, events: [...events], complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>, rows: events.flatMap(event => event.type === 'rows' ? event.rows : []) }
  }
  beforeAll(async () => { driver = new DriverRegistry(event => { events.push(event) }); session = await driver.connect(config) })
  afterAll(async () => { await driver?.close() })

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
  it('inspects rollback progress without changing or retargeting transactions', async () => { await verifyRollbackInspection(config) }, 180000)
  it('reviews cancellation and termination with identity revalidation', async () => { await verifyActivityControls(config) }, 180000)
  it('inspects sessions and real lock waits without changing query state', async () => { await verifyActivity(config) }, 180000)
  it('builds visual SELECT queries with native joins, grouping and parameters', async () => { await verifyQueryBuilder(config) }, 180000)
  it('exports reviewed migration files with native DDL semantics', async () => { await verifyMigrations(config) }, 180000)
  it('reviews and applies schema changes with native transaction handling', async () => { await verifySchemaChanges(config) }, 300000)
  it('explores rich catalog objects and definitions without changing session state', async () => { await verifyCatalog(config) }, 180000)
  it('reviews source edits and refuses stale definitions', async () => { await verifyObjectSource(config) }, 180000)
  it('reviews and applies a trigger source edit', async () => { await verifyTriggerSource(config) }, 180000)
  it('reviews and applies a routine source edit', async () => { await verifyRoutineSource(config) }, 180000)
  it('calls a procedure with discovered bound parameters', async () => { await verifyProcedureCall(config) }, 180000)
  it('keeps large server catalogs inspectable beyond child and column limits', async () => { await verifyLargeServerCatalog(config) }, 360000)
  if(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE==='1') it(`catalog performance ${engine}: 10000 and 20000 constrained tables`,()=>verifyCatalogPerformance(config),1200000)
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  it('reviews new-table imports, JSON Lines and captured database copies without replay', async () => { await verifyTransferWorkflows(config) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('routes the selected engine and verifies TLS, CA and host identity', async () => {
    expect(session.engine).toBe(engine)
    expect(session.version).toMatch(engine === 'mysql' ? /^8\.4\./ : /^11\.4\..*MariaDB/)
    expect(session.tls).toBe(true)
    await expect(driver.connect({ ...config, ca: '' })).rejects.toThrow()
    // Certificate deliberately only contains DNS:localhost, not the IP address.
    await expect(driver.connect({ ...config, host: '127.0.0.1' })).rejects.toThrow()
    await expect(driver.connect({ ...config, password: 'wrong-password' })).rejects.toThrow()
    const local = await driver.connect({ ...config, tls: 'disable' })
    expect(local.tls).toBe(false); await driver.disconnect(local.id)
  })
  it('retains physical sessions and temporary tables across executions', async () => {
    expect((await execute('CREATE TEMPORARY TABLE retained(value INT) ENGINE=InnoDB; INSERT INTO retained VALUES(41)')).complete.status).toBe('completed')
    expect((await execute('SELECT value+1 FROM retained')).rows).toEqual([['42']])
  })
  it('preserves unsigned bigint, decimal, dates, JSON, binary, Unicode, NULL and duplicate aliases', async () => {
    const result = await execute("SELECT wide_int AS duplicate, precise AS duplicate, moment, document, payload, label, missing, '' FROM data_types WHERE id=1")
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows[0].slice(0, 3)).toEqual(['18446744073709551615', '1234567890123456.12345678', '2026-10-12 12:34:56.123456'])
    expect(result.rows[0][3]).toContain('9007199254740993')
    expect(result.rows[0].slice(4)).toEqual(['0x00ff802c', 'Hej 世界 👋', null, ''])
    expect(result.events.find(event => event.type === 'result')).toMatchObject({ result: { columns: [{ name: 'duplicate' }, { name: 'duplicate' }, { name: 'moment' }, { name: 'document' }, { name: 'payload' }, { name: 'label' }, { name: 'missing' }, { name: '' }] } })
  })
  it('streams ordered scripts and stored-procedure result sets across backpressure boundaries', async () => {
    const result = await execute(`DROP PROCEDURE IF EXISTS contract_results;
DELIMITER $$
CREATE PROCEDURE contract_results() BEGIN SELECT n FROM numbers ORDER BY n; SELECT 'second;set' AS marker; END$$
DELIMITER ;
CALL contract_results(); SELECT 'tail'; DROP PROCEDURE contract_results;`, 50)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toHaveLength(52)
    expect(result.rows.slice(-2)).toEqual([['second;set'], ['tail']])
    const columns = result.events.filter(event => event.type === 'result').map(event => event.result.columns.map(col => col.name).join(','))
    expect(columns).toContain('n'); expect(columns).toContain('marker')
  })
  it('stops a script on error and preserves MySQL transaction semantics', async () => {
    expect((await execute('BEGIN; UPDATE retained SET value=99')).complete.transaction).toBe('transaction')
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    const failed = await execute('SELECT unknown_column FROM retained; UPDATE retained SET value=100')
    expect(failed.complete).toMatchObject({ status: 'failed', transaction: 'transaction' })
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['99']])
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['41']])
    expect((await execute('BEGIN; SAVEPOINT checkpoint; UPDATE retained SET value=43; ROLLBACK TO checkpoint; UPDATE retained SET value=42; COMMIT')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['42']])
  })
  it('tracks implicit DDL commits and autocommit off using server status', async () => {
    await execute('BEGIN; UPDATE retained SET value=44')
    expect((await execute('CREATE TABLE implicit_commit_test(id INT) ENGINE=InnoDB')).complete.transaction).toBe('idle')
    await execute('ROLLBACK; DROP TABLE implicit_commit_test')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
    expect((await execute('SET autocommit=0')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
    expect((await execute('UPDATE retained SET value=45')).complete.transaction).toBe('transaction')
    expect((await execute('ROLLBACK')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
    await execute('SET autocommit=1')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
    expect((await execute('SELECT missing_column')).complete.transaction).toBe('idle')
  })
  it('preserves ROW_COUNT and server warnings without hidden SQL probes', async () => {
    await execute('UPDATE retained SET value=46')
    expect((await execute('SELECT ROW_COUNT()')).rows).toEqual([['1']])
    const result = await execute("SELECT CAST('invalid-number' AS UNSIGNED)")
    expect(result.complete.status).toBe('completed')
    const warnings = await execute('SHOW WARNINGS')
    expect(warnings.rows.some(row => row[2]?.includes('invalid-number'))).toBe(true)
  })
  it('bounds retained rows and bytes, drains results and leaves the session reusable', async () => {
    const result = await execute('SELECT a.n FROM numbers a CROSS JOIN numbers b LIMIT 100000', 275)
    expect(result.rows).toHaveLength(275)
    expect(result.complete.status).toBe('completed')
    expect(result.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true, rowCount: 100000 } })
    const bytes = await execute("SELECT REPEAT('x', 1000000) AS large_value FROM numbers LIMIT 12", 20)
    expect(bytes.rows).toHaveLength(8)
    expect(bytes.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true } })
    expect((await execute('SELECT 1')).rows).toEqual([['1']])
  })
  it('cancels on a separate connection, stops the remaining script and prevents concurrent runs', async () => {
    events = []
    driver.start({ sessionId: session.id, sql: 'SELECT SLEEP(30); UPDATE retained SET value=999', maxRows: 1 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 2', maxRows: 1 })).toThrow('running')
    await expect(driver.disconnect(session.id)).rejects.toThrow('running')
    const metadata = await driver.tables(session.id)
    expect(metadata.some(table => table.name === 'customers')).toBe(true)
    expect((await driver.cancel(session.id)).requested).toBe(true)
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled' })
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['46']])
  })
  it('uses the current database for metadata and quotes catalog values safely', async () => {
    expect((await execute('USE information_schema')).complete.database).toBe('information_schema')
    expect((await driver.tables(session.id)).some(table => table.name === 'TABLES')).toBe(true)
    await execute('USE dbcommander')
    expect((await driver.tables(session.id)).some(table => table.name === 'customer_projects' && table.kind === 'view')).toBe(true)
  })
  it('supports escaping modes between executions and refuses ambiguous mid-script mode changes', async () => {
    expect(() => driver.start({ sessionId: session.id, sql: "SET sql_mode='NO_BACKSLASH_ESCAPES'; SELECT 1", maxRows: 1 })).toThrow('separately')
    await execute("SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
    const result = await execute(String.raw`SELECT 'a\' AS "slash", 'semi;colon'; SELECT 2;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['a\\', 'semi;colon'], ['2']])
    await execute('SET sql_mode=DEFAULT')
  })
  it('exports only fetched rows and invalidates old exports without repeating SQL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-csv-'))
    try {
      await execute('SET @exports=0')
      const result = await execute("SELECT (@exports := @exports+1) AS count, 'a,b' AS text, 9007199254740993 AS id, NULL AS missing, '' AS `empty`")
      const path = join(directory, 'result.csv')
      expect(result.complete.status, result.complete.error).toBe('completed')
      await driver.exportCsv(result.id, 0, path)
      expect(readFileSync(path, 'utf8')).toBe('"count","text","id","missing","empty"\r\n"1","a,b","9007199254740993",,""\r\n')
      expect((await execute('SELECT @exports')).rows).toEqual([['1']])
      expect(() => driver.exportCsv(result.id, 0, path)).toThrow('no longer available')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('refuses LOCAL INFILE access and remains usable after the error', async () => {
    expect((await execute("LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE retained")).complete.status).toBe('failed')
    expect((await execute('SELECT 7')).rows).toEqual([['7']])
  })
  it('reports connection termination as an unknown outcome without replay', async () => {
    const victim = await driver.connect({ ...config, name: 'fault test' })
    const control = await openMysqlTransport(config)
    try {
      events = []
      driver.start({ sessionId: victim.id, sql: 'SELECT SLEEP(30) /* dbcommander_fault */', maxRows: 1 })
      const done = driver.wait(victim.id)
      await new Promise(resolve => setTimeout(resolve, 200))
      const processes = await control.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(30) /* dbcommander_fault */%'")
      expect(processes).toHaveLength(1)
      await control.query(`KILL CONNECTION ${Number(processes[0][0])}`)
      await done
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'unknown', transaction: 'unknown' })
      await expect(driver.disconnect(victim.id)).resolves.toBeUndefined()
    } finally { await control.end() }
  })
})
