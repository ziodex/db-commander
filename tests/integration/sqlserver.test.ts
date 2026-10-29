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
import { openSqlServer, sqlServerBound, sqlServerQuery } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

if (!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlserver')) throw new Error('Run using pnpm test:integration --driver sqlserver to manage the Docker fixture.')
describe('Docker SQL Server driver contracts', () => {
  const config: ConnectionConfig = { engine: 'sqlserver', name: 'Docker SQL Server', host: 'localhost', port: Number(process.env.SQLCOMMANDER_SQLSERVER_PORT), database: 'dbcommander', user: 'dbcommander', password: 'Local-Test-Only!2026', tls: 'verify-full', ca: readFileSync(process.env.SQLCOMMANDER_SQLSERVER_CA!, 'utf8') }
  let driver: DriverRegistry, session: SessionInfo, events: DatabaseEvent[] = []
  async function execute(sql: string, maxRows = 1000, target = session.id) {
    events = []
    const id = driver.start({ sessionId: target, sql, maxRows })
    await driver.wait(target)
    return { id, events: [...events], complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>, rows: events.flatMap(event => event.type === 'rows' ? event.rows : []) }
  }
  beforeAll(async () => { driver = new DriverRegistry(event => { events.push(event) }); session = await driver.connect(config) })
  afterAll(async () => { await driver?.close() })

  it('browses accessible databases and safely replaces only the selected session', async () => { await verifyDatabaseBrowsing(config) })
  it('browses and switches Azure profiles using the local TDS fixture', async () => { await verifyDatabaseBrowsing({ ...config, engine: 'azure-sql' }) })
  it('backs up and restores native schema/data with target protection, constraints and cancellation', async () => { await verifyBackups(config) }, 180000)
  it('isolates concurrent tab sessions, transaction state and cached exports', async () => { await verifySessionIsolation(config) })
  it('browses Azure SQL profiles against the local TDS fixture', async () => { await verifyTableBrowsing({ ...config, engine: 'azure-sql' }) }, 120000)
  it('edits Azure SQL profiles against the local TDS fixture', async () => { await verifyEditableGrid({ ...config, engine: 'azure-sql' }) })
  it('completes and formats Azure SQL profiles against the local TDS fixture', async () => { await verifyLanguageTools({ ...config, engine: 'azure-sql' }) })
  it('imports and exports Azure SQL profiles against the local TDS fixture', async () => { await verifyDataTransfer({ ...config, engine: 'azure-sql' }) }, 240000)
  it('explores Azure catalog objects and definitions', async () => { await verifyCatalog({ ...config, engine: 'azure-sql' }) }, 180000)
  it('reviews Azure-profile source edits and refuses stale definitions', async () => { await verifyObjectSource({ ...config, engine: 'azure-sql' }) }, 180000)
  it('reviews and applies an Azure-profile trigger source edit', async () => { await verifyTriggerSource({ ...config, engine: 'azure-sql' }) }, 180000)
  it('reviews and applies an Azure-profile routine source edit', async () => { await verifyRoutineSource({ ...config, engine: 'azure-sql' }) }, 180000)
  it('calls an Azure-profile procedure with discovered bound parameters', async () => { await verifyProcedureCall({ ...config, engine: 'azure-sql' }) }, 180000)
  it('inspects Azure values and follows foreign keys', async () => { await verifyInspection({ ...config, engine: 'azure-sql' }) }, 180000)
  it('compares keyed bounded data with exact values and preserved sessions', async () => { await verifyDataComparison(config) }, 180000)
  it('compares same-engine schemas with reviewable target SQL and session isolation', async () => { await verifySchemaComparison(config) }, 180000)
  it('compares keyed bounded Azure data using the TDS fixture', async () => { await verifyDataComparison({...config,engine:'azure-sql'}) }, 180000)
  it('compares Azure SQL schemas using the local TDS fixture', async () => { await verifySchemaComparison({...config,engine:'azure-sql'}) }, 180000)
  it('reads ER diagrams with ordered keys, catalog scope and session isolation', async () => { await verifyDiagram(config) }, 180000)
  it('reads ER diagrams for Azure profiles using the local TDS fixture', async () => { await verifyDiagram({...config,engine:'azure-sql'}) }, 180000)
  it('executes current statements with source-aware failures and native preflight guards', async () => { await verifyExecution(config) }, 120000)
  it('executes current statements for Azure profiles using the local TDS fixture', async () => { await verifyExecution({ ...config, engine: 'azure-sql' }) }, 120000)
  it('round trips Azure snippets with preserved transaction state', async () => { await verifySnippetExchange({ ...config, engine: 'azure-sql' }) }, 120000)
  it('imports and exports snippets without executing SQL or changing sessions', async () => { await verifySnippetExchange(config) }, 120000)
  it('exports bound parameters with exact values, isolation and cancellation', async () => { await verifyParameterExport(config) }, 120000)
  it('exports bound parameters for Azure profiles using the TDS fixture', async () => { await verifyParameterExport({ ...config, engine: 'azure-sql' }) }, 120000)
  it('binds array parameters with exact elements, empty lists and safe operations', async () => { await verifyArrayParameters(config) }, 120000)
  it('binds array parameters for Azure profiles', async () => { await verifyArrayParameters({ ...config, engine: 'azure-sql' }) }, 120000)
  it('binds timezone-aware timestamp parameters with exact instants and safe operations', async () => { await verifyTimezoneParameters(config) }, 120000)
  it('binds timezone-aware timestamp parameters for Azure profiles', async () => { await verifyTimezoneParameters({ ...config, engine: 'azure-sql' }) }, 120000)
  it('binds decimal date and timestamp parameters with exact values and safe operations', async () => { await verifyTypedParameters(config) }, 120000)
  it('binds decimal date and timestamp parameters for Azure profiles', async () => { await verifyTypedParameters({ ...config, engine: 'azure-sql' }) }, 120000)
  it('binds query parameters with native types, isolation and preflight checks', async () => { await verifyParameters(config) }, 120000)
  it('binds query parameters for Azure profiles using the local TDS fixture', async () => { await verifyParameters({ ...config, engine: 'azure-sql' }) }, 120000)
  it('inspects large values and follows composite foreign keys safely', async () => { await verifyInspection(config) }, 180000)
  it('captures engine-specific plans while preserving transactions and results', async () => { await verifyExplain(config) }, 180000)
  it('protects production sessions and verifies SSH transport where supported', async () => { await verifyConnectionSafeguards(config) }, 180000)
  it('captures Azure estimated plans with isolated SHOWPLAN state', async () => { await verifyExplain({ ...config, engine: 'azure-sql' }) }, 180000)
  it('protects Azure profiles and verifies SSH transport using the TDS fixture', async () => { await verifyConnectionSafeguards({ ...config, engine: 'azure-sql' }) }, 180000)
  it('inspects rollback progress without changing or retargeting transactions', async () => { await verifyRollbackInspection(config) }, 180000)
  it('reviews cancellation and termination with identity revalidation', async () => { await verifyActivityControls(config) }, 180000)
  it('inspects Azure-profile rollback progress without retargeting transactions', async () => { await verifyRollbackInspection({...config,engine:'azure-sql'}) }, 180000)
  it('reviews Azure-profile cancellation and termination with identity revalidation', async () => { await verifyActivityControls({...config,engine:'azure-sql'}) }, 180000)
  it('inspects sessions and real lock waits without changing query state', async () => { await verifyActivity(config) }, 180000)
  it('inspects Azure-profile sessions and lock waits through the TDS fixture', async () => { await verifyActivity({...config,engine:'azure-sql'}) }, 180000)
  it('builds visual SELECT queries with native joins, grouping and parameters', async () => { await verifyQueryBuilder(config) }, 180000)
  it('builds Azure visual SELECT queries through the TDS fixture', async () => { await verifyQueryBuilder({...config,engine:'azure-sql'}) }, 180000)
  it('exports reviewed migration files with native DDL semantics', async () => { await verifyMigrations(config) }, 180000)
  it('exports reviewed Azure migration files using the TDS fixture', async () => { await verifyMigrations({...config,engine:'azure-sql'}) }, 180000)
  it('reviews and applies schema changes with native transaction handling', async () => { await verifySchemaChanges(config) }, 300000)
  it('reviews and applies Azure schema changes', async () => { await verifySchemaChanges({ ...config, engine: 'azure-sql' }) }, 300000)
  it('explores rich catalog objects and definitions without changing session state', async () => { await verifyCatalog(config) }, 180000)
  it('reviews source edits and refuses stale definitions', async () => { await verifyObjectSource(config) }, 180000)
  it('reviews and applies a trigger source edit', async () => { await verifyTriggerSource(config) }, 180000)
  it('reviews and applies a routine source edit', async () => { await verifyRoutineSource(config) }, 180000)
  it('calls a procedure with discovered bound parameters', async () => { await verifyProcedureCall(config) }, 180000)
  it('keeps large server catalogs inspectable beyond child and column limits', async () => { await verifyLargeServerCatalog(config) }, 360000)
  if(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE==='1') it('catalog performance sqlserver: 10000 and 20000 constrained tables',()=>verifyCatalogPerformance(config),1200000)
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('exports Azure SQL INSERT scripts', async () => { await verifyInsertExport({ ...config, engine: 'azure-sql' }) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  it('imports JSON exports for Azure SQL profiles', async () => { await verifyJsonImport({ ...config, engine: 'azure-sql' }) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('samples transaction state without observing its own metadata query', async () => {
    const local = await driver.connect(config)
    try {
      expect(local).toMatchObject({ transaction: 'idle', autocommit: true })
      const run = (sql: string) => execute(sql, 1000, local.id)
      expect((await run('SELECT XACT_STATE(), @@OPTIONS, DB_NAME()')).complete.transaction).toBe('idle')
      expect((await run('SET IMPLICIT_TRANSACTIONS ON')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
      expect((await run('SELECT 1')).complete.transaction).toBe('idle')
      expect((await run('SELECT TOP (1) id FROM dbo.customers')).complete.transaction).toBe('transaction')
      expect((await run('ROLLBACK')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
      expect((await run('SET IMPLICIT_TRANSACTIONS OFF')).complete).toMatchObject({ transaction: 'idle', autocommit: true })
    } finally {
      await execute('IF @@TRANCOUNT>0 ROLLBACK; SET IMPLICIT_TRANSACTIONS OFF', 1000, local.id)
      await driver.disconnect(local.id)
    }
  })
  it('retains transaction boundaries and SET options across grid parameter requests', async () => {
    const client = await openSqlServer(config)
    try {
      await sqlServerBound(client, 'SET LOCK_TIMEOUT 1234')
      await sqlServerBound(client, 'BEGIN TRANSACTION')
      const text = "'; ROLLBACK; -- 世界"
      expect((await sqlServerBound(client, 'SELECT @p1, @@TRANCOUNT, @@LOCK_TIMEOUT', [text])).rows).toEqual([[text, '1', '1234']])
      await sqlServerBound(client, 'ROLLBACK')
      expect((await sqlServerBound(client, 'SELECT @@TRANCOUNT, @@LOCK_TIMEOUT')).rows).toEqual([['0', '1234']])
    } finally { await sqlServerQuery(client, 'IF @@TRANCOUNT>0 ROLLBACK'); client.close() }
  })
  it('verifies TLS, CA, hostname, login and explicitly disabled local TLS', async () => {
    expect(session.engine).toBe('sqlserver'); expect(session.version).toContain('SQL Server 2022'); expect(session.tls).toBe(true)
    await expect(driver.connect({ ...config, ca: '' })).rejects.toThrow()
    await expect(driver.connect({ ...config, host: '127.0.0.1' })).rejects.toThrow()
    await expect(driver.connect({ ...config, password: 'wrong-password' })).rejects.toThrow()
    const local = await driver.connect({ ...config, tls: 'disable' })
    expect(local.tls).toBe(false); await driver.disconnect(local.id)
  })
  it('routes Azure SQL password profiles through the same TDS driver (local contract, not live Azure)', async () => {
    const azure = await driver.connect({ ...config, engine: 'azure-sql' })
    try {
      expect(azure.engine).toBe('azure-sql')
      expect((await execute('SELECT DB_NAME()', 1000, azure.id)).rows).toEqual([['dbcommander']])
      expect((await driver.tables(azure.id)).some(table => table.name === 'customers')).toBe(true)
    } finally { await driver.disconnect(azure.id) }
    await expect(driver.connect({ ...config, engine: 'azure-sql', tls: 'disable' })).rejects.toThrow('verified TLS')
  })
  it('retains physical sessions, temporary tables and T-SQL variable scope', async () => {
    const result = await execute('CREATE TABLE #retained(value INT); INSERT #retained VALUES(41); DECLARE @n INT=1; SELECT value+@n FROM #retained;')
    expect(result.complete.status, result.complete.error).toBe('completed'); expect(result.rows).toEqual([['42']])
    expect((await execute('SELECT value FROM #retained')).rows).toEqual([['41']])
  })
  it('preserves exact numeric and temporal values, Unicode, binary, NULL and duplicate aliases', async () => {
    const result = await execute("SELECT wide_int AS duplicate, precise AS duplicate, amount, moment, zoned, time_only, date_only, payload, label, document, missing, '' FROM dbo.data_types")
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['9223372036854775807', '12345678901234567890.123456789012345678', '922337203685477.5807', '2026-10-12 12:34:56.1234567', '2026-10-12 12:34:56.1234567+05:30', '12:34:56.1234567', '0001-01-01', '0x00ff802c', 'Hej 世界 👋', '{"big":9007199254740993}', null, '']])
    expect(result.events.filter(event => event.type === 'result').find(event => event.result.columns.length)?.result.columns.slice(0, 2).map(column => column.name)).toEqual(['duplicate', 'duplicate'])
    const variant = await execute("SELECT CAST(precise AS SQL_VARIANT), CAST(zoned AS SQL_VARIANT), CAST(-0.000000000000000001 AS DECIMAL(38,18)), CAST('1900-01-01T12:34:56.123' AS DATETIME), CAST('2026-10-12T12:34:00' AS SMALLDATETIME) FROM dbo.data_types")
    expect(variant.rows).toEqual([['12345678901234567890.123456789012345678', '2026-10-12 12:34:56.1234567+05:30', '-0.000000000000000001', '1900-01-01 12:34:56.123', '2026-10-12 12:34:00.000']])
  })
  for (const engine of ['sqlserver', 'azure-sql'] as const) it(`preserves mixed large text, JSON, XML and NULL result cells for ${engine}`, async () => {
    const target = await driver.connect({ ...config, engine })
    try {
      const json = '{"n":9007199254740993,"n":2,"s":"Ω"}', xml = '<root><value>Ω &amp; safe</value></root>'
      const result = await execute(`SELECT REPLICATE(CAST('x' AS varchar(max)),30000)+'tail' AS [large],N'${json}' AS [document],N'${xml}' AS [markup],NULL AS [missing]`, 1000, target.id)
      expect(result.complete.status, result.complete.error).toBe('completed')
      expect(result.rows).toEqual([['x'.repeat(30000) + 'tail', json, xml, null]])
    } finally { await driver.disconnect(target.id) }
  })
  it('streams GO batches, procedure result sets, empty results, NOCOUNT and PRINT in order', async () => {
    const result = await execute(`CREATE OR ALTER PROCEDURE dbo.contract_results AS BEGIN SET NOCOUNT ON; SELECT n FROM dbo.numbers ORDER BY n; SELECT 1 AS empty WHERE 1=0; PRINT 'contract notice'; SELECT 'second;set' AS marker; END;
GO
EXEC dbo.contract_results;
GO
SELECT 'tail';
GO
DROP PROCEDURE dbo.contract_results;`, 50)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toHaveLength(52); expect(result.rows.slice(-2)).toEqual([['second;set'], ['tail']])
    expect(result.events.some(event => event.type === 'notice' && event.message.includes('contract notice'))).toBe(true)
    const sets = new Map(result.events.filter(event => event.type === 'result').map(event => [event.result.index, event.result]))
    expect([...sets.values()].map(result => result.columns[0]?.name)).toEqual(['n', 'empty', 'marker', ''])
    expect([...sets.values()][0]).toMatchObject({ rowCount: 1000, truncated: true })
    await execute('UPDATE #retained SET value=value+1\nGO 2')
    expect((await execute('SELECT value FROM #retained')).rows).toEqual([['43']])
  })
  it('tracks nested transactions, savepoints, commit and rollback without replacing the connection', async () => {
    expect((await execute('BEGIN TRANSACTION; BEGIN TRANSACTION; UPDATE #retained SET value=99; SAVE TRANSACTION point1; UPDATE #retained SET value=100; ROLLBACK TRANSACTION point1; SELECT value FROM #retained')).rows).toEqual([['99']])
    expect(driver.getSession(session.id).transaction).toBe('transaction')
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await execute('COMMIT')).complete.transaction).toBe('transaction')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM #retained')).rows).toEqual([['43']])
    expect((await execute('BEGIN TRANSACTION; UPDATE #retained SET value=44; COMMIT')).complete.transaction).toBe('idle')
  })
  it('supports transactional DDL and implicit transaction mode', async () => {
    await execute('BEGIN TRANSACTION; CREATE TABLE dbo.contract_rollback(id INT); ROLLBACK')
    expect((await execute("SELECT OBJECT_ID('dbo.contract_rollback')")).rows).toEqual([[null]])
    expect((await execute('SET IMPLICIT_TRANSACTIONS ON')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
    expect((await execute('SELECT value FROM #retained')).complete.transaction).toBe('transaction')
    await execute('ROLLBACK; SET IMPLICIT_TRANSACTIONS OFF')
    expect(driver.getSession(session.id)).toMatchObject({ transaction: 'idle', autocommit: true })
  })
  it('reports uncommittable transactions from XACT_STATE and recovers through rollback', async () => {
    // A nested stored procedure returns a doomed transaction to the outer batch;
    // SQL Server may auto-rollback it at the end of the batch. The displayed state
    // must match the server's state after that boundary, not infer it from tokens.
    const result = await execute(`SET XACT_ABORT ON; BEGIN TRY BEGIN TRANSACTION; INSERT dbo.projects(customer_id,name) VALUES(-1,N'bad'); END TRY BEGIN CATCH SELECT XACT_STATE(); END CATCH;`)
    expect(result.rows).toEqual([['-1']])
    expect(result.complete.transaction).toBe('idle')
    await execute('IF @@TRANCOUNT>0 ROLLBACK; SET XACT_ABORT OFF')
    expect((await execute('SELECT 1')).rows).toEqual([['1']])
  })
  it('stops subsequent GO batches after errors and keeps acknowledged SQL-error sessions usable', async () => {
    // Focused runs must not depend on #retained from earlier contract cases.
    try {
      const seed = await execute('CREATE TABLE #go_guard(value INT); INSERT INTO #go_guard VALUES(44)')
      expect(seed.complete.status, seed.complete.error).toBe('completed')
      const result = await execute("SELECT * FROM dbo.dbcommander_missing\nGO\nUPDATE #go_guard SET value=999")
      expect(result.complete.status, result.complete.error).toBe('failed')
      expect((await execute('SELECT value FROM #go_guard')).rows).toEqual([['44']])
      const errors = await execute("RAISERROR('first',16,1); RAISERROR('second',16,1);")
      expect(errors.complete.status, errors.complete.error).toBe('failed')
      expect(errors.complete.error).toContain('first'); expect(errors.complete.error).toContain('second')
      expect((await execute('SELECT 7')).rows).toEqual([['7']])
    } finally { await execute('DROP TABLE IF EXISTS #go_guard') }
  })
  it('bounds retained rows and bytes while draining the TDS response', async () => {
    const rows = await execute('SELECT TOP (100000) a.n FROM dbo.numbers a CROSS JOIN dbo.numbers b', 275)
    expect(rows.complete.status, rows.complete.error).toBe('completed'); expect(rows.rows).toHaveLength(275)
    expect(rows.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true, rowCount: 100000 } })
    const bytes = await execute("SELECT TOP (12) REPLICATE(CAST('x' AS VARCHAR(MAX)),1000000) AS large_value FROM dbo.numbers", 20)
    expect(bytes.complete.status, bytes.complete.error).toBe('completed'); expect(bytes.rows).toHaveLength(8)
    expect(bytes.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true } })
    expect((await execute('SELECT 1')).rows).toEqual([['1']])
  })
  it('cancels WAITFOR with ATTENTION, stops remaining batches and permits independent metadata', async () => {
    events = []
    driver.start({ sessionId: session.id, sql: "WAITFOR DELAY '00:00:30'\nGO\nUPDATE #retained SET value=999", maxRows: 1 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 2', maxRows: 1 })).toThrow('running')
    await expect(driver.disconnect(session.id)).rejects.toThrow('running')
    expect((await driver.tables(session.id)).some(table => table.name === 'customers')).toBe(true)
    expect((await driver.cancel(session.id)).requested).toBe(true)
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled' })
    expect((await execute('SELECT value FROM #retained')).rows).toEqual([['44']])
  })
  it('uses the current database for metadata and quotes names containing brackets', async () => {
    const tables = await driver.tables(session.id)
    expect(tables.some(table => table.name === 'customer_projects' && table.schema === 'dbo' && table.kind === 'view')).toBe(true)
    expect((await execute('USE tempdb')).complete.database).toBe('tempdb')
    expect((await driver.tables(session.id)).some(table => table.name === 'customers')).toBe(false)
    await execute('USE dbcommander')
    expect((await execute('CREATE TABLE #odd(name INT); SELECT TOP(1) name AS [odd]]name] FROM #odd')).complete.status).toBe('completed')
  })
  it('exports only fetched rows without executing SQL again and invalidates stale exports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-csv-'))
    try {
      const result = await execute("UPDATE #retained SET value=value+1; SELECT value AS count, 'a,b' AS text, CAST(9007199254740993 AS BIGINT) AS id, NULL AS missing, '' AS [empty] FROM #retained")
      const index = result.events.filter(event => event.type === 'result').find(event => event.result.columns.length)?.result.index
      expect(index).toBeDefined()
      const path = join(directory, 'result.csv')
      await driver.exportCsv(result.id, index!, path)
      expect(readFileSync(path, 'utf8')).toBe('"count","text","id","missing","empty"\r\n"45","a,b","9007199254740993",,""\r\n')
      expect((await execute('SELECT value FROM #retained')).rows).toEqual([['45']])
      expect(() => driver.exportCsv(result.id, index!, path)).toThrow('no longer available')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('reports connection termination as an unknown outcome without replay', async () => {
    const victim = await driver.connect({ ...config, name: 'fault test' })
    const control = await openSqlServer({ ...config, user: 'sa', password: 'Local-SA-Only!2026' })
    try {
      const spid = Number((await execute('SELECT @@SPID', 1, victim.id)).rows[0][0])
      expect(Number.isSafeInteger(spid) && spid > 0).toBe(true)
      events = []
      driver.start({ sessionId: victim.id, sql: "WAITFOR DELAY '00:00:30'", maxRows: 1 })
      const done = driver.wait(victim.id)
      await new Promise(resolve => setTimeout(resolve, 200))
      await sqlServerQuery(control, `KILL ${spid}`)
      await done
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'unknown', transaction: 'unknown' })
      await expect(driver.disconnect(victim.id)).resolves.toBeUndefined()
    } finally { control.close() }
  })
})
