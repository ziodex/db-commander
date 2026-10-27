import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { currentExecution } from '../../src/language/execution'
import type { ConnectionConfig, DatabaseEvent, RunRequest } from '../../src/shared/contracts'

export async function verifyExecution(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-execution-')), events: DatabaseEvent[] = [], engine = config.engine
  const oracle = engine === 'oracle', tds = ['sqlserver', 'azure-sql'].includes(engine), embedded = ['sqlite', 'duckdb'].includes(engine)
  const local = { ...config, ...(embedded ? { filePath: join(directory, 'execution.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  // Include the result value in identifiers so cursor markers cannot silently
  // select an earlier INSERT when a random suffix happens to contain "42".
  const session = await driver.connect(local), suffix = '42_' + randomUUID().slice(0, 8), q = (s: string) => quoteIdentifier(s, engine)
  const table = q('exec_' + suffix), missing = q('missing_' + suffix), routine = q('routine_' + suffix), from = oracle ? ' FROM dual' : '', separator = tds ? '\r\nGO\r\n' : ';\r\n'
  async function run(sql: string, options: Partial<RunRequest> = {}, expected = 'completed') {
    const queryId = driver.start({ sessionId: session.id, sql, maxRows: 100, ...options }); await driver.wait(session.id)
    const execution = events.filter(event => 'queryId' in event && event.queryId === queryId)
    const complete = execution.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete?.status, complete?.error).toBe(expected)
    return { complete, rows: execution.flatMap(event => event.type === 'rows' ? event.rows : []),
      results: [...new Map(execution.flatMap(event => event.type === 'result' ? [[event.result.index, event.result] as const] : [])).values()],
      notices: execution.flatMap(event => event.type === 'notice' ? [event.message] : []) }
  }
  async function current(document: string, marker: string) {
    const offset = document.indexOf(marker)
    expect(offset, 'The current-statement cursor marker must exist.').toBeGreaterThanOrEqual(0)
    expect(document.lastIndexOf(marker), 'The current-statement cursor marker must be unique.').toBe(offset)
    const selected = currentExecution(document, offset, engine, session.mysqlSqlMode)
    return run(selected.sql, { singleUnit: true })
  }
  try {
    await run(`CREATE TABLE ${table} (${q('value')} INTEGER)`)
    const document = `INSERT INTO ${table} VALUES(1)${separator}SELECT 42${from}${separator}INSERT INTO ${table} VALUES(2)`
    expect((await current(document, 'SELECT 42')).rows).toEqual([['42']])
    expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['0']])
    // A malformed current request must fail before its first mutation.
    const multiple = `INSERT INTO ${table} VALUES(3)${separator}INSERT INTO ${table} VALUES(4)`
    if (embedded) await run(multiple, { singleUnit: true }, 'failed')
    else expect(() => driver.start({ sessionId: session.id, sql: multiple, singleUnit: true, maxRows: 10 })).toThrow('exactly one')
    expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['0']])
    if (engine === 'sqlite') {
      await run('PRAGMA foreign_keys=ON')
      await run('PRAGMA foreign_keys=OFF; SELECT 1', { singleUnit: true }, 'failed')
      expect((await run('PRAGMA foreign_keys')).rows).toEqual([['1']])
    }
    const bad = `SELECT * FROM ${missing}`, failing = `SELECT ${tds ? 'N' : ''}'😀'${from}${separator}  ${bad}${separator}INSERT INTO ${table} VALUES(5)`
    const failure = await run(failing, {}, 'failed')
    expect(failure.rows).toEqual([['😀']])
    expect(failure.complete.failure).toMatchObject({ start: failing.indexOf(bad), scope: tds ? 'batch' : 'statement' })
    expect(failing.slice(failure.complete.failure!.start, failure.complete.failure!.end).replace(/;$/, '')).toBe(bad)
    expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['0']])
    const bound = `SELECT :value FROM ${missing}`
    const boundFailure = await run(bound, { singleUnit: true, parameters: [{ name: 'value', type: 'integer', value: '42' }] }, 'failed')
    expect(boundFailure.complete.failure).toEqual({ start: 0, end: bound.length, scope: 'script' })
    // Current execution uses the existing session and transaction, never a new connection.
    if (!oracle) await run(tds ? 'BEGIN TRANSACTION' : 'BEGIN')
    expect((await current(`INSERT INTO ${table} VALUES(7)${separator}SELECT 0${from}`, 'VALUES')).complete.transaction).toBe('transaction')
    await run('ROLLBACK')
    expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['0']])
    if (tds) {
      const batch = 'DECLARE @answer INT=43; SELECT @answer;'
      const selected = await current(`${batch}\nGO 3\nSELECT 0`, '@answer;')
      expect(selected.rows).toEqual([['43']]); expect(selected.results).toHaveLength(1)
      expect(selected.notices).toContain('1 row affected.')
      const update = await run(`UPDATE ${table} SET ${q('value')}=1`)
      expect(update.results).toHaveLength(0); expect(update.notices).toContain('0 rows affected.')
    } else if (oracle) {
      await current(`BEGIN INSERT INTO ${table} VALUES(8); INSERT INTO ${table} VALUES(9); END;\n/\nSELECT 0 FROM dual;`, 'VALUES(9)')
      expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['2']]); await run('ROLLBACK')
    } else if (engine === 'mysql' || engine === 'mariadb') {
      await current(`DELIMITER $$\nCREATE PROCEDURE ${routine}() BEGIN INSERT INTO ${table} VALUES(8); INSERT INTO ${table} VALUES(9); END$$\nDELIMITER ;\nSELECT 0;`, 'VALUES(9)')
      await run(`CALL ${routine}()`); expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['2']])
      await run(`DROP PROCEDURE ${routine}`)
    } else if (engine === 'sqlite') {
      await current(`CREATE TRIGGER ${routine} AFTER INSERT ON ${table} WHEN new.${q('value')}=8 BEGIN UPDATE ${table} SET ${q('value')}=CASE WHEN 1 THEN 9 ELSE 10 END; END;\nSELECT 0;`, 'UPDATE')
      await run(`INSERT INTO ${table} VALUES(8)`); expect((await run(`SELECT ${q('value')} FROM ${table}`)).rows).toEqual([['9']])
    } else if (engine === 'postgres') {
      await current(`DO $$ BEGIN INSERT INTO ${table} VALUES(8); INSERT INTO ${table} VALUES(9); END $$;\nSELECT 0;`, 'VALUES(9)')
      expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['2']])
    } else {
      await current(`CREATE MACRO ${routine}() AS $$one;two$$; SELECT 0;`, 'one;two')
      expect((await run(`SELECT ${routine}()`)).rows).toEqual([['one;two']])
    }
    await run(`DROP TABLE ${table}`)
  } finally {
    try { await run('ROLLBACK') } catch {}
    try { await run(`DROP TABLE ${table}`) } catch {}
    if (engine === 'mysql' || engine === 'mariadb') try { await run(`DROP PROCEDURE IF EXISTS ${routine}`) } catch {}
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}
