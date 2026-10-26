// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type ConnectionProfile, type SessionInfo } from '../../src/shared/contracts'

const api = vi.hoisted(() => {
  const api = { passwordStatus: vi.fn(), removeProfilePassword: vi.fn(), connect: vi.fn(), connectSavedPassword: vi.fn(), disconnect: vi.fn() }
  Object.defineProperty(window, 'dbCommander', { configurable: true, value: api })
  return api
})
import { ConnectionDialog } from '../../src/renderer/ConnectionDialog'

const profileId = '00000000-0000-4000-8000-000000000001'
const session: SessionInfo = { id: '00000000-0000-4000-8000-000000000002', ...DEFAULT_PROFILE, version: 'test server', transaction: 'idle', tls: true }
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  vi.resetAllMocks()
  api.passwordStatus.mockResolvedValue({ saved: false, available: true, backend: 'Test vault' })
  api.connect.mockResolvedValue(session); api.connectSavedPassword.mockResolvedValue(session); api.disconnect.mockResolvedValue(undefined)
})
afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function fixture(profile: ConnectionProfile = DEFAULT_PROFILE, saveOnly = true) {
  const onSave = vi.fn(async () => {}), onConnect = vi.fn(async () => {}), onClose = vi.fn()
  const view = render(<ConnectionDialog profile={profile} profileId={profileId} busy={false} error="" saveOnly={saveOnly} onSave={onSave} onConnect={onConnect} onClose={onClose}/>)
  await act(async () => {})
  return { ...view, onSave, onConnect, onClose }
}
const testButton = () => screen.getByRole('button', { name: 'Test connection' })

it('tests unsaved edits once, waits for disconnect, and leaves save/connect actions untouched', async () => {
  const opening = deferred<SessionInfo>(), closing = deferred<void>()
  api.connect.mockReturnValue(opening.promise); api.disconnect.mockReturnValue(closing.promise)
  const view = await fixture()
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'draft.example' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'session-only-secret' } })
  fireEvent.click(testButton()); fireEvent.click(screen.getByRole('button', { name: 'Testing…' }))
  expect(api.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'draft.example', password: 'session-only-secret' }))
  expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('Host') as HTMLInputElement).matches(':disabled')).toBe(true)
  fireEvent.submit(view.container.querySelector('form')!)
  await act(async () => { opening.resolve(session) })
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(screen.getByRole('status').textContent).toBe('Testing connection…')
  await act(async () => { closing.resolve() })
  expect(screen.getByRole('status').textContent).toContain('Connection successful')
  expect(view.onSave).not.toHaveBeenCalled(); expect(view.onConnect).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'different.example' } })
  expect(screen.queryByRole('status')).toBeNull()
})

it('uses an opted-in matching saved password, gives typed passwords precedence, and rejects reuse after an endpoint edit', async () => {
  api.passwordStatus.mockResolvedValue({ saved: true, available: true, backend: 'Test vault' })
  await fixture()
  expect((screen.getByLabelText('Use saved password') as HTMLInputElement).checked).toBe(true)
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Draft name' } })
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connectSavedPassword).toHaveBeenCalledExactlyOnceWith(profileId, { ...DEFAULT_PROFILE, name: 'Draft name' }, undefined)
  expect(api.connect).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'replacement' } })
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connect).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'replacement' }))
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'changed.example' } })
  expect((screen.getByLabelText('Use saved password') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connectSavedPassword).toHaveBeenCalledTimes(1)
  expect(api.connect).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'changed.example', password: '' }))
})

it('shows a retryable error without exposing database or SSH secrets', async () => {
  const profile = { ...DEFAULT_PROFILE, ssh: { host: 'jump.example', port: 22, user: 'ssh-user', fingerprint: 'SHA256:trusted-key', authentication: 'password' as const } }
  const view = await fixture(profile)
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'database-secret' } })
  fireEvent.change(screen.getByLabelText('SSH password'), { target: { value: 'tunnel-secret' } })
  api.connect.mockRejectedValueOnce(new Error("Error invoking remote method 'sql:connect': Error: database-secret tunnel-secret rejected"))
  fireEvent.click(testButton())
  expect((await screen.findByRole('alert')).textContent).toBe('Connection failed: [redacted] [redacted] rejected')
  expect(api.disconnect).not.toHaveBeenCalled()
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connect).toHaveBeenLastCalledWith(expect.objectContaining({ ssh: profile.ssh, sshSecrets: { password: 'tunnel-secret' } }))
  expect(view.onSave).not.toHaveBeenCalled()
})

it('reports cleanup failures and retries that exact session before opening another test', async () => {
  await fixture()
  api.disconnect.mockRejectedValueOnce(new Error('temporary close failure'))
  fireEvent.click(testButton())
  expect((await screen.findByRole('alert')).textContent).toContain('test connection could not be closed')
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connect).toHaveBeenCalledTimes(2)
  expect(api.disconnect).toHaveBeenCalledTimes(3)
  expect(api.disconnect.mock.invocationCallOrder[1]).toBeLessThan(api.connect.mock.invocationCallOrder[1])
})

it('closes a connection that finishes opening after its dialog has been unmounted', async () => {
  const opening = deferred<SessionInfo>(); api.connect.mockReturnValue(opening.promise)
  const view = await fixture(); fireEvent.click(testButton()); view.unmount()
  await act(async () => { opening.resolve(session) })
  expect(api.disconnect).toHaveBeenCalledExactlyOnceWith(session.id)
})

it('requires a current Entra token for testing but allows saving an uncredentialed profile', async () => {
  const view = await fixture({ ...DEFAULT_PROFILE, engine: 'azure-sql', authentication: 'entra-token' })
  expect((screen.getByLabelText('Access token') as HTMLInputElement).required).toBe(false)
  fireEvent.click(testButton())
  expect(screen.getByRole('alert').textContent).toContain('Enter a current access token')
  expect(api.connect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' })); expect(view.onSave).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'transient-token' } })
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'transient-token' }))
  expect(view.onSave).toHaveBeenCalledTimes(1)
})

it('never creates an embedded file during testing and normalizes temporary database settings', async () => {
  await fixture({ ...DEFAULT_PROFILE, engine: 'duckdb', duckdbMode: 'create', filePath: '/new/database.duckdb' })
  expect((testButton() as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Testing never creates a database file/)).toBeTruthy()
  fireEvent.click(testButton()); expect(api.connect).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Open mode'), { target: { value: 'memory' } })
  fireEvent.click(testButton()); await screen.findByText('Connection successful. Test connection closed.')
  expect(api.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ engine: 'duckdb', duckdbMode: 'memory', host: 'local', port: 1, user: 'local', password: '', tls: 'disable' }))
})

it('keeps native field validation in front of the test action', async () => {
  await fixture(); fireEvent.change(screen.getByLabelText('Host'), { target: { value: '' } })
  fireEvent.click(testButton()); expect(api.connect).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'localhost' } })
  fireEvent.click(testButton()); await waitFor(() => expect(api.disconnect).toHaveBeenCalledExactlyOnceWith(session.id))
})
