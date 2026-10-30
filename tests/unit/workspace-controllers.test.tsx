// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type DatabaseEvent, type DesktopApi, type GridSnapshot, type SessionInfo, type Workspace, type WorkspaceTab } from '../../src/shared/contracts'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/shared/editor-settings'
import { emptyTabState } from '../../src/renderer/query-tabs'
import { useQueryExecution } from '../../src/renderer/use-query-execution'
import { useTabRuntime } from '../../src/renderer/use-tab-runtime'
import { useTableData } from '../../src/renderer/use-table-data'
import { useWorkspaceSessions } from '../../src/renderer/use-workspace-sessions'
import { useWorkspaceTabs } from '../../src/renderer/use-workspace-tabs'
import type { WorkspaceRuntime } from '../../src/renderer/workspace-runtime'

afterEach(cleanup)

const session: SessionInfo = { id: 'connection', engine: 'sqlite', name: 'Memory', database: ':memory:', user: 'local', host: ':memory:', port: 0, tls: false, transaction: 'idle', version: '' }
const profile = { ...DEFAULT_PROFILE, engine: 'sqlite' as const, sqlitePath: ':memory:' }
const tab = (id: string): WorkspaceTab => ({ id, title: `${id}.sql`, sql: 'SELECT 1', profile })
const grid: GridSnapshot = { id: 'snapshot', table: { schema: 'main', name: 'items' }, columns: [], rows: [], truncated: false, query: { filters: [], sort: [], offset: 0, pageSize: 25 }, mode: 'edit' }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const listeners = new Set<(event: DatabaseEvent) => void>()
  const api = {
    history: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn((listener: (event: DatabaseEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) }),
    run: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(session),
    cloneSession: vi.fn().mockResolvedValue({ ...session, id: 'independent' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    editGrid: vi.fn().mockResolvedValue({ session }),
    databases: vi.fn().mockResolvedValue({ current: ':memory:', databases: [] }),
    schema: vi.fn().mockResolvedValue({ objects: [], database: ':memory:', source: 'session', fetchedAt: '', truncated: false }),
    exportCsv: vi.fn().mockResolvedValue('preview.csv'),
    saveProfilePassword: vi.fn().mockResolvedValue(undefined),
    removeProfilePassword: vi.fn().mockResolvedValue(undefined),
    switchDatabase: vi.fn().mockResolvedValue({ ...session, id: 'switched' })
  }
  const persist = vi.fn().mockResolvedValue(undefined), forget = vi.fn().mockResolvedValue(undefined)
  const hook = renderHook(() => {
    const [workspace, setWorkspace] = useState<Workspace>({ version: 2, activeTabId: 'a', profiles: [], tabs: [tab('a'), tab('b')] })
    const workspaceRef = useRef(workspace), readyRef = useRef(true), editors = useRef(new Map())
    const editorRef = useRef(null)
    function changeWorkspace(update: (previous: Workspace) => Workspace) {
      const next = update(workspaceRef.current)
      workspaceRef.current = next
      setWorkspace(next)
    }
    const state = useTabRuntime(workspaceRef)
    const runtime: WorkspaceRuntime = { ...state, workspaceRef, changeWorkspace, persist,
      patchTab: (id, patch) => changeWorkspace(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab) })) }
    const active = workspace.tabs.find(tab => tab.id === workspace.activeTabId)!
    const desktopApi = api as unknown as DesktopApi
    const sqlFiles = { files: {}, busy: false, forget }
    const sessions = useWorkspaceSessions({ api: desktopApi, runtime, tab: active, readyRef, sqlFiles, editorSettings: DEFAULT_EDITOR_SETTINGS })
    const tabs = useWorkspaceTabs({ api: desktopApi, runtime, ready: true, sqlFiles, sessions, editorSettings: DEFAULT_EDITOR_SETTINGS })
    const query = useQueryExecution({ api: desktopApi, runtime, tab: active, editorRef, sessions })
    const tables = useTableData({ api: desktopApi, runtime, workspace, tab: active, ready: true, readyRef, editors,
      sqlFiles, closeId: tabs.closeId, newTab: tabs.newTab, changeLayout: () => {}, focusEditor: () => {} })
    return { runtime, workspace, sessions, tabs, query, tables }
  })
  const emit = (event: DatabaseEvent) => { for (const listener of listeners) listener(event) }
  return { ...hook, api, persist, forget, emit, listeners }
}

