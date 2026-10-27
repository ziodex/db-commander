// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, MAX_PROFILES, type DesktopApi, type Workspace } from '../../src/shared/contracts'
import { profileDocument } from '../../src/shared/profile-files'
import { useProfileLibrary } from '../../src/renderer/use-profile-library'

afterEach(cleanup)
function fixture(count = 1) {
  const profiles = Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), config: { ...DEFAULT_PROFILE, name: `Existing ${index}` }, credential: 'os-store' as const }))
  const workspaceRef = { current: { version: 2, activeTabId: 'tab', tabs: [{ id: 'tab', title: 'Keep.sql', sql: 'SELECT do_not_execute;', profile: DEFAULT_PROFILE }], profiles } as Workspace }
  const imported = { sourceName: 'connections.json', document: profileDocument([{ id: 'unused', config: { ...DEFAULT_PROFILE, name: 'Imported' } }]) }
  const api = { importConnectionProfiles: vi.fn().mockResolvedValue(imported), exportConnectionProfiles: vi.fn().mockResolvedValue('new.json') }
  const props = { api: api as unknown as DesktopApi, workspaceRef, persist: vi.fn().mockResolvedValue(undefined), report: vi.fn(), notice: vi.fn(), onDraft: vi.fn(), changeWorkspace: vi.fn((update: (workspace: Workspace) => Workspace) => { workspaceRef.current = update(workspaceRef.current) }) }
  return { ...renderHook(() => useProfileLibrary(props)), props, api, imported }
}

it('exports only after the workspace is saved, and does not open a file dialog after a save failure', async () => {
  const f = fixture(); f.props.persist.mockRejectedValueOnce(new Error('Disk full'))
  await act(() => f.result.current.exportProfiles())
  expect(f.api.exportConnectionProfiles).not.toHaveBeenCalled()
  expect(f.props.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }))
  await act(() => f.result.current.exportProfiles(f.props.workspaceRef.current.profiles[0]))
  expect(f.api.exportConnectionProfiles).toHaveBeenCalledWith([f.props.workspaceRef.current.profiles[0].id])
})
it('rejects an over-capacity batch before changing profiles and imports selected entries with fresh IDs', async () => {
  const f = fixture(MAX_PROFILES - 1)
  f.imported.document.profiles.push({ ...DEFAULT_PROFILE, name: 'Second imported' })
  await act(() => f.result.current.importProfiles())
  await expect(f.result.current.apply([0, 1], 'skip')).rejects.toThrow('Only 1')
  expect(f.props.changeWorkspace).not.toHaveBeenCalled()
  await act(() => f.result.current.apply([1], 'skip'))
  const workspace = f.props.workspaceRef.current
  expect(workspace.profiles).toHaveLength(MAX_PROFILES)
  expect(workspace.profiles.at(-1)?.config.name).toBe('Second imported')
  expect(workspace.profiles.at(-1)?.credential).toBeUndefined()
  expect(new Set(workspace.profiles.map(profile => profile.id)).size).toBe(MAX_PROFILES)
  expect(workspace.tabs[0].sql).toBe('SELECT do_not_execute;')
  expect(f.result.current.preview).toBeNull()
})
it('retains one recoverable import after a failed save and reports workspace-save recovery without duplicating a retry', async () => {
  const f = fixture(); f.props.persist.mockRejectedValueOnce(new Error('Disk full'))
  await act(() => f.result.current.importProfiles())
  await act(() => f.result.current.apply([0], 'skip'))
  expect(f.props.workspaceRef.current.profiles).toHaveLength(2)
  expect(f.props.workspaceRef.current.profiles[0].credential).toBe('os-store')
  expect(f.props.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Retry workspace save') }))
  await act(() => f.result.current.apply([0], 'copy'))
  expect(f.props.workspaceRef.current.profiles).toHaveLength(2)
})
it('duplicates only a fresh draft and keeps cancelled import and export operations from altering connections', async () => {
  const f = fixture()
  f.api.importConnectionProfiles.mockResolvedValueOnce(null)
  await act(() => f.result.current.importProfiles())
  act(() => f.result.current.duplicate(f.props.workspaceRef.current.profiles[0]))
  expect(f.result.current.preview).toBeNull()
  expect(f.props.changeWorkspace).not.toHaveBeenCalled()
  expect(f.props.onDraft).toHaveBeenCalledWith({ ...f.props.workspaceRef.current.profiles[0].config, name: 'Existing 0 copy' })
  expect(f.props.onDraft.mock.calls[0][0]).not.toHaveProperty('credential')
})
