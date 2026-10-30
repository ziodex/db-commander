import { verifyCrossEngineTransfer } from './transfer-cross-engine-contract'
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
import { verifyObjectSource, verifyTriggerSource } from './object-source-contract'
import { verifyDataTransfer } from './transfer-contract'
import { verifyTableBrowsing } from './browsing-contract'
import { verifyBackups } from './backup-contract'
import { verifyEditableGrid } from './grid-contract'
import { verifyLanguageTools } from './language-contract'
import { verifySessionIsolation } from './session-isolation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

if (!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlite')) throw new Error('Run using pnpm test:integration --driver sqlite for real SQLite contracts inside Docker.')
describe('Docker SQLite driver contracts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-sqlite-'))
  const path = join(directory, 'database.sqlite')
  const config: ConnectionConfig = { engine: 'sqlite', name: 'Docker SQLite', host: 'local', port: 1, database: 'SQLite', user: 'local', password: '', tls: 'disable', filePath: path, sqliteMode: 'create' }
  let driver: DriverRegistry, session: SessionInfo, events: DatabaseEvent[] = []
  async function execute(sql: string, maxRows = 1000, id = session.id) {
    events = []
    const queryId = driver.start({ sessionId: id, sql, maxRows })
    await driver.wait(id)
    return { queryId, events: [...events], rows: events.flatMap(event => event.type === 'rows' ? event.rows : []), complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }> }
  }
  beforeAll(async () => {
    driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
    session = await driver.connect(config)
    const seed = await execute(`CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance TEXT);
      INSERT INTO customers VALUES(1,'Ada Lovelace','1250.50000000'),(2,'Grace Hopper','9007199254740993.12345678');
      CREATE VIEW customer_names AS SELECT name FROM customers;
      CREATE TABLE numbers(n INTEGER PRIMARY KEY);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO numbers SELECT x FROM n;`)
    expect(seed.complete.status, seed.complete.error).toBe('completed')
  })
  afterAll(async () => { await driver?.close(); rmSync(directory, { recursive: true, force: true }) })

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
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  for (const engine of ['sqlite','duckdb'] as const) it(`captures ${engine} cross-engine copies with expiry and cancellation safeguards`, async () => { await verifyCrossEngineTransfer(engine) }, 30000)
  it('reviews new-table imports, JSON Lines and captured database copies without replay', async () => { await verifyTransferWorkflows(config) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('creates a real file, routes the driver and reports the native SQLite version', () => {
    expect(session.engine).toBe('sqlite'); expect(session.version).toMatch(/^3\./); expect(session.tls).toBe(false)
    expect(readFileSync(path).subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    console.log(`Docker runtime ${process.versions.node}; SQLite ${session.version}`)
  })
  it('refuses missing files, relative paths, directories, invalid databases and overwriting an existing file', async () => {
    await expect(driver.connect(config)).rejects.toThrow('EEXIST')
    const missing = join(directory, 'missing.sqlite')
    await expect(driver.connect({ ...config, sqliteMode: 'read-write', filePath: missing })).rejects.toThrow()
    expect(existsSync(missing)).toBe(false)
    await expect(driver.connect({ ...config, sqliteMode: 'read-only', filePath: missing })).rejects.toThrow()
    await expect(driver.connect({ ...config, filePath: 'relative.sqlite' })).rejects.toThrow('absolute')
    await expect(driver.connect({ ...config, sqliteMode: 'read-write', filePath: directory })).rejects.toThrow('regular')
    const invalid = join(directory, 'invalid.sqlite'); writeFileSync(invalid, 'this is not a database')
    await expect(driver.connect({ ...config, sqliteMode: 'read-write', filePath: invalid })).rejects.toThrow()
    expect(readFileSync(invalid, 'utf8')).toBe('this is not a database')
  })
  it('preserves 64-bit integers, duplicate aliases, Unicode, blobs, text decimals, JSON, NULL and empty strings', async () => {
    const result = await execute(`SELECT 9223372036854775807 AS duplicate, -9223372036854775808 AS duplicate,
      '12345678901234567890.123456789012345678' AS precise_text, 0.25 AS real_value, '2026-10-12T12:34:56.1234567' AS date_text,
      X'00ff802c' AS binary, 'Hej 世界 👋' AS label, json_object('big',9223372036854775807) AS document, NULL AS missing, '' AS empty;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['9223372036854775807', '-9223372036854775808', '12345678901234567890.123456789012345678', '0.25', '2026-10-12T12:34:56.1234567', '0x00ff802c', 'Hej 世界 👋', '{"big":9223372036854775807}', null, '']])
    expect(result.events.filter(event => event.type === 'result')[0].result.columns.slice(0, 2).map(column => column.name)).toEqual(['duplicate', 'duplicate'])
  })
  it('retains connection-local temporary tables across executions', async () => {
    expect((await execute('CREATE TEMP TABLE retained(value INTEGER); INSERT INTO retained VALUES(41)')).complete.status).toBe('completed')
    expect((await execute('SELECT value+1 FROM retained')).rows).toEqual([['42']])
  })
  it('uses SQLite parser boundaries for triggers, CASE expressions, comments and semicolons in strings', async () => {
    const result = await execute(`CREATE TABLE audit(message TEXT);
      CREATE TRIGGER audit_customer AFTER UPDATE ON customers BEGIN
        INSERT INTO audit VALUES(CASE WHEN NEW.id=1 THEN 'semi;colon' ELSE 'other' END);
        INSERT INTO audit VALUES('second;entry');
      END;
      -- trigger body ended
      UPDATE customers SET name=name WHERE id=1;
      SELECT message FROM audit; /* trailing */`)
    expect(result.complete.status, result.complete.error).toBe('completed'); expect(result.rows).toEqual([['semi;colon'], ['second;entry']])
    const count = await execute('UPDATE retained SET value=42; CREATE TABLE ddl_count(id INT); SELECT changes(), last_insert_rowid();')
    const results = new Map(count.events.filter(event => event.type === 'result').map(event => [event.result.index, event.result]))
    expect([...results.values()].slice(0, 2).map(result => result.rowCount)).toEqual([1, 0])
    expect(count.rows[0][0]).toBe('1')
  })
  it('supports RETURNING and multiple ordered results without re-execution', async () => {
    const result = await execute('INSERT INTO retained VALUES(43),(44) RETURNING value; SELECT count(*) FROM retained; SELECT 1 WHERE 0;')
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['43'], ['44'], ['3']])
    const sets = new Map(result.events.filter(event => event.type === 'result').map(event => [event.result.index, event.result]))
    expect([...sets.values()].map(result => result.rowCount)).toEqual([2, 1, 0])
    await execute('DELETE FROM retained WHERE value<>42')
  })
  it('tracks BEGIN, savepoints, commit, rollback and transactional DDL from engine state', async () => {
    expect((await execute('BEGIN; UPDATE retained SET value=99; SAVEPOINT point1; UPDATE retained SET value=100; ROLLBACK TO point1; SELECT value FROM retained')).rows).toEqual([['99']])
    expect(driver.getSession(session.id).transaction).toBe('transaction')
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['42']])
    expect((await execute('SAVEPOINT outermost; UPDATE retained SET value=43; RELEASE outermost')).complete.transaction).toBe('idle')
    await execute('BEGIN; CREATE TABLE rolled_back(id INT); ROLLBACK')
    expect((await execute("SELECT count(*) FROM sqlite_schema WHERE name='rolled_back'")).rows).toEqual([['0']])
    expect((await execute('BEGIN; UPDATE retained SET value=44; COMMIT')).complete.transaction).toBe('idle')
  })
  it('handles statement errors, failed COMMIT and automatic rollback without guessing transaction state', async () => {
    await execute('BEGIN')
    const failure = await execute("INSERT INTO customers VALUES(1,'duplicate','0'); UPDATE retained SET value=999")
    expect(failure.complete).toMatchObject({ status: 'failed', transaction: 'transaction' })
    await execute('ROLLBACK')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
    const rolled = await execute("BEGIN; INSERT OR ROLLBACK INTO customers VALUES(1,'duplicate','0')")
    expect(rolled.complete).toMatchObject({ status: 'failed', transaction: 'idle' })
    await execute('CREATE TABLE children(parent INTEGER REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED); BEGIN; INSERT INTO children VALUES(999)')
    expect((await execute('COMMIT')).complete).toMatchObject({ status: 'failed', transaction: 'transaction' })
    await execute('ROLLBACK')
  })
  it('enforces read-only mode, including attempts to disable it or attach writable files', async () => {
    const readonly = await driver.connect({ ...config, sqliteMode: 'read-only' })
    try {
      expect((await execute('SELECT count(*) FROM customers', 1000, readonly.id)).rows).toEqual([['2']])
      for (const sql of ["INSERT INTO customers VALUES(3,'bad','0')", 'PRAGMA query_only=OFF', `ATTACH '${join(directory, 'readonly-escape.sqlite')}' AS other`, `VACUUM INTO '${join(directory, 'readonly-copy.sqlite')}'`]) expect((await execute(sql, 1000, readonly.id)).complete.status).toBe('failed')
      expect(existsSync(join(directory, 'readonly-escape.sqlite'))).toBe(false)
      expect(existsSync(join(directory, 'readonly-copy.sqlite'))).toBe(false)
    } finally { await driver.disconnect(readonly.id) }
  })
  it('discovers main, temp and attached tables/views with safely quoted identifiers', async () => {
    await execute(`ATTACH '${join(directory, 'attached.sqlite')}' AS "odd\"\"schema"; CREATE TABLE "odd\"\"schema"."odd\"\"table"(value TEXT);`)
    const tables = await driver.tables(session.id)
    expect(tables).toContainEqual({ schema: 'main', name: 'customer_names', kind: 'view' })
    expect(tables).toContainEqual({ schema: 'temp', name: 'retained', kind: 'table' })
    expect(tables).toContainEqual({ schema: 'odd"schema', name: 'odd"table', kind: 'table' })
    await execute('DETACH "odd\"\"schema"')
  })
  it('drains bounded previews, preserves actual row counts and caps retained bytes', async () => {
    const result = await execute('SELECT a.n FROM numbers a CROSS JOIN numbers b LIMIT 100000', 275)
    expect(result.complete.status, result.complete.error).toBe('completed'); expect(result.rows).toHaveLength(275)
    expect(result.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { rowCount: 100000, truncated: true } })
    const bytes = await execute("SELECT printf('%1000000s','x') AS large_value FROM numbers LIMIT 12", 20)
    expect(bytes.rows).toHaveLength(8)
    expect(bytes.events.filter(event => event.type === 'result').at(-1)).toMatchObject({ result: { truncated: true } })
    expect((await execute('SELECT 1')).rows).toEqual([['1']])
  })
  it('reports busy locks without hanging other connections or losing the blocked session', async () => {
    const other = await driver.connect({ ...config, sqliteMode: 'read-write' })
    try {
      await execute('BEGIN IMMEDIATE')
      const locked = await execute("INSERT INTO customers VALUES(3,'blocked','0')", 1000, other.id)
      expect(locked.complete).toMatchObject({ status: 'failed', code: '5', transaction: 'idle' })
      await execute('ROLLBACK')
      expect((await execute('SELECT count(*) FROM customers', 1000, other.id)).rows).toEqual([['2']])
    } finally { await driver.disconnect(other.id) }
  })
  it('exports cached fetched rows with exact values and never replays SQL', async () => {
    const result = await execute("UPDATE retained SET value=value+1; SELECT value AS count, 'a,b' AS text, 9007199254740993 AS id, NULL AS missing, '' AS empty FROM retained")
    const output = join(directory, 'result.csv')
    await driver.exportCsv(result.queryId, 1, output)
    expect(readFileSync(output, 'utf8')).toBe('"count","text","id","missing","empty"\r\n"45","a,b","9007199254740993",,""\r\n')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['45']])
    expect(() => driver.exportCsv(result.queryId, 1, output)).toThrow('no longer available')
  })
  it('rejects unbound parameters before side effects and disables native extensions', async () => {
    expect(() => driver.start({ sessionId: session.id, sql: 'DELETE FROM customers; SELECT ?', maxRows: 1 })).toThrow('parameter')
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    expect((await execute("SELECT load_extension('/tmp/not-a-library')")).complete.status).toBe('failed')
  })
  it('supports isolated in-memory databases and persistent reconnects', async () => {
    const memory = await driver.connect({ ...config, sqliteMode: 'memory', filePath: undefined })
    try {
      expect((await execute('CREATE TABLE memory_only(x); INSERT INTO memory_only VALUES(7)', 1000, memory.id)).complete.status).toBe('completed')
      expect((await driver.tables(memory.id)).some(table => table.name === 'memory_only')).toBe(true)
      expect((await driver.tables(session.id)).some(table => table.name === 'memory_only')).toBe(false)
    } finally { await driver.disconnect(memory.id) }
    const reopened = await driver.connect({ ...config, sqliteMode: 'read-write' })
    try { expect((await execute('SELECT count(*) FROM customers', 1000, reopened.id)).rows).toEqual([['2']]) }
    finally { await driver.disconnect(reopened.id) }
  })
  it('stops a CPU-bound native step, ends only its session, rolls back open writes and never replays remaining SQL', async () => {
    const victim = await driver.connect({ ...config, sqliteMode: 'read-write' })
    await execute("BEGIN; UPDATE customers SET name='uncommitted' WHERE id=1", 1000, victim.id)
    events = []
    driver.start({ sessionId: victim.id, maxRows: 1, sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n; DELETE FROM customers;" })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => driver.start({ sessionId: victim.id, sql: 'SELECT 2', maxRows: 1 })).toThrow('running')
    await expect(driver.disconnect(victim.id)).rejects.toThrow('running')
    await expect(driver.tables(victim.id)).rejects.toThrow('Wait')
    expect((await driver.cancel(victim.id)).requested).toBe(true)
    await expect.poll(() => events.some(event => event.type === 'session-lost' && event.sessionId === victim.id)).toBe(true)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'unknown', transaction: 'unknown' })
    expect(() => driver.getSession(victim.id)).toThrow('disconnected')
    await driver.disconnect(victim.id)
    const recovered = await execute('SELECT name FROM customers ORDER BY id')
    expect(recovered.rows).toEqual([['Ada Lovelace'], ['Grace Hopper']])
  })
})