it('routes late query events to the original tab after switching views without resubscribing', async () => {
  const hook = setup()
  await act(async () => {})
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  await act(async () => { await hook.result.current.query.run('SELECT 1') })
  const queryId = hook.result.current.runtime.statesRef.current.a.queryId
  act(() => hook.result.current.runtime.changeWorkspace(previous => ({ ...previous, activeTabId: 'b' })))
  await act(async () => {
    hook.emit({ type: 'result', sessionId: session.id, queryId, result: { index: 0, statement: 'SELECT 1', columns: [{ name: 'value', typeId: 0 }], rowCount: null, command: 'SELECT', truncated: false } })
    hook.emit({ type: 'rows', sessionId: session.id, queryId, index: 0, rows: [['900719925474099312345']] })
    hook.emit({ type: 'complete', sessionId: session.id, queryId, status: 'completed', durationMs: 2, transaction: 'idle' })
  })
  expect(hook.result.current.runtime.statesRef.current.a.results[0].rows).toEqual([['900719925474099312345']])
  expect(hook.result.current.runtime.statesRef.current.b).toBeUndefined()
  expect(hook.api.onEvent).toHaveBeenCalledTimes(1)
  hook.unmount()
  expect(hook.listeners.size).toBe(0)
})

it('discards a rejected execution acknowledgment after a newer query starts', async () => {
  const hook = setup(), first = deferred<void>()
  hook.api.run.mockReturnValueOnce(first.promise)
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.query.run('SELECT 1') })
  act(() => hook.result.current.runtime.patchState('a', { running: false }))
  await act(async () => { await hook.result.current.query.run('SELECT 2') })
  const currentId = hook.result.current.runtime.statesRef.current.a.queryId
  await act(async () => { first.reject(new Error('old query failed')); await pending })
  expect(hook.result.current.runtime.statesRef.current.a).toMatchObject({ queryId: currentId, running: true, error: '', status: 'Running' })
})

it('disconnects a pending physical connection when the host generation changes', async () => {
  const hook = setup(), connecting = deferred<SessionInfo>()
  hook.api.connect.mockReturnValueOnce(connecting.promise)
  let pending!: Promise<SessionInfo | undefined>
  act(() => { pending = hook.result.current.sessions.connect({ ...profile, password: '' }, false) })
  await act(async () => {
    hook.emit({ type: 'host-lost', message: 'Host stopped' })
    connecting.resolve({ ...session, id: 'late-connection' })
    await pending
  })
  expect(hook.api.disconnect).toHaveBeenCalledWith('late-connection')
  expect(hook.result.current.runtime.statesRef.current.a.session).toBeNull()
  expect(hook.api.schema).not.toHaveBeenCalled()
})

it('disconnects a pending independent clone when its tab disappears', async () => {
  const hook = setup(), cloning = deferred<SessionInfo>()
  hook.api.cloneSession.mockReturnValueOnce(cloning.promise)
  let pending!: Promise<SessionInfo | undefined>
  act(() => { pending = hook.result.current.sessions.openIndependentConnection('a', session.id) })
  act(() => hook.result.current.runtime.changeWorkspace(previous => ({ ...previous, tabs: [tab('b')], activeTabId: 'b' })))
  await act(async () => { cloning.resolve({ ...session, id: 'late-clone' }); await pending })
  expect(hook.api.disconnect).toHaveBeenCalledWith('late-clone')
  expect(hook.api.databases).not.toHaveBeenCalled()
})

it('retries lost-session cleanup after the final completion releases the operation lock', async () => {
  const hook = setup()
  hook.api.disconnect.mockRejectedValueOnce(new Error('Operation pending'))
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session, queryId: 'query', running: true }))
  await act(async () => { hook.emit({ type: 'session-lost', sessionId: session.id, message: 'Lost' }) })
  await act(async () => { hook.emit({ type: 'complete', sessionId: session.id, queryId: 'query', status: 'failed', transaction: 'idle', durationMs: 1 }) })
  expect(hook.api.disconnect).toHaveBeenCalledTimes(2)
  expect(hook.result.current.runtime.statesRef.current.a.session).toBeNull()
})

