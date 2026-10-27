import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'

const electron = vi.hoisted(() => ({ app: { on: vi.fn() } }))
vi.mock('electron', () => ({ app: electron.app }))
import { SystemTray } from '../../src/main/system-tray'

afterEach(() => { vi.clearAllMocks() })
function windowFixture() {
  const events = new EventEmitter()
  let visible = false, minimized = true, destroyed = false
  return Object.assign(events, {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: vi.fn(() => { minimized = false; events.emit('restore') }),
    show: vi.fn(() => { visible = true; events.emit('show') }),
    focus: vi.fn(() => events.emit('focus')),
    close: vi.fn(() => { events.emit('close', { preventDefault: vi.fn() }) }),
    destroy: () => { destroyed = true; events.emit('closed') }
  })
}

it('defers native Quit and restores every workspace before requesting guarded closes', async () => {
  const tray = new SystemTray('icon.png', 'tray.png'), windows = [windowFixture(), windowFixture()]
  for (const [index, window] of windows.entries()) tray.attach(window as unknown as BrowserWindow, `Workspace ${index}`)
  const prepareQuit = electron.app.on.mock.calls.find(([event]) => event === 'before-quit')![1]
  const event = { preventDefault: vi.fn() }
  prepareQuit(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  for (const window of windows) expect(window.close).not.toHaveBeenCalled()
  await new Promise(resolve => setImmediate(resolve))
  for (const window of windows) {
    expect(window.isVisible() && !window.isMinimized()).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.close).toHaveBeenCalledOnce()
    expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(window.close.mock.invocationCallOrder[0])
  }
})

it('does not revive a closed workspace when another window cancels application Quit', async () => {
  const tray = new SystemTray('icon.png', 'tray.png'), closed = windowFixture(), retained = windowFixture()
  tray.attach(closed as unknown as BrowserWindow, 'Closed'); tray.attach(retained as unknown as BrowserWindow, 'Retained')
  closed.destroy()
  electron.app.on.mock.calls.find(([event]) => event === 'before-quit')![1]({ preventDefault: vi.fn() })
  await new Promise(resolve => setImmediate(resolve))
  expect(closed.restore).not.toHaveBeenCalled(); expect(closed.show).not.toHaveBeenCalled()
  expect(retained.isVisible() && !retained.isMinimized()).toBe(true)
})

it('coalesces repeated native Quit requests and permits final exit after all windows close', async () => {
  const tray = new SystemTray('icon.png', 'tray.png'), window = windowFixture()
  tray.attach(window as unknown as BrowserWindow, 'Workspace')
  window.close.mockImplementation(() => window.destroy())
  const quit = electron.app.on.mock.calls.find(([event]) => event === 'before-quit')![1]
  const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() }
  quit(first); quit(second)
  expect(first.preventDefault).toHaveBeenCalledOnce(); expect(second.preventDefault).toHaveBeenCalledOnce()
  await new Promise(resolve => setImmediate(resolve))
  expect(window.close).toHaveBeenCalledOnce()
  const final = { preventDefault: vi.fn() }; quit(final)
  expect(final.preventDefault).not.toHaveBeenCalled()
})

it('does not request a close on a workspace destroyed before the queued Quit runs', async () => {
  const tray = new SystemTray('icon.png', 'tray.png'), window = windowFixture()
  tray.attach(window as unknown as BrowserWindow, 'Workspace')
  electron.app.on.mock.calls.find(([event]) => event === 'before-quit')![1]({ preventDefault: vi.fn() })
  window.destroy()
  await new Promise(resolve => setImmediate(resolve))
  expect(window.restore).not.toHaveBeenCalled(); expect(window.close).not.toHaveBeenCalled()
})

it('allows native Quit immediately when no workspace remains', () => {
  new SystemTray('icon.png', 'tray.png')
  const event = { preventDefault: vi.fn() }
  electron.app.on.mock.calls.find(([event]) => event === 'before-quit')![1](event)
  expect(event.preventDefault).not.toHaveBeenCalled()
})
