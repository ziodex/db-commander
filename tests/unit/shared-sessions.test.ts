import { expect, it } from 'vitest'
import { type SessionInfo } from '../../src/shared/contracts'
import { canCloseTab, emptyTabState, tabOperationBusy } from '../../src/renderer/query-tabs'
import { patchSessionState, reconcileSessionBusy, sessionOwners } from '../../src/renderer/shared-sessions'

const session: SessionInfo = { id: 'memory', engine: 'sqlite', name: 'Memory', database: ':memory:', host: ':memory:', port: 0, user: 'local', tls: false, version: '', transaction: 'idle' }
const tab = () => ({ ...emptyTabState(), session })

it('locks only peers sharing a busy connection and releases them when it settles', () => {
  const states = { source: tab(), browse: tab(), separate: { ...tab(), session: { ...session, id: 'other' } } }
  let next = reconcileSessionBusy(patchSessionState(states, 'browse', { gridBusy: true }))
  expect(tabOperationBusy(next.source)).toBe(true)
  expect(canCloseTab(next.source)).toContain('other tab')
  expect(next.browse.sharedSessionBusy).toBeFalsy()
  expect(next.source.gridExpired).toBe(false)
  expect(tabOperationBusy(next.separate)).toBe(false)
  next = reconcileSessionBusy(patchSessionState(next, 'browse', { gridBusy: false }))
  expect(tabOperationBusy(next.source)).toBe(false)
  next = reconcileSessionBusy(patchSessionState(next, 'browse', { gridChanges: [{ kind: 'delete', row: 0 }] }))
  expect(tabOperationBusy(next.source)).toBe(true)
})

it('shares transaction and schema state without replacing another tab’s results', () => {
  const states = { source: { ...tab(), queryId: 'source-query', status: 'Completed' }, browse: tab() }
  const next = patchSessionState(states, 'browse', { session: { ...session, transaction: 'transaction' }, running: true, queryId: 'browse-query' })
  expect(next.source.session?.transaction).toBe('transaction')
  expect(next.source.queryId).toBe('source-query')
  expect(next.source.status).toBe('Completed')
  expect(next.source.gridExpired).toBe(true)
  expect(canCloseTab(next.source)).toContain('Commit or roll back')
})

it('detaches one tab without clearing the remaining owner’s connection or schema', () => {
  const tables = [{ schema: 'main', name: 'orders', kind: 'table' }]
  const states = { source: tab(), browse: { ...tab(), tables } }
  const next = patchSessionState(states, 'source', { session: null, tables: [], schema: null })
  expect(sessionOwners(next, session.id)).toEqual(['browse'])
  expect(next.browse.tables).toBe(tables)
  expect(next.browse.session).toBe(session)
})
