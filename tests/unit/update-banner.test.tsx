// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../../src/renderer/UpdateBanner'
import type { UpdateStatus } from '../../src/shared/updates'

afterEach(cleanup)
const available: UpdateStatus = { currentVersion: '0.1.0', checking: false, dismissed: false, available: { version: '0.2.0', url: 'https://github.com/ziodex/db-commander/releases/tag/v0.2.0' } }
function fixture(initial: UpdateStatus = available) {
  const listeners = new Set<(state: UpdateStatus) => void>()
  const emit = (state: UpdateStatus) => listeners.forEach(listener => listener(state))
  const api = {
    updateStatus: vi.fn(async () => initial),
    onUpdateStatus: vi.fn((listener: (state: UpdateStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    dismissUpdate: vi.fn(async (_version?: string) => { emit({ ...initial, dismissed: true, message: undefined }) }),
    openUpdatePage: vi.fn(async () => {})
  }
  return { api, emit, listeners }
}

it('shows a manual-download action and restores keyboard focus after dismissal', async () => {
  const { api } = fixture()
  render(<><input aria-label="SQL editor" /><UpdateBanner api={api} /></>)
  await screen.findByText('Db Commander 0.2.0 is available.')
  fireEvent.click(screen.getByRole('button', { name: 'Release notes & download' }))
  expect(api.openUpdatePage).toHaveBeenCalledExactlyOnceWith()
  const editor = screen.getByLabelText('SQL editor'), dismiss = screen.getByRole('button', { name: 'Dismiss update notification' })
  act(() => { editor.focus(); dismiss.focus() })
  fireEvent.click(dismiss)
  expect(api.dismissUpdate).toHaveBeenCalledWith('0.2.0')
  expect(document.activeElement).toBe(editor)
  expect(screen.queryByLabelText('Application updates')).toBeNull()
})

it('leaves background results and remembered dismissals quiet', async () => {
  const { api, emit } = fixture({ ...available, dismissed: true })
  render(<UpdateBanner api={api} />)
  await act(async () => {})
  expect(screen.queryByLabelText('Application updates')).toBeNull()
  act(() => emit({ ...available, available: undefined }))
  expect(screen.queryByLabelText('Application updates')).toBeNull()
})

it('does not let a stale initial status replace a newer event and removes its subscription on unmount', async () => {
  const { api, emit, listeners } = fixture()
  let resolve!: (value: UpdateStatus) => void
  api.updateStatus.mockImplementation(() => new Promise(yes => { resolve = yes }))
  const view = render(<UpdateBanner api={api} />)
  act(() => emit(available))
  await act(async () => { resolve({ ...available, available: undefined }) })
  expect(screen.getByText('Db Commander 0.2.0 is available.')).toBeTruthy()
  view.unmount(); expect(listeners.size).toBe(0)
})

it('announces manual check results without opening the browser automatically', async () => {
  const { api, emit } = fixture({ ...available, available: undefined, message: 'Checking for updates…', checking: true })
  render(<UpdateBanner api={api} />)
  await screen.findByText('Checking for updates…')
  act(() => emit({ ...available, available: undefined, message: "You're up to date." }))
  expect(screen.getByRole('status').textContent).toContain("You're up to date.")
  expect(api.openUpdatePage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notification' }))
  expect(api.dismissUpdate).toHaveBeenCalledWith(undefined)
})

it('keeps browser failures inline and does not execute an update or restart', async () => {
  const { api } = fixture(); api.openUpdatePage.mockRejectedValue(new Error('Browser unavailable'))
  render(<UpdateBanner api={api} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Release notes & download' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not open your browser')
  expect(screen.getByText('Db Commander 0.2.0 is available.')).toBeTruthy()
})
