// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCatalogPage } from '../../src/renderer/use-catalog-page'
import type { CatalogPage, CatalogPageRequest } from '../../src/shared/catalog'

afterEach(() => { cleanup(); vi.useRealTimers() })
const request: CatalogPageRequest = { sessionId: 'owner', search: '', rootsOnly: true }
const page = (name: string): CatalogPage => ({ objects: [{ schema: 'main', name, kind: 'table', identity: name }], notice: 'Visible metadata', source: 'session', fetchedAt: 'now' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
it('coalesces typing during an active read and discards the superseded response', async () => {
  vi.useFakeTimers()
  const first = deferred<CatalogPage>(), last = deferred<CatalogPage>()
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
  const hook = renderHook(({ read }) => useCatalogPage(read, 'schema', false, load), { initialProps: { read: request } })
  // Initial metadata ownership starts in layout, with no idle timer gap.
  expect(load).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  hook.rerender({ read: { ...request, search: 'older search' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  hook.rerender({ read: { ...request, search: 'latest search' } })
  await act(async () => { first.resolve(page('stale')) })
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  expect(hook.result.current.page).toBeUndefined()
  expect(load).toHaveBeenCalledTimes(2)
  expect(load.mock.calls[1][0].search).toBe('latest search')
  await act(async () => { last.resolve(page('fresh')) })
  expect(hook.result.current.page?.objects[0].name).toBe('fresh')
})
it('waits for an idle physical owner and clears old results when the session changes', async () => {
  vi.useFakeTimers()
  const load = vi.fn().mockResolvedValue(page('original'))
  const hook = renderHook(({ read, blocked }) => useCatalogPage(read, 'schema', blocked, load), { initialProps: { read: request, blocked: true } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(load).not.toHaveBeenCalled()
  hook.rerender({ read: request, blocked: false })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(hook.result.current.page?.objects[0].name).toBe('original')
  hook.rerender({ read: { ...request, sessionId: 'replacement' }, blocked: true })
  expect(hook.result.current.page).toBeUndefined()
  expect(load).toHaveBeenCalledTimes(1)
})
it('exposes a read failure without inventing an empty catalog and retries explicitly', async () => {
  vi.useFakeTimers()
  const load = vi.fn().mockRejectedValueOnce(new Error('metadata permission denied')).mockResolvedValueOnce(page('visible'))
  const hook = renderHook(() => useCatalogPage(request, 'schema', false, load))
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(hook.result.current.error).toBe('metadata permission denied')
  expect(hook.result.current.page).toBeUndefined()
  act(() => { hook.result.current.retry() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(hook.result.current.page?.objects[0].name).toBe('visible')
})
