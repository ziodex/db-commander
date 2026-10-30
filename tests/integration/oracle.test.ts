import { verifyTransferWorkflows } from './transfer-workflows-contract'
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
import { verifyLargeServerCatalog } from './server-catalog-contract'
import { verifyCatalogPerformance } from './catalog-performance-contract'
import { verifyDataTransfer } from './transfer-contract'
import { verifyTableBrowsing } from './browsing-contract'
import { verifyBackups } from './backup-contract'
import { verifyEditableGrid } from './grid-contract'
import { verifyLanguageTools } from './language-contract'
import { verifySessionIsolation } from './session-isolation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import oracledb from 'oracledb'
import { DriverRegistry } from '../../src/driver/registry'
import { oracleConnectionOptions } from '../../src/driver/oracle'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

if (!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('oracle')) throw new Error('Run using pnpm test:integration --driver oracle to manage the Docker fixture.')
describe('Docker Oracle driver contracts', () => {
  const config: ConnectionConfig = { engine: 'oracle', name: 'Docker Oracle', host: 'localhost', port: Number(process.env.SQLCOMMANDER_ORACLE_PORT), database: 'FREEPDB1', user: 'dbcommander', password: 'local-test-only', tls: 'verify-full' }
  let driver: DriverRegistry, session: SessionInfo, events: DatabaseEvent[] = []
  async function execute(sql: string, maxRows = 1000, target = session.id) {
    events = []
    const id = driver.start({ sessionId: target, sql, maxRows })
    await driver.wait(target)
    return { id, events: [...events], complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>, rows: events.flatMap(event => event.type === 'rows' ? event.rows : []) }
  }
  beforeAll(async () => { driver = new DriverRegistry(event => { events.push(event) }); session = await driver.connect(config) })
  afterAll(async () => { await driver?.close() })

  // This contract runs multiple cold Data Pump exports/imports plus refusal paths.
  it('backs up and restores native schema/data with target protection, constraints and cancellation', async () => { await verifyBackups(config) }, 360000)
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
  it('preserves a disabled trigger when applying its reviewed source', async () => { await verifyTriggerSource(config, true) }, 180000)
  it('reviews and applies a routine source edit', async () => { await verifyRoutineSource(config) }, 180000)
  it('calls a procedure with discovered bound parameters', async () => { await verifyProcedureCall(config) }, 180000)
  it('keeps large server catalogs navigable with bounded metadata and preserved transactions', async () => { await verifyLargeServerCatalog(config) }, 360000)
  if(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE==='1') it('catalog performance oracle: 10000 and 20000 constrained tables',()=>verifyCatalogPerformance(config),1200000)
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  it('reviews new-table imports, JSON Lines and captured database copies without replay', async () => { await verifyTransferWorkflows(config) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('uses native Oracle with verified TCPS, rejects wrong hostname/login and supports explicit TCP', async () => {
    expect(session.engine).toBe('oracle'); expect(session.tls).toBe(true); expect(session.version).toContain('23.26')
    await expect(driver.connect({ ...config, host: '127.0.0.1' })).rejects.toThrow()
    await expect(driver.connect({ ...config, password: 'wrong-password' })).rejects.toThrow()
    const local = await driver.connect({ ...config, port: Number(process.env.SQLCOMMANDER_ORACLE_TCP_PORT), tls: 'disable' })
    expect(local.tls).toBe(false); await driver.disconnect(local.id)
  })
  it('rejects the self-signed server when the test CA is not trusted', async () => {
    const env = { ...process.env }; delete env.NODE_EXTRA_CA_CERTS
    // Docker publishes IPv4 only. Oracle retries every resolved address after
    // TLS rejection, so an IPv6 refusal can mask the earlier trust error.
    const script = `const db=require('oracledb'); db.getConnection(JSON.parse(process.argv[1])).then(async c=>{await c.close();process.exitCode=1}, e=>{console.log(e.message)});`
    const output = await promisify(execFile)(process.execPath, ['-e', script, JSON.stringify(oracleConnectionOptions({ ...config, host: '127.0.0.1' }))], { env, timeout: 20000 })
    expect(output.stdout).toMatch(/self.signed/i)
  })
  it('retains physical sessions and temporary rows across runs', async () => {
    expect((await execute('INSERT INTO retained VALUES(41); COMMIT; SELECT value+1 FROM retained')).rows).toEqual([['42']])
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['41']])
    const other = await driver.connect(config)
    try { expect((await execute('SELECT value FROM retained', 1000, other.id)).rows).toEqual([]) }
    finally { await driver.disconnect(other.id) }
  })
  it('preserves NUMBER precision, nanosecond timestamps, offsets, Unicode, RAW, CLOB, JSON and duplicate names', async () => {
    const result = await execute(`SELECT wide_int AS duplicate, precise AS duplicate, moment, zoned, date_only, payload, label, document, missing, '', native_json FROM data_types`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['9223372036854775807', '12345678901234567890.123456789012345678', '2026-10-12 12:34:56.123456789', '2026-10-12 12:34:56.123456789 +05:30', '0001-01-01 00:00:00', '0x00ff802c', 'Hej 世界 👋', '{"big":9007199254740993}', null, null, '{"big":9007199254740993}']])
    expect(result.events.filter(event => event.type === 'result').find(event => event.result.columns.length)?.result.columns.slice(0, 2).map(column => column.name)).toEqual(['DUPLICATE', 'DUPLICATE'])
  })
  it('executes PL/SQL and slash-delimited procedures, captures DBMS_OUTPUT and implicit cursors in order', async () => {
    const result = await execute(`CREATE OR REPLACE PROCEDURE contract_results AS c SYS_REFCURSOR; BEGIN
      DBMS_OUTPUT.PUT_LINE(q'[Hello; Oracle]');
      OPEN c FOR SELECT n FROM numbers ORDER BY n; DBMS_SQL.RETURN_RESULT(c);
      OPEN c FOR SELECT 1 AS empty FROM dual WHERE 1=0; DBMS_SQL.RETURN_RESULT(c);
      END;
      /
      BEGIN contract_results; END;
      /
      SELECT 'tail' FROM dual;
      DROP PROCEDURE contract_results;`, 50)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toHaveLength(51); expect(result.rows.at(-1)).toEqual(['tail'])
    expect(result.events.some(event => event.type === 'notice' && event.message.includes('Hello; Oracle'))).toBe(true)
    const sets = new Map(result.events.filter(event => event.type === 'result').map(event => [event.result.index, event.result]))
    expect([...sets.values()].find(result => result.columns[0]?.name === 'N')).toMatchObject({ rowCount: null, truncated: true })
    expect([...sets.values()].find(result => result.columns[0]?.name === 'EMPTY')).toMatchObject({ rowCount: 0, truncated: false })
  })
  it('preserves implicit cursor types, named-zone instants and local timestamps without patching other connections', async () => {
    const result = await execute(`DECLARE c SYS_REFCURSOR; BEGIN OPEN c FOR
      SELECT wide_int, precise, moment FROM data_types; DBMS_SQL.RETURN_RESULT(c); END;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['9223372036854775807', '12345678901234567890.123456789012345678', '2026-10-12 12:34:56.123456789']])
    const zones = await execute(`SELECT TO_TIMESTAMP_TZ('2026-10-12 12:34:56.123456789 Europe/Madrid', 'YYYY-MM-DD HH24:MI:SS.FF9 TZR'),
      CAST(TIMESTAMP '2026-10-12 12:34:56.123456789 +05:30' AS TIMESTAMP(9) WITH LOCAL TIME ZONE) FROM dual`)
    expect(zones.rows).toEqual([['2026-10-12 10:34:56.123456789 +00:00', '2026-10-12 07:04:56.123456789 +00:00']])
    const native = await oracledb.getConnection(oracleConnectionOptions(config))
    try { expect((await native.execute<[Date]>('SELECT moment FROM data_types')).rows![0][0]).toBeInstanceOf(Date) }
    finally { await native.close() }
  })
  it('attributes output from failed PL/SQL to that execution and reports compilation warnings', async () => {
    const failed = await execute("BEGIN DBMS_OUTPUT.PUT_LINE('before error'); RAISE_APPLICATION_ERROR(-20001, 'expected failure'); END;")
    expect(failed.complete).toMatchObject({ status: 'failed', code: 'ORA-20001' })
    expect(failed.events.some(event => event.type === 'notice' && event.message.includes('before error'))).toBe(true)
    expect((await execute('SELECT 1 FROM dual')).events.some(event => event.type === 'notice' && event.message.includes('before error'))).toBe(false)
    const compile = await execute('CREATE OR REPLACE PROCEDURE invalid_contract AS BEGIN missing_procedure; END;')
    expect(compile.events.some(event => event.type === 'notice')).toBe(true)
    await execute('DROP PROCEDURE invalid_contract')
  })
  it('tracks manual transactions, savepoints, rollback and commit using server state', async () => {
    expect((await execute('SAVEPOINT DBCOMMANDER_BEGIN')).complete.transaction).toBe('transaction')
    expect((await execute('UPDATE retained SET value=99; SAVEPOINT point1; UPDATE retained SET value=100; ROLLBACK TO point1; SELECT value FROM retained')).rows).toEqual([['99']])
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['41']])
    expect((await execute('UPDATE retained SET value=42; COMMIT')).complete).toMatchObject({ transaction: 'idle', autocommit: false })
  })
  it('reflects implicit DDL commits, including commits before failing DDL', async () => {
    expect((await execute('UPDATE retained SET value=43; CREATE TABLE contract_ddl(id NUMBER)')).complete.transaction).toBe('idle')
    const failed = await execute('UPDATE retained SET value=44; CREATE TABLE contract_ddl(id NUMBER)')
    expect(failed.complete).toMatchObject({ status: 'failed', transaction: 'idle' })
    await execute('ROLLBACK; DROP TABLE contract_ddl')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
  })
  it('keeps a transaction usable after an Oracle statement error and skips remaining statements', async () => {
    const result = await execute('UPDATE retained SET value=45; SELECT * FROM missing_contract_table; DELETE FROM retained')
    expect(result.complete).toMatchObject({ status: 'failed', transaction: 'transaction', code: 'ORA-00942' })
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['45']])
    await execute('ROLLBACK')
  })
  it('preflights malformed scripts and unbound parameters before any side effects', async () => {
    expect(() => driver.start({ sessionId: session.id, sql: 'DELETE FROM retained; SELECT :n FROM dual', maxRows: 10 })).toThrow('Bind')
    expect(() => driver.start({ sessionId: session.id, sql: "DELETE FROM retained; SELECT q'[bad' FROM dual", maxRows: 10 })).toThrow('Unterminated')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
  })
  it('discovers quoted tables and views without changing the console transaction', async () => {
    const created = await execute('CREATE TABLE "Contract quoted table"(n NUMBER); UPDATE retained SET value=46')
    expect(created.complete.status, created.complete.error).toBe('completed')
    const tables = await driver.tables(session.id)
    expect(tables).toContainEqual({ schema: 'DBCOMMANDER', name: 'Contract quoted table', kind: 'table' })
    expect(tables).toContainEqual({ schema: 'DBCOMMANDER', name: 'CUSTOMER_NAMES', kind: 'view' })
    expect(driver.getSession(session.id).transaction).toBe('transaction')
    await execute('ROLLBACK; DROP TABLE "Contract quoted table"')
  })
  it('bounds rows and LOB bytes, closes truncated cursors and can run the next statement', async () => {
    const result = await execute('SELECT n FROM numbers ORDER BY n; SELECT binary_value FROM large_lob', 50)
    expect(result.rows).toHaveLength(51); expect(result.rows.at(-1)).toEqual(['0x00ff'])
    const large = await execute('SELECT text_value FROM large_lob; SELECT 7 FROM dual')
    expect(large.complete.status, large.complete.error).toBe('completed')
    expect(large.rows).toEqual([['7']])
    expect(large.events.some(event => event.type === 'result' && event.result.truncated)).toBe(true)
    expect((await execute('SELECT 8 FROM dual')).rows).toEqual([['8']])
  })
  it('exports retained values as CSV without replaying mutating SQL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-oracle-'))
    try {
      const result = await execute(`UPDATE retained SET value=value+1; SELECT value AS "count", 'a,b' AS "text", wide_int AS "id", missing AS "missing" FROM retained CROSS JOIN data_types`)
      const output = join(directory, 'result.csv'); await driver.exportCsv(result.id, 1, output)
      expect(readFileSync(output, 'utf8')).toBe('"count","text","id","missing"\r\n"45","a,b","9223372036854775807",\r\n')
      expect((await execute('SELECT value FROM retained')).rows).toEqual([['45']])
      await execute('ROLLBACK')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('cancels active SQL work, preserves earlier writes, skips the tail and reuses the session', async () => {
    await execute('UPDATE retained SET value=46')
    events = []
    driver.start({ sessionId: session.id, maxRows: 10, sql: 'SELECT sum(a.n+b.n+c.n) FROM numbers a CROSS JOIN numbers b CROSS JOIN numbers c; DELETE FROM retained;' })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 1 FROM dual', maxRows: 1 })).toThrow('running')
    await expect(driver.disconnect(session.id)).rejects.toThrow('running')
    expect((await driver.cancel(session.id)).requested).toBe(true)
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled', transaction: 'transaction' })
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['46']])
    await execute('ROLLBACK')
    expect((await driver.cancel(session.id)).requested).toBe(false)
  })
  it('honors async row consumer backpressure and stops scripts on consumer failure', async () => {
    const slow = new DriverRegistry(async event => { if (event.type === 'rows') { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('Consumer stopped') } })
    const target = await slow.connect(config)
    try {
      let complete: Extract<DatabaseEvent, { type: 'complete' }> | undefined
      slow.start({ sessionId: target.id, sql: 'SELECT n FROM numbers; DELETE FROM customers', maxRows: 2000 }, event => { complete = event })
      await slow.wait(target.id)
      expect(complete).toMatchObject({ status: 'failed', error: 'Consumer stopped' })
      expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    } finally { await slow.close() }
  })
  it('cancels during row backpressure and closes the cursor before session reuse', async () => {
    let reached!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let complete: Extract<DatabaseEvent, { type: 'complete' }> | undefined
    const streaming = new DriverRegistry(async event => {
      if (event.type === 'rows') { reached(); await held }
      if (event.type === 'complete') complete = event
    })
    const target = await streaming.connect(config)
    try {
      streaming.start({ sessionId: target.id, sql: 'SELECT n FROM numbers; DELETE FROM customers', maxRows: 2000 })
      await ready
      expect((await streaming.cancel(target.id)).requested).toBe(true)
      release(); await streaming.wait(target.id)
      expect(complete).toMatchObject({ status: 'cancelled', transaction: 'idle' })
      expect(streaming.getSession(target.id).transaction).toBe('idle')
      expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    } finally { release(); await streaming.close() }
  })
  it('reports server-killed connections as unknown and requires explicit reconnect', async () => {
    const victim = await driver.connect(config)
    const sid = (await execute("SELECT SYS_CONTEXT('USERENV','SID') FROM dual", 1, victim.id)).rows[0][0]!
    const admin = await oracledb.getConnection(oracleConnectionOptions({ ...config, user: 'system', password: 'Local-Admin-Only2026' }))
    try {
      const rows = await admin.execute<[number, number]>('SELECT sid, serial# FROM v$session WHERE sid=:sid', { sid: Number(sid) })
      const [id, serial] = rows.rows![0]
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(serial)) throw new Error('Invalid session identifier')
      await admin.execute(`ALTER SYSTEM KILL SESSION '${id},${serial}' IMMEDIATE`)
      const result = await execute('SELECT 1 FROM dual; DELETE FROM customers', 1, victim.id)
      expect(result.complete.status).toBe('unknown')
      expect(result.events.some(event => event.type === 'session-lost')).toBe(true)
      expect(() => driver.getSession(victim.id)).toThrow('disconnected')
      await driver.disconnect(victim.id)
      expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    } finally { await admin.close() }
  })
})
