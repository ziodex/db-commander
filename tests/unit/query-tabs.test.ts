import { expect, it } from 'vitest'
import { applyDatabaseEvent, canCloseTab, emptyTabState } from '../../src/renderer/query-tabs'
import { SessionResultCache } from '../../src/driver/result-cache'
import type { DatabaseEvent, SessionInfo } from '../../src/shared/contracts'
const session = (id: string): SessionInfo => ({ id, engine: 'postgres', name: id, database: 'db', host: 'local', port: 1, user: 'user', tls: false, transaction: 'idle', version: '' })
it('shows count-only completion messages while preserving actual empty SELECT results', () => {
  const state = { ...emptyTabState(), session: session('a'), queryId: 'q', running: true, messages: ['2 rows affected.'] }
  const done: DatabaseEvent = { type: 'complete', sessionId: 'a', queryId: 'q', status: 'completed', durationMs: 1, transaction: 'idle' }
  expect(applyDatabaseEvent(state, done)).toMatchObject({ showMessages: true, results: [], messages: ['2 rows affected.'] })
  const withRows = applyDatabaseEvent(state, { type: 'result', sessionId: 'a', queryId: 'q', result: { index: 0, statement: 'SELECT 1 WHERE 1=0', columns: [{ name: 'n', typeId: 0 }], command: 'SELECT', rowCount: 0, truncated: false } })
  expect(applyDatabaseEvent(withRows, done)).toMatchObject({ showMessages: false })
})
it('routes rows, errors, completion and transaction state only to the owning session and current execution', () => {
  const a = { ...emptyTabState(), session: session('a'), queryId: 'qa', running: true }, b = { ...emptyTabState(), session: session('b'), queryId: 'qb', running: true }
  const event: DatabaseEvent = { type: 'complete', sessionId: 'a', queryId: 'qa', status: 'failed', error: 'constraint', durationMs: 3, transaction: 'failed' }
  expect(applyDatabaseEvent(b, event)).toBe(b)
  expect(applyDatabaseEvent(a, { ...event, queryId: 'old' })).toBe(a)
  expect(applyDatabaseEvent(a, event)).toMatchObject({ running: false, error: 'constraint', session: { transaction: 'failed' } })
  const metadata: DatabaseEvent = { type: 'result', sessionId: 'a', queryId: 'qa', result: { index: 0, statement: 'SELECT 1', columns: [{ name: 'n', typeId: 0 }], command: 'SELECT', rowCount: 1, truncated: false } }
  const result = applyDatabaseEvent(applyDatabaseEvent(a, metadata), { type: 'rows', sessionId: 'a', queryId: 'qa', index: 0, rows: [['1']] })
  expect(result.results[0].rows).toEqual([['1']]); expect(applyDatabaseEvent(b, metadata)).toBe(b)
})
it('isolates session loss but resets every live tab on host loss', () => {
  const a = { ...emptyTabState(), session: session('a'), running: true }, b = { ...emptyTabState(), session: session('b') }
  const lost: DatabaseEvent = { type: 'session-lost', sessionId: 'a', message: 'lost' }
  expect(applyDatabaseEvent(a, lost)).toMatchObject({ session: null, running: false })
  expect(applyDatabaseEvent(b, lost)).toBe(b)
  expect(applyDatabaseEvent(b, { type: 'host-lost', message: 'host' })).toMatchObject({ session: null, status: 'Disconnected' })
})
it('guards closing running, connecting, failed and unknown transaction tabs', () => {
  expect(canCloseTab(emptyTabState())).toBeUndefined()
  expect(canCloseTab({ ...emptyTabState(), running: true })).toContain('Stop')
  expect(canCloseTab({ ...emptyTabState(), connecting: true })).toContain('Wait')
  for (const transaction of ['transaction', 'failed', 'unknown'] as const) expect(canCloseTab({ ...emptyTabState(), session: { ...session('a'), transaction } })).toContain('Commit or roll back')
})
it('clears column views and navigation when the connection state is reset by merging defaults', () => {
  const previous = { ...emptyTabState(), columnViews: { old: { order: [0], hidden: [], pinned: [], widths: { 0: 320 } } }, gridBack: [{ table: { schema: 'old', name: 'parent' }, query: { offset: 25, pageSize: 25 as const, filters: [], sort: [] } }] }
  expect({ ...previous, ...emptyTabState() }).toMatchObject({ columnViews: {}, gridBack: [] })
  expect(Object.keys({ ...previous, ...emptyTabState() }.columnViews!)).toHaveLength(0)
})
it('keeps one export cache per session and frees only the replaced or closed session', () => {
  const cache = new SessionResultCache()
  cache.begin('a', 'qa'); const a = cache.get('qa')!
  cache.begin('b', 'qb'); expect(cache.get('qa')).toBe(a)
  cache.begin('b', 'qb2'); expect(cache.get('qb')).toBeUndefined(); expect(cache.get('qa')).toBe(a)
  cache.forget('a'); expect(cache.get('qa')).toBeUndefined(); expect(cache.get('qb2')).toEqual([])
})
it('keeps failure ranges with the owning execution and clears them after cancellation or a reset', () => {
  const execution = { document: 'SELECT missing', sql: 'SELECT missing', start: 0, end: 14, prefixLength: 0 }
  const initial = { ...emptyTabState(), session: session('a'), queryId: 'new', execution }
  const event: DatabaseEvent = { type: 'complete', sessionId: 'a', queryId: 'new', status: 'failed', error: 'missing', durationMs: 1, transaction: 'idle', failure: { start: 0, end: 14, scope: 'statement' } }
  const failed = applyDatabaseEvent(initial, event)
  expect(failed.failure).toEqual(event.failure)
  expect(applyDatabaseEvent(failed, { ...event, queryId: 'old', failure: undefined })).toBe(failed)
  expect(applyDatabaseEvent(failed, { ...event, status: 'cancelled' }).failure).toBeUndefined()
  expect(applyDatabaseEvent(initial, { ...event, failure: undefined }).failure).toEqual({ start: 0, end: 14, scope: 'script' })
  expect({ ...failed, ...emptyTabState() }).toMatchObject({ execution: undefined, failure: undefined })
})
