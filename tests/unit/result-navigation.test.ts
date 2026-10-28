import { expect, it } from 'vitest'
import type { DatabaseEvent, ResultSet, SessionInfo } from '../../src/shared/contracts'
import { applyDatabaseEvent, emptyTabState, type QueryTabState } from '../../src/renderer/query-tabs'
import { preferredResult, resultCount, resultDescription } from '../../src/renderer/result-navigation'

const session: SessionInfo = { id: 's', engine: 'sqlite', name: 'Local', host: 'local', port: 1, user: '', database: ':memory:', transaction: 'idle', version: '', tls: false }
const result = (index: number, columns = false, rows: string[][] = []): ResultSet => ({ index, statement: columns ? `SELECT ${index}` : 'CREATE TABLE t(n)', columns: columns ? [{ name: 'n', typeId: 0 }] : [], rows, rowCount: rows.length, command: columns ? 'SELECT' : 'CREATE', truncated: false })
const metadata = (value: ResultSet): DatabaseEvent => { const { rows: _, ...data } = value; return { type: 'result', sessionId: 's', queryId: 'q', result: data } }
const done = (status: 'completed' | 'failed' | 'cancelled' | 'unknown'): DatabaseEvent => ({ type: 'complete', sessionId: 's', queryId: 'q', status, durationMs: 1, transaction: 'idle' })

it('prefers actual rows, then an empty tabular result, without renumbering native indexes', () => {
  const results: ResultSet[] = []; results[2] = result(2); results[5] = result(5, true)
  expect(preferredResult(results, 0)).toBe(5)
  results[7] = result(7, true, [['7']]); expect(preferredResult(results, 0)).toBe(7)
  expect(preferredResult([], 0)).toBe(0)
})
for (const status of ['completed', 'failed', 'cancelled', 'unknown'] as const) it(`retains the useful result and source through ${status} execution`, () => {
  let state: QueryTabState = { ...emptyTabState(), session, queryId: 'q', running: true }
  state = applyDatabaseEvent(state, metadata(result(0)))
  state = applyDatabaseEvent(state, metadata(result(1, true)))
  expect(state.activeResult).toBe(1)
  state = applyDatabaseEvent(state, metadata(result(2, true)))
  state = applyDatabaseEvent(state, { type: 'rows', sessionId: 's', queryId: 'q', index: 2, rows: [['2']] })
  state = applyDatabaseEvent(state, metadata({ ...result(2, true), rowCount: 1 }))
  state = applyDatabaseEvent(state, done(status))
  expect(state.activeResult).toBe(2); expect(state.results[2].rows).toEqual([['2']]); expect(state.results[2].statement).toBe('SELECT 2')
  expect(state.results[0].index).toBe(0); expect(state.showMessages).toBe(false)
})
it('preserves explicit result or Messages choices as later results and completion arrive', () => {
  for (const showMessages of [false, true]) {
    let state: QueryTabState = { ...emptyTabState(), session, queryId: 'q', running: true, resultSelectionChanged: true, showMessages }
    state = applyDatabaseEvent(state, metadata(result(0)))
    state = applyDatabaseEvent(state, metadata(result(1, true)))
    state = applyDatabaseEvent(state, { type: 'rows', sessionId: 's', queryId: 'q', index: 1, rows: [['1']] })
    state = applyDatabaseEvent(state, done('completed'))
    expect(state.activeResult).toBe(0); expect(state.showMessages).toBe(showMessages)
  }
  expect(emptyTabState().resultSelectionChanged).toBe(false)
})
it('distinguishes affected rows, empty SELECTs and limited fetched previews', () => {
  expect(resultCount({ ...result(0), command: 'UPDATE', rowCount: 12 })).toBe('12 rows affected')
  expect(resultCount(result(0))).toBe('Statement completed')
  expect(resultCount({ ...result(0), rowCount: null })).toBe('Statement completed')
  expect(resultCount(result(1, true))).toBe('0 rows fetched')
  const preview = { ...result(8, true, [['1']]), truncated: true, rowCount: 1205 }
  expect(resultDescription(preview)).toContain('1 row fetched'); expect(resultDescription(preview)).toContain('incomplete')
  expect(resultDescription(preview)).not.toContain('1,205 rows fetched'); expect(resultDescription(preview)).toContain('SELECT 8')
  const long = resultDescription({ ...preview, statement: 'SELECT ' + 'x'.repeat(1100) })
  expect(long).toContain('Source SQL excerpt: SELECT '); expect(long.endsWith('…')).toBe(true); expect(long.length).toBeLessThan(1200)
})
