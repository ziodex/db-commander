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
import { verifyObjectSource, verifyMacroSource } from './object-source-contract'
import { verifyDataTransfer } from './transfer-contract'
import { verifyTableBrowsing } from './browsing-contract'
import { verifyBackups } from './backup-contract'
import { verifyEditableGrid } from './grid-contract'
import { verifyLanguageTools } from './language-contract'
import { verifySessionIsolation } from './session-isolation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DriverRegistry } from '../../src/driver/registry'
import { tablePreviewSql } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'

if (!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('duckdb')) throw new Error('Run using pnpm test:integration --driver duckdb for real DuckDB contracts inside Docker.')
describe('Docker DuckDB driver contracts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-duckdb-'))
  const path = join(directory, 'analytics.duckdb')
  const config: ConnectionConfig = { engine: 'duckdb', name: 'Docker DuckDB', host: 'local', port: 1, database: 'DuckDB', user: 'local', password: '', tls: 'disable', filePath: path, duckdbMode: 'create' }
  let driver: DriverRegistry, session: SessionInfo, events: DatabaseEvent[] = []
  async function execute(sql: string, maxRows = 1000, id = session.id) {
    events = []
    const queryId = driver.start({ sessionId: id, sql, maxRows })
    await driver.wait(id)
    return { queryId, events: [...events], rows: events.flatMap(event => event.type === 'rows' ? event.rows : []), complete: events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }> }
  }
  const sets = (result: Awaited<ReturnType<typeof execute>>) => [...new Map(result.events.filter(event => event.type === 'result').map(event => [event.result.index, event.result])).values()]
  beforeAll(async () => {
    driver = new DriverRegistry(event => { events.push(event) })
    session = await driver.connect(config)
    const seed = await execute(`CREATE TABLE customers(id BIGINT PRIMARY KEY, name VARCHAR, balance DECIMAL(38,8));
      INSERT INTO customers VALUES(1,'Ada Lovelace',1250.50000000),(2,'Grace Hopper',9007199254740993.12345678);
      CREATE VIEW customer_names AS SELECT name FROM customers;`)
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
  it('reviews and applies a macro source edit', async () => { await verifyMacroSource(config) }, 180000)
  it('exports SQL INSERT scripts with exact values and explicit replay', async () => { await verifyInsertExport(config) }, 240000)
  it('imports JSON exports with exact values, source validation and atomic rollback', async () => { await verifyJsonImport(config) }, 240000)
  it('reviews new-table imports, JSON Lines and captured database copies without replay', async () => { await verifyTransferWorkflows(config) }, 240000)
  it('imports data atomically and streams full-result exports', async () => { await verifyDataTransfer(config) }, 240000)
  it('pages, filters and sorts live table data while preserving edit safety', async () => { await verifyTableBrowsing(config) }, 120000)
  it('edits rows atomically with primary keys, bound values and optimistic conflicts', async () => { await verifyEditableGrid(config) })
  it('completes real schema objects and executes equivalent formatted SQL', async () => { await verifyLanguageTools(config) })
  it('creates a real database with the pinned native engine and local session metadata', async () => {
    expect(session).toMatchObject({ engine: 'duckdb', database: 'analytics', port: 0, tls: false, transaction: 'idle', autocommit: true })
    expect(session.version).toBe('v1.5.6')
    // Inspect only closed database files: closing an unrelated descriptor to an
    // open DuckDB file can release process-scoped POSIX locks on the same inode.
    await driver.disconnect(session.id)
    expect(readFileSync(path).subarray(8, 12).toString()).toBe('DUCK')
    session = await driver.connect({ ...config, duckdbMode: 'read-write' })
    console.log(`Docker runtime ${process.versions.node}; DuckDB ${session.version}; ${process.platform}/${process.arch}`)
  })
  it('refuses missing/relative/non-database paths and never replaces an existing file', async () => {
    await expect(driver.connect(config)).rejects.toThrow('EEXIST')
    const missing = join(directory, 'missing.duckdb')
    for (const mode of ['read-only', 'read-write'] as const) await expect(driver.connect({ ...config, duckdbMode: mode, filePath: missing })).rejects.toThrow()
    expect(existsSync(missing)).toBe(false)
    await expect(driver.connect({ ...config, filePath: 'relative.duckdb' })).rejects.toThrow('absolute')
    await expect(driver.connect({ ...config, duckdbMode: 'read-write', filePath: directory })).rejects.toThrow('regular')
    const invalid = join(directory, 'invalid.duckdb'); writeFileSync(invalid, 'not a database')
    await expect(driver.connect({ ...config, duckdbMode: 'read-write', filePath: invalid })).rejects.toThrow()
    await expect(driver.connect({ ...config, filePath: invalid })).rejects.toThrow('EEXIST')
    expect(readFileSync(invalid, 'utf8')).toBe('not a database')
  })
  it('uses native parsing for macros, dollar quotes, nested comments and sequential schema dependencies', async () => {
    const result = await execute(`/* outer /* inner ; */ comment */ CREATE MACRO greeting() AS $$hello; world$$;
      CREATE TABLE parsed AS SELECT greeting() AS value; SELECT value FROM parsed; -- final comment ;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['hello; world']]); expect(sets(result)).toHaveLength(3)
    const invalid = await execute('DELETE FROM customers; SELECT (')
    expect(invalid.complete.status).toBe('failed')
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    expect((await execute('/* only comments */ ; -- nothing')).complete.status).toBe('failed')
    expect((await execute('SELECT 1;'.repeat(201))).complete.error).toContain('200 statements')
  })
  it('preserves HUGEINT, UBIGINT, exact decimals, nanoseconds, nested types, blobs, Unicode and duplicate aliases', async () => {
    const result = await execute(`SELECT 18446744073709551615::UBIGINT AS duplicate, 170141183460469231731687303715884105727::HUGEINT AS duplicate,
      12345678901234567890.123456789012345678::DECIMAL(38,18) AS precise,
      TIMESTAMP_NS '2026-10-12 12:34:56.123456789' AS timestamp_ns, DATE '0001-01-02' AS early_date,
      [9223372036854775807::BIGINT, NULL] AS list, {'big':9223372036854775807::BIGINT} AS structure,
      from_hex('00ff802c') AS binary, 'Hej 世界 👋' AS label, NULL AS missing, '' AS empty;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['18446744073709551615', '170141183460469231731687303715884105727', '12345678901234567890.123456789012345678',
      '2026-10-12 12:34:56.123456789', '0001-01-02', '[9223372036854775807, NULL]', "{'big': 9223372036854775807}", '0x00ff802c', 'Hej 世界 👋', null, '']])
    expect(sets(result)[0].columns.slice(0, 2).map(column => column.name)).toEqual(['duplicate', 'duplicate'])
    expect(sets(result)[0].columns[2].typeName).toBe('DECIMAL(38,18)')
  })
  it('retains connection-local temporary objects and variables across executions', async () => {
    expect((await execute('CREATE TEMP TABLE retained(value INT); INSERT INTO retained VALUES(42); SET VARIABLE answer = 43')).complete.status).toBe('completed')
    expect((await execute("SELECT value, getvariable('answer') FROM retained")).rows).toEqual([['42', '43']])
  })
  it('reports DML counts, empty results and multiple ordered RETURNING results without replay', async () => {
    const result = await execute('INSERT INTO retained VALUES(43),(44) RETURNING value; UPDATE retained SET value=value+1 WHERE value=44; CREATE TABLE empty_table(x INT); SELECT * FROM empty_table; SELECT count(*) FROM retained;')
    expect(result.complete.status, result.complete.error).toBe('completed')
    expect(result.rows).toEqual([['43'], ['44'], ['3']])
    expect(sets(result).map(result => result.rowCount)).toEqual([2, 1, 0, 0, 1])
    await execute('DELETE FROM retained WHERE value<>42')
  })
  it('tracks explicit transactions and transactional DDL from native transaction IDs', async () => {
    expect((await execute('START TRANSACTION; UPDATE retained SET value=99; CREATE TABLE rolled_back(x INT)')).complete.transaction).toBe('transaction')
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await driver.tables(session.id)).some(table => table.name === 'rolled_back')).toBe(true)
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['42']])
    expect((await driver.tables(session.id)).some(table => table.name === 'rolled_back')).toBe(false)
    expect((await execute('BEGIN; UPDATE retained SET value=43; COMMIT')).complete).toMatchObject({ status: 'completed', transaction: 'idle' })
  })
  it('distinguishes binder errors from aborted transactions and supports rollback recovery', async () => {
    await execute('BEGIN')
    expect((await execute('SELECT * FROM no_such_table')).complete).toMatchObject({ status: 'failed', transaction: 'transaction' })
    expect((await execute("SELECT CAST('bad' AS INT); DELETE FROM customers")).complete).toMatchObject({ status: 'failed', transaction: 'failed' })
    await expect(driver.disconnect(session.id)).rejects.toThrow('Commit or roll back')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    expect((await execute("SELECT CAST('bad' AS INT)")).complete).toMatchObject({ status: 'failed', transaction: 'idle' })
    // A user macro must not shadow the state probes.
    await execute('CREATE TEMP MACRO current_transaction_id() AS 0; BEGIN')
    expect(driver.getSession(session.id).transaction).toBe('transaction')
    expect((await execute('ROLLBACK')).complete.transaction).toBe('idle')
  })
  it('discovers attached catalogs, schemas, views and temporary tables with safe three-part previews', async () => {
    const result = await execute(`ATTACH '${join(directory, 'attached.duckdb')}' AS "odd""catalog";
      CREATE SCHEMA "odd""catalog"."odd""schema"; CREATE TABLE "odd""catalog"."odd""schema"."odd""table" AS SELECT 73 AS answer;`)
    expect(result.complete.status, result.complete.error).toBe('completed')
    const tables = await driver.tables(session.id)
    expect(tables).toContainEqual({ catalog: 'analytics', schema: 'main', name: 'customer_names', kind: 'view' })
    expect(tables).toContainEqual({ catalog: 'temp', schema: 'main', name: 'retained', kind: 'table' })
    const table = tables.find(table => table.catalog === 'odd"catalog')!
    expect(table).toMatchObject({ schema: 'odd"schema', name: 'odd"table', kind: 'table' })
    expect((await execute(tablePreviewSql(table.schema, table.name, 'duckdb', table.catalog))).rows).toEqual([['73']])
    expect((await execute('USE "odd""catalog"."odd""schema"')).complete.database).toBe('odd"catalog')
    await execute('USE analytics.main; DETACH "odd""catalog"')
  })
  it('drains bounded previews and RETURNING, caps retained bytes and remains usable', async () => {
    const result = await execute('SELECT range FROM range(100000)', 275)
    expect(result.rows).toHaveLength(275)
    expect(sets(result)[0]).toMatchObject({ rowCount: 100000, truncated: true })
    const bytes = await execute("SELECT repeat('x',1000000) FROM range(12)", 20)
    expect(bytes.rows).toHaveLength(8); expect(sets(bytes)[0]).toMatchObject({ rowCount: 12, truncated: true })
    await execute('CREATE TABLE returning_cap(value BIGINT)')
    const inserted = await execute('INSERT INTO returning_cap SELECT range FROM range(5000) RETURNING value', 7)
    expect(inserted.rows).toHaveLength(7); expect(sets(inserted)[0]).toMatchObject({ rowCount: 5000, truncated: true })
    expect((await execute('SELECT count(*) FROM returning_cap')).rows).toEqual([['5000']])
  })
  it('shares native file instances, isolates connection transactions and releases only the final reference', async () => {
    const alias = join(directory, 'hardlink.duckdb'); linkSync(path, alias)
    const other = await driver.connect({ ...config, duckdbMode: 'read-write', filePath: alias })
    try {
      await execute("BEGIN; UPDATE customers SET name='uncommitted' WHERE id=1")
      expect((await execute('SELECT name FROM customers WHERE id=1', 1, other.id)).rows).toEqual([['Ada Lovelace']])
      const conflict = await execute("UPDATE customers SET name='conflict' WHERE id=1", 1, other.id)
      expect(conflict.complete.status).toBe('failed'); expect(conflict.complete.error).toContain('Conflict')
      await execute('ROLLBACK')
      expect((await driver.tables(other.id)).some(table => table.name === 'retained')).toBe(false)
      await expect(driver.connect({ ...config, duckdbMode: 'read-only' })).rejects.toThrow('different access mode')
    } finally { await driver.disconnect(other.id) }
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
  })
  it('supports CSV and Parquet analytics without silently downloading extensions', async () => {
    const csv = join(directory, 'input.csv'), parquet = join(directory, 'output.parquet')
    writeFileSync(csv, 'id,name\n1,Ada\n2,Grace\n')
    const result = await execute(`COPY (SELECT * FROM read_csv('${csv}')) TO '${parquet}' (FORMAT PARQUET); SELECT name FROM read_parquet('${parquet}') ORDER BY id;`)
    expect(result.complete.status, result.complete.error).toBe('completed'); expect(result.rows).toEqual([['Ada'], ['Grace']])
    expect((await execute("SELECT current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions')")).rows).toEqual([['false', 'false']])
  })
  it('reports the native cross-process writer lock without damaging the open database', async () => {
    const script = `const { DuckDBInstance } = require('@duckdb/node-api');
      DuckDBInstance.create(process.argv[1]).then(db => { db.closeSync(); process.exitCode = 2 }, error => { console.log(error.message) })`
    const result = await promisify(execFile)(process.execPath, ['-e', script, path], { timeout: 10000 })
    expect(result.stdout).toContain('lock')
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
  })
  it('exports cached exact values and quoted CSV without re-executing mutations', async () => {
    const result = await execute("UPDATE retained SET value=value+1; SELECT value, 'a,b' AS text, 9223372036854775807::BIGINT AS id, NULL AS missing, '' AS empty FROM retained")
    const output = join(directory, 'result.csv')
    await driver.exportCsv(result.queryId, 1, output)
    expect(readFileSync(output, 'utf8')).toBe('"value","text","id","missing","empty"\r\n"44","a,b","9223372036854775807",,""\r\n')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['44']])
    expect(() => driver.exportCsv(result.queryId, 1, output)).toThrow('no longer available')
  })
  it('rejects unbound parameters and stops at the failed statement without replaying earlier SQL', async () => {
    const result = await execute('UPDATE retained SET value=value+1; SELECT $unbound; DELETE FROM customers')
    expect(result.complete.status).toBe('failed'); expect(result.complete.error).toContain('parameter binding')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['45']])
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
  })
  it('interrupts CPU-bound SQL, preserves the session and stops subsequent statements', async () => {
    await execute('BEGIN; UPDATE retained SET value=999')
    events = []
    driver.start({ sessionId: session.id, maxRows: 1, sql: 'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b; DELETE FROM customers;' })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 2', maxRows: 1 })).toThrow('running')
    await expect(driver.disconnect(session.id)).rejects.toThrow('running')
    await expect(driver.tables(session.id)).rejects.toThrow('Wait')
    expect((await driver.cancel(session.id)).requested).toBe(true)
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled', transaction: 'failed' })
    expect(events.some(event => event.type === 'session-lost')).toBe(false)
    await execute('ROLLBACK')
    expect((await execute('SELECT value FROM retained')).rows).toEqual([['45']])
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    expect((await driver.cancel(session.id)).requested).toBe(false)
  })
  it('cancels during renderer backpressure without poisoning the connection', async () => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const received: DatabaseEvent[] = []
    const slow = new DriverRegistry(async event => { received.push(event); if (event.type === 'rows') { entered(); await gate } })
    try {
      const memory = await slow.connect({ ...config, duckdbMode: 'memory' })
      slow.start({ sessionId: memory.id, sql: 'SELECT * FROM range(10000); CREATE TABLE should_not_run(x INT)', maxRows: 1000 })
      await waiting; await slow.cancel(memory.id); release(); await slow.wait(memory.id)
      expect(received.find(event => event.type === 'complete')).toMatchObject({ status: 'cancelled', transaction: 'idle' })
      expect(await slow.tables(memory.id)).toEqual([])
      received.length = 0; slow.start({ sessionId: memory.id, sql: 'SELECT 42', maxRows: 1 }); await slow.wait(memory.id)
      expect(received.find(event => event.type === 'rows')).toMatchObject({ rows: [['42']] })
    } finally { release(); await slow.close() }
  })
  it('keeps memory databases isolated and reopens persistent files in read-only mode', async () => {
    const memory = await driver.connect({ ...config, duckdbMode: 'memory' })
    expect(await driver.tables(memory.id)).toEqual([])
    await driver.disconnect(memory.id)
    await driver.disconnect(session.id)
    session = await driver.connect({ ...config, duckdbMode: 'read-only' })
    expect((await execute('SELECT count(*) FROM customers')).rows).toEqual([['2']])
    expect((await execute('DELETE FROM customers')).complete.status).toBe('failed')
    expect((await execute('CREATE TABLE forbidden(x INT)')).complete.status).toBe('failed')
    expect((await execute('BEGIN; SELECT count(*) FROM customers')).complete.transaction).toBe('transaction')
    await execute('ROLLBACK')
    // Read-only applies to this catalog. Local analytical file access remains intentional.
    const output = join(directory, 'readonly-export.csv')
    expect((await execute(`COPY customers TO '${output}' (HEADER)`)).complete.status).toBe('completed')
    expect(existsSync(output)).toBe(true)
  })
  it('interrupts on driver shutdown, rolls back open writes and releases the file lock', async () => {
    const file = join(directory, 'shutdown.duckdb'), received: DatabaseEvent[] = []
    const closing = new DriverRegistry(event => { received.push(event) })
    const victim = await closing.connect({ ...config, filePath: file })
    try {
      closing.start({ sessionId: victim.id, sql: 'CREATE TABLE durable(x INT); INSERT INTO durable VALUES(1); BEGIN; UPDATE durable SET x=2', maxRows: 1 })
      await closing.wait(victim.id)
      closing.start({ sessionId: victim.id, sql: 'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b', maxRows: 1 })
      await new Promise(resolve => setTimeout(resolve, 100))
    } finally { await closing.close() }
    expect(received.filter(event => event.type === 'complete').at(-1)).toMatchObject({ status: 'cancelled' })
    const reopened = await driver.connect({ ...config, duckdbMode: 'read-write', filePath: file })
    try { expect((await execute('SELECT * FROM durable', 1, reopened.id)).rows).toEqual([['1']]) }
    finally { await driver.disconnect(reopened.id) }
  })
})
