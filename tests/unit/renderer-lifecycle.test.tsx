// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type DesktopApi, type Workspace } from '../../src/shared/contracts'
import { useJobFeed } from '../../src/renderer/use-job-feed'
import { useWorkspaceRecovery } from '../../src/renderer/use-workspace-recovery'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function workspace(sql: string): Workspace {
  const id = '00000000-0000-4000-8000-000000000001'
  return { version: 2, activeTabId: id, profiles: [], tabs: [{ id, title: 'Query', sql, profile: DEFAULT_PROFILE }] }
}
type RecoveryApi = Pick<DesktopApi, 'loadWorkspace' | 'saveWorkspace'>

afterEach(() => { cleanup(); vi.useRealTimers() })

it('recovers through the current callback and ignores the discarded Strict Mode load', async () => {
  vi.useFakeTimers()
  const discarded = deferred<Workspace | null>(), loaded = deferred<Workspace & { recoveryNotice?: string }>()
  const api: RecoveryApi = { loadWorkspace: vi.fn().mockReturnValueOnce(discarded.promise).mockReturnValueOnce(loaded.promise), saveWorkspace: vi.fn() }
  const first = vi.fn(), current = vi.fn(), error = vi.fn()
  const hook = renderHook(({ recovered }) => useWorkspaceRecovery(api, () => workspace('initial'), recovered, error), {
    initialProps: { recovered: first }, reactStrictMode: true
  })
  hook.rerender({ recovered: current })
  await act(async () => {
    discarded.resolve(workspace('discarded'))
    loaded.resolve({ ...workspace('recovered'), recoveryNotice: 'Recovered from backup.' })
  })
  expect(hook.result.current.ready).toBe(true)
  expect(hook.result.current.workspace.tabs[0].sql).toBe('recovered')
  expect(first).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledExactlyOnceWith(workspace('recovered'), 'Recovered from backup.')
  expect(error).not.toHaveBeenCalled()
})

it('keeps recovery read-only on a load failure and refuses to overwrite saved data', async () => {
  const failure = new Error('Workspace database is unreadable')
  const api: RecoveryApi = { loadWorkspace: vi.fn().mockRejectedValue(failure), saveWorkspace: vi.fn() }
  const onError = vi.fn()
  const hook = renderHook(() => useWorkspaceRecovery(api, () => workspace('initial'), vi.fn(), onError))
  await act(async () => {})
  expect(hook.result.current.ready).toBe(false)
  expect(hook.result.current.workspaceLoadError).toBe(failure.message)
  expect(onError).toHaveBeenCalledWith(failure)
  await expect(hook.result.current.persist()).rejects.toThrow('recovery has not finished')
  expect(api.saveWorkspace).not.toHaveBeenCalled()
})

it('serializes snapshots, preserves newer edits on disk-full failure and retries without replaying an edit', async () => {
  vi.useFakeTimers()
  const first = deferred<void>(), second = deferred<void>()
  const save = vi.fn<RecoveryApi['saveWorkspace']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined)
  const api: RecoveryApi = { loadWorkspace: vi.fn().mockResolvedValue(workspace('loaded')), saveWorkspace: save }
  const hook = renderHook(() => useWorkspaceRecovery(api, () => workspace('initial'), vi.fn(), vi.fn()))
  await act(async () => {})
  let saving!: Promise<void>, failing!: Promise<unknown>
  act(() => { hook.result.current.updateWorkspace(workspace('first')); saving = hook.result.current.persist() })
  await act(async () => {})
  act(() => { hook.result.current.updateWorkspace(workspace('latest')); failing = hook.result.current.persist().catch(error => error) })
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve(); await saving })
  expect(hook.result.current.saved).toBe(false)
  expect(save.mock.calls.map(([value]) => value.tabs[0].sql)).toEqual(['first', 'latest'])
  await act(async () => { second.reject(new Error('ENOSPC: disk full')); await failing })
  expect(hook.result.current.workspace.tabs[0].sql).toBe('latest')
  expect(hook.result.current.saveError).toBe('ENOSPC: disk full')
  expect(hook.result.current.saveAnnouncement).toContain('not saved')
  await act(async () => { await hook.result.current.persist() })
  expect(save.mock.calls.map(([value]) => value.tabs[0].sql)).toEqual(['first', 'latest', 'latest'])
  expect(hook.result.current.saved).toBe(true)
  expect(hook.result.current.saveError).toBe('')
  expect(hook.result.current.saveAnnouncement).toBe('Workspace saved locally.')
})

