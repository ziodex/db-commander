import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { PasswordVault, type EntryFactory } from '../../src/credentials/vault'
import { CredentialWorkspace } from '../../src/credentials/workspace'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, type SavedConnectionProfile, type Workspace } from '../../src/shared/contracts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credential-save-')), path = join(directory, 'workspace.sqlite')
  let store = new WorkspaceStore(path), locked = false
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const entries = new Map<string, string>()
  const factory: EntryFactory = async (service, account) => ({
    async getPassword() { return entries.get(`${service}:${account}`) ?? null },
    async setPassword(value) { entries.set(`${service}:${account}`, value) },
    async deleteCredential() { if (locked) throw new Error('sensitive-backend-error'); return entries.delete(`${service}:${account}`) }
  })
  const vault = new PasswordVault(directory, factory)
  const profile: SavedConnectionProfile = { id: randomUUID(), config: { ...DEFAULT_PROFILE }, credential: 'os-store' }
  const tabId = randomUUID()
  const workspace: Workspace = { version: 2, activeTabId: tabId, profiles: [profile], tabs: [{ id: tabId, title: 'Query', sql: 'SELECT 42', profile: profile.config }] }
  store.save(workspace); await vault.save(profile, 'preserved-secret')
  const coordinator = () => new CredentialWorkspace(vault, {
    load: async () => store.load(), save: async (value, ids) => store.saveWithCredentialRemovals(value, ids),
    pendingRemovals: async () => store.pendingCredentialRemovals(), completeRemoval: async id => store.completeCredentialRemoval(id)
  })
  return { vault, profile, workspace, entries, coordinator,
    get store() { return store },
    readOnly() { (store as unknown as { db: DatabaseSync }).db.exec('PRAGMA query_only=ON') },
    lock(value: boolean) { locked = value },
    reopen() { store.close(); store = new WorkspaceStore(path) }
  }
}

for (const action of ['edit', 'delete', 'remove-password'] as const) it(`preserves the stored profile and password when ${action} persistence fails`, async () => {
  const f = await fixture(), coordinator = f.coordinator()
  f.readOnly()
  const incoming = action === 'delete' ? { ...f.workspace, profiles: [] } :
    { ...f.workspace, profiles: [{ ...f.profile, config: { ...f.profile.config, host: 'new-host' } }] }
  await expect(action === 'remove-password' ? coordinator.removePassword(f.profile.id) : coordinator.save(incoming)).rejects.toThrow(/readonly/)
  expect(f.store.load()).toEqual(f.workspace)
  expect(await f.vault.resolve(f.profile, f.profile.config)).toBe('preserved-secret')
  expect(f.store.pendingCredentialRemovals()).toEqual([])
})

it('rolls back profile changes when the cleanup journal cannot be written', async () => {
  const f = await fixture()
  const db = (f.store as unknown as { db: DatabaseSync }).db
  db.exec(`CREATE TABLE credential_removals (id TEXT PRIMARY KEY);
    CREATE TRIGGER reject_cleanup BEFORE INSERT ON credential_removals BEGIN SELECT RAISE(ABORT, 'cleanup journal full'); END;`)
  await expect(f.coordinator().save({ ...f.workspace, profiles: [] })).rejects.toThrow('cleanup journal full')
  expect(f.store.load()).toEqual(f.workspace)
  expect(f.store.pendingCredentialRemovals()).toEqual([])
  expect(await f.vault.resolve(f.profile, f.profile.config)).toBe('preserved-secret')
})

for (const action of ['edit', 'delete', 'remove-password'] as const) it(`retries interrupted ${action} cleanup after reopening without storing any secret`, async () => {
  const f = await fixture()
  f.lock(true)
  const incoming = action === 'delete' ? { ...f.workspace, profiles: [] } :
    { ...f.workspace, profiles: [{ ...f.profile, config: { ...f.profile.config, host: 'new-host' } }] }
  const pending = action === 'remove-password' ? f.coordinator().removePassword(f.profile.id) : f.coordinator().save(incoming)
  await expect(pending).rejects.toThrow('Workspace changes are saved')
  expect(f.store.load()?.profiles[0]?.credential).toBeUndefined()
  expect(f.store.pendingCredentialRemovals()).toEqual([f.profile.id])
  expect(await f.vault.resolve(f.profile, f.profile.config)).toBe('preserved-secret')
  f.reopen()
  expect(f.store.pendingCredentialRemovals()).toEqual([f.profile.id])
  f.lock(false)
  await f.coordinator().cleanup()
  expect(f.store.pendingCredentialRemovals()).toEqual([])
  expect(f.entries.size).toBe(0)
  await f.coordinator().cleanup() // Completion is idempotent.
})

it('retains unchanged credentials while saving SQL and cosmetic profile edits with a locked store', async () => {
  const f = await fixture(); f.lock(true)
  const incoming = { ...f.workspace, profiles: [{ ...f.profile, config: { ...f.profile.config, name: 'Renamed', folder: 'Team', favorite: true } }] }
  await f.coordinator().save(incoming)
  expect(f.store.load()).toEqual(incoming)
  expect(f.store.pendingCredentialRemovals()).toEqual([])
  expect(await f.vault.resolve(f.profile, f.profile.config)).toBe('preserved-secret')
})

it('retains cleanup intent when acknowledgement fails and settles it before a replacement password', async () => {
  const f = await fixture()
  const db = (f.store as unknown as { db: DatabaseSync }).db
  db.exec(`CREATE TABLE credential_removals (id TEXT PRIMARY KEY);
    CREATE TRIGGER reject_cleanup_ack BEFORE DELETE ON credential_removals BEGIN SELECT RAISE(ABORT, 'cleanup acknowledgement full'); END;`)
  await expect(f.coordinator().removePassword(f.profile.id)).rejects.toThrow('cleanup is pending')
  expect(f.entries.size).toBe(0)
  expect(f.store.pendingCredentialRemovals()).toEqual([f.profile.id])
  db.exec('DROP TRIGGER reject_cleanup_ack')
  await f.coordinator().cleanup()
  await f.vault.save(f.profile, 'replacement-secret')
  await f.coordinator().cleanup()
  expect(await f.vault.resolve(f.profile, f.profile.config)).toBe('replacement-secret')
})
