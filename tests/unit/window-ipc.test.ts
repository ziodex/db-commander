import { expect, it, vi } from 'vitest'
const registered = vi.hoisted(() => new Map<string, (event: any, payload: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel, callback) => { if (registered.has(channel)) throw new Error('Duplicate registration'); registered.set(channel, callback) }) } }))
import { WindowIpc } from '../../src/main/window-ipc'

it('routes the same API to its owning window and removes access when that window closes', async () => {
  const router = new WindowIpc(), first = vi.fn(async (_event, value) => `first:${value}`), second = vi.fn(async (_event, value) => `second:${value}`)
  router.register('save'); router.register('save')
  router.attach(10, new Map([['save', first]])); router.attach(20, new Map([['save', second]]))
  const invoke = registered.get('sql:save')!
  expect(await invoke({ sender: { id: 10 } }, 'query')).toBe('first:query')
  expect(second).not.toHaveBeenCalled()
  expect(await invoke({ sender: { id: 20 } }, 'other')).toBe('second:other')
  router.detach(10)
  expect(() => invoke({ sender: { id: 10 } }, 'closed')).toThrow('Untrusted')
  expect(() => invoke({ sender: { id: 999 } }, 'unknown')).toThrow('Untrusted')
  expect(await invoke({ sender: { id: 20 } }, 'still open')).toBe('second:still open')
})