it('autosaves the latest buffer once after the debounce and cancels the timer on unmount', async () => {
  vi.useFakeTimers()
  const api: RecoveryApi = { loadWorkspace: vi.fn().mockResolvedValue(workspace('loaded')), saveWorkspace: vi.fn().mockResolvedValue(undefined) }
  const hook = renderHook(() => useWorkspaceRecovery(api, () => workspace('initial'), vi.fn(), vi.fn()))
  await act(async () => {})
  act(() => hook.result.current.updateWorkspace(workspace('first')))
  act(() => hook.result.current.updateWorkspace(workspace('latest')))
  await act(async () => { await vi.advanceTimersByTimeAsync(249) })
  expect(api.saveWorkspace).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(api.saveWorkspace).toHaveBeenCalledExactlyOnceWith(workspace('latest'))
  act(() => hook.result.current.updateWorkspace(workspace('pending')))
  hook.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(api.saveWorkspace).toHaveBeenCalledTimes(1)
})

it('ignores recovery and errors that arrive after the workspace unmounts', async () => {
  const loaded = deferred<Workspace | null>(), failed = deferred<Workspace | null>()
  const recovered = vi.fn(), error = vi.fn()
  for (const request of [loaded, failed]) {
    const api: RecoveryApi = { loadWorkspace: () => request.promise, saveWorkspace: vi.fn() }
    const hook = renderHook(() => useWorkspaceRecovery(api, () => workspace('initial'), recovered, error))
    hook.unmount()
  }
  await act(async () => { loaded.resolve(workspace('late')); failed.reject(new Error('late failure')) })
  expect(recovered).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})

it('lets a live job beat the initial snapshot without renewing the subscription for a new callback', async () => {
  type Job = { id: string; status: string }
  const snapshot = deferred<Job[]>(), first = vi.fn(), current = vi.fn(), unsubscribe = vi.fn()
  let receive!: (job: Job) => void
  const subscribe = vi.fn((callback: typeof receive) => { receive = callback; return unsubscribe })
  const load = () => snapshot.promise
  const hook = renderHook(({ onJob }) => useJobFeed(subscribe, load, onJob), { initialProps: { onJob: first } })
  act(() => receive({ id: 'backup', status: 'completed' }))
  hook.rerender({ onJob: current })
  await act(async () => { snapshot.resolve([{ id: 'backup', status: 'running' }, { id: 'transfer', status: 'completed' }]) })
  expect(hook.result.current).toEqual([{ id: 'backup', status: 'completed' }, { id: 'transfer', status: 'completed' }])
  expect(first).toHaveBeenCalledExactlyOnceWith({ id: 'backup', status: 'completed' })
  expect(current).toHaveBeenCalledExactlyOnceWith({ id: 'transfer', status: 'completed' })
  expect(subscribe).toHaveBeenCalledTimes(1)
  hook.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  act(() => receive({ id: 'backup', status: 'late' }))
  expect(current).toHaveBeenCalledTimes(1)
})

it('discards the initial job list when it resolves after unmount', async () => {
  const snapshot = deferred<{ id: string }[]>(), onJob = vi.fn(), unsubscribe = vi.fn()
  const hook = renderHook(() => useJobFeed(() => unsubscribe, () => snapshot.promise, onJob))
  hook.unmount()
  await act(async () => { snapshot.resolve([{ id: 'late' }]) })
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(onJob).not.toHaveBeenCalled()
})