it('releases a shared view on close and disconnects only the last owner', async () => {
  const hook = setup()
  act(() => {
    hook.result.current.runtime.patchState('a', { ...emptyTabState(), session })
    hook.result.current.runtime.patchState('b', { ...emptyTabState(), session })
  })
  await act(async () => { await hook.result.current.tabs.closeTabs(['a']) })
  expect(hook.api.editGrid).toHaveBeenCalledWith({ action: 'release', sessionId: session.id, viewId: 'a' })
  expect(hook.api.disconnect).not.toHaveBeenCalled()
  expect(hook.result.current.runtime.statesRef.current.b.session?.id).toBe(session.id)
  await act(async () => { await hook.result.current.tabs.closeTabs(['b']) })
  expect(hook.api.disconnect).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(hook.forget.mock.calls.map(args => args[0])).toEqual(['a', 'b'])
  expect(hook.persist).toHaveBeenCalledTimes(2)
  expect(hook.result.current.workspace.tabs).toHaveLength(1)
})

it('keeps transaction and staged-edit guards across controller boundaries', async () => {
  const hook = setup()
  act(() => {
    hook.result.current.runtime.patchState('a', { ...emptyTabState(), session: { ...session, transaction: 'transaction' } })
    hook.result.current.runtime.patchState('b', { ...emptyTabState(), session: { ...session, transaction: 'transaction' } })
  })
  await act(async () => { await hook.result.current.tabs.closeTabs(['a']) })
  expect(hook.result.current.runtime.statesRef.current.a.error).toContain('Commit or roll back')
  act(() => hook.result.current.runtime.patchState('a', { grid, gridChanges: [{ kind: 'delete', row: 0 }] }))
  await act(async () => { await hook.result.current.query.run('DELETE FROM items') })
  await act(async () => { await hook.result.current.tables.openGrid({ schema: 'main', name: 'other' }) })
  expect(hook.api.disconnect).not.toHaveBeenCalled()
  expect(hook.api.run).not.toHaveBeenCalled()
  expect(hook.api.editGrid).not.toHaveBeenCalled()
  expect(hook.result.current.runtime.statesRef.current.b.sharedSessionBusy).toBe(true)
})

it('keeps shared and independent tab creation on their separate session paths', async () => {
  const hook = setup()
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  act(() => { hook.result.current.tabs.newTab() })
  expect(hook.api.cloneSession).not.toHaveBeenCalled()
  const sharedId = hook.result.current.workspace.activeTabId
  expect(hook.result.current.runtime.statesRef.current[sharedId].session?.id).toBe(session.id)
  await act(async () => { await hook.result.current.tabs.newTab(undefined, undefined, 'independent')?.connected })
  const independentId = hook.result.current.workspace.activeTabId
  expect(hook.api.cloneSession).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(hook.result.current.runtime.statesRef.current[independentId].session?.id).toBe('independent')
})

it('applies a pending table response to its initiating tab after changing views', async () => {
  const hook = setup(), loading = deferred<{ session: SessionInfo; grid: GridSnapshot }>()
  hook.api.editGrid.mockReturnValueOnce(loading.promise)
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  let pending!: Promise<GridSnapshot | undefined>
  act(() => { pending = hook.result.current.tables.openGrid(grid.table) })
  act(() => hook.result.current.runtime.changeWorkspace(previous => ({ ...previous, activeTabId: 'b' })))
  await act(async () => { loading.resolve({ session, grid }); await pending })
  expect(hook.result.current.runtime.statesRef.current.a.grid?.id).toBe(grid.id)
  expect(hook.result.current.runtime.statesRef.current.b).toBeUndefined()
})

it('rejects a table response after its session is replaced', async () => {
  const hook = setup(), loading = deferred<{ session: SessionInfo; grid: GridSnapshot }>()
  hook.api.editGrid.mockReturnValueOnce(loading.promise)
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  let pending!: Promise<GridSnapshot | undefined>
  act(() => { pending = hook.result.current.tables.openGrid(grid.table) })
  act(() => hook.result.current.runtime.patchState('a', { session: { ...session, id: 'replacement' } }))
  await act(async () => { loading.resolve({ session, grid }); await pending })
  expect(hook.result.current.runtime.statesRef.current.a.grid).toBeNull()
  expect(hook.result.current.runtime.statesRef.current.a.session?.id).toBe('replacement')
})

it('retains staged edits when applying them has no confirmed outcome', async () => {
  const hook = setup(), changes = [{ kind: 'delete' as const, row: 0 }]
  hook.api.editGrid.mockResolvedValueOnce({ session, error: 'Outcome unavailable' })
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session, grid, gridChanges: changes }))
  await act(async () => { await hook.result.current.tables.applyGrid() })
  expect(hook.result.current.runtime.statesRef.current.a).toMatchObject({ gridChanges: changes, gridExpired: true, error: 'Outcome unavailable' })
  expect(hook.api.editGrid).toHaveBeenCalledTimes(1)
})

it('keeps an over-budget draft editable without sending a write', async () => {
  const hook = setup(), value = 'x'.repeat(262144)
  const changes = Array.from({ length: 33 }, () => ({ kind: 'insert' as const, values: [{ column: 0, value }] }))
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session, grid, gridChanges: changes }))
  await act(async () => { await hook.result.current.tables.applyGrid() })
  expect(hook.api.editGrid).not.toHaveBeenCalled()
  expect(hook.result.current.runtime.statesRef.current.a).toMatchObject({ gridChanges: changes, gridExpired: false, status: 'Edits not applied', error: 'Staged edits exceed 8 MiB.' })
})

it('keeps W3 partial-result provenance after exporting a cached preview without rerunning SQL', async () => {
  const hook = setup()
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session, queryId: 'cached-query', resultPartial: true, resultSource: 'original source' }))
  await act(async () => { await hook.result.current.query.exportCsv() })
  expect(hook.api.exportCsv).toHaveBeenCalledExactlyOnceWith('cached-query', 0)
  expect(hook.api.run).not.toHaveBeenCalled()
  expect(hook.result.current.runtime.statesRef.current.a).toMatchObject({ resultPartial: true, resultSource: 'original source', status: 'Fetched rows exported' })
})

it('persists the sanitized profile before storing its password', async () => {
  const hook = setup(), saving = deferred<void>()
  hook.persist.mockReturnValueOnce(saving.promise)
  act(() => hook.result.current.sessions.setDialogInfo({ tabId: 'a', profile: DEFAULT_PROFILE, saveOnly: true }))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.sessions.saveProfile({ ...DEFAULT_PROFILE, password: 'test-secret' }, { remember: true, useSaved: false }) })
  const saved = hook.result.current.workspace.profiles[0]
  expect(saved.config).not.toHaveProperty('password')
  expect(hook.api.saveProfilePassword).not.toHaveBeenCalled()
  await act(async () => { saving.resolve(); await pending })
  expect(hook.api.saveProfilePassword).toHaveBeenCalledExactlyOnceWith(saved.id, 'test-secret')
  expect(hook.result.current.sessions.dialogInfo).toBeNull()
})

it('leaves credentials unchanged when saving the profile fails', async () => {
  const hook = setup()
  hook.persist.mockRejectedValueOnce(new Error('ENOSPC'))
  act(() => hook.result.current.sessions.setDialogInfo({ tabId: 'a', profile: DEFAULT_PROFILE, saveOnly: true }))
  await act(async () => { await hook.result.current.sessions.saveProfile({ ...DEFAULT_PROFILE, password: 'test-secret' }, { remember: true, useSaved: false }) })
  expect(hook.api.saveProfilePassword).not.toHaveBeenCalled()
  expect(hook.api.removeProfilePassword).not.toHaveBeenCalled()
  expect(hook.result.current.sessions.dialogInfo).not.toBeNull()
  expect(hook.result.current.sessions.dialogError).toContain('ENOSPC')
})

it('serializes repeated tab-close requests while the first save is pending', async () => {
  const hook = setup(), saving = deferred<void>()
  hook.persist.mockReturnValueOnce(saving.promise)
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  let pending!: Promise<void>
  await act(async () => {
    pending = hook.result.current.tabs.closeTabs(['a'])
    await hook.result.current.tabs.closeTabs(['a'])
  })
  expect(hook.api.disconnect).toHaveBeenCalledTimes(1)
  expect(hook.persist).toHaveBeenCalledTimes(1)
  await act(async () => { saving.resolve(); await pending })
  expect(hook.forget).toHaveBeenCalledExactlyOnceWith('a')
})

it('disconnects a superseded database-switch connection without attaching it or replaying SQL', async () => {
  const hook = setup(), switching = deferred<SessionInfo>()
  hook.api.switchDatabase.mockReturnValueOnce(switching.promise)
  act(() => hook.result.current.runtime.patchState('a', { ...emptyTabState(), session }))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.sessions.switchDatabase({ tabId: 'a', sessionId: session.id, database: 'other' }) })
  act(() => hook.result.current.runtime.patchState('a', { session: { ...session, id: 'replacement' } }))
  await act(async () => { switching.resolve({ ...session, id: 'late-switch' }); await pending })
  expect(hook.api.disconnect).toHaveBeenCalledExactlyOnceWith('late-switch')
  expect(hook.result.current.runtime.statesRef.current.a.session?.id).toBe('replacement')
  expect(hook.api.run).not.toHaveBeenCalled()
})
