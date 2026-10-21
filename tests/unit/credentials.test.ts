import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { PasswordVault, type EntryFactory } from '../../src/credentials/vault'
import { DEFAULT_PROFILE, type SavedConnectionProfile, type Workspace, workspaceSchema } from '../../src/shared/contracts'
import { passwordEligible } from '../../src/shared/credentials'

function fixture() {
  const entries = new Map<string, string>()
  let fail = false
  const factory: EntryFactory = async (_service, account) => {
    if (fail) throw new Error('Native error with a secret that must not reach UI: sensitive-value')
    return { async getPassword() { return entries.get(account) ?? null }, async setPassword(value) { entries.set(account, value) }, async deleteCredential() { return entries.delete(account) } }
  }
  const vault = new PasswordVault('/test/workspace', factory)
  const profile: SavedConnectionProfile = { id: randomUUID(), config: { ...DEFAULT_PROFILE }, credential: 'os-store' }
  const tabId = randomUUID()
  const workspace: Workspace = { version: 2, activeTabId: tabId, profiles: [profile], tabs: [{ id: tabId, title: 'Query.sql', sql: 'SELECT 1', profile: DEFAULT_PROFILE }] }
  return { vault, entries, profile, workspace, lock() { fail = true } }
}
it('stores and replaces passwords only in the credential backend and resolves the matching profile', async () => {
  const { vault, profile, entries, workspace } = fixture()
  await vault.save(profile, 'first-secret')
  expect(await vault.resolve(profile, { ...profile.config, name: 'Renamed' })).toBe('first-secret')
  await vault.save(profile, 'replacement-secret')
  expect(await vault.resolve(profile, profile.config)).toBe('replacement-secret')
  expect(entries.size).toBe(1)
  expect(JSON.stringify(workspaceSchema.parse(workspace))).not.toMatch(/first-secret|replacement-secret/)
  await vault.remove(profile); await expect(vault.resolve(profile, profile.config)).rejects.toThrow('missing')
})
it('binds saved passwords to profile identity, endpoint, database, authentication and TLS policy', async () => {
  const { vault, profile } = fixture(); await vault.save(profile, 'secret')
  for (const patch of [{ engine: 'mysql' as const }, { host: 'other-host' }, { port: 9999 }, { user: 'other-user' }, { database: 'another-db' }, { tls: 'disable' as const }, { ca: 'different-ca' }, { authentication: 'entra-token' as const }]) {
    await expect(vault.resolve(profile, { ...profile.config, ...patch })).rejects.toThrow('does not match')
  }
  const tampered = { ...profile, config: { ...profile.config, host: 'new-host' } }
  await expect(vault.resolve(tampered, tampered.config)).rejects.toThrow('does not match')
})
it('keeps references across ordinary saves but removes credentials on profile deletion or identity changes', async () => {
  const { vault, profile, workspace, entries } = fixture(); await vault.save(profile, 'secret')
  const incoming = { ...workspace, profiles: [{ id: profile.id, config: { ...profile.config, name: 'Renamed' } }] }
  expect((await vault.prepareWorkspace(workspace, incoming)).profiles[0].credential).toBe('os-store')
  const moved = await vault.prepareWorkspace(workspace, { ...incoming, profiles: [{ id: profile.id, config: { ...profile.config, host: 'new-host' } }] })
  expect(moved.profiles[0].credential).toBeUndefined(); expect(entries.size).toBe(0)
  await vault.save(profile, 'secret'); await vault.prepareWorkspace(workspace, { ...workspace, profiles: [] })
  expect(entries.size).toBe(0)
  expect((await vault.prepareWorkspace(null, workspace)).profiles[0].credential).toBeUndefined()
})
it('keeps existing passwords and references when new saved connections are added independently', async () => {
  const { vault, profile, workspace, entries, lock } = fixture()
  await vault.save(profile, 'first-secret')
  const added: SavedConnectionProfile = { id: randomUUID(), config: { ...profile.config, name: 'Another server', host: 'other-host' } }
  const incoming = { ...workspace, profiles: [profile, added] }
  const saved = await vault.prepareWorkspace(workspace, incoming)
  expect(saved.profiles[0]).toEqual(profile); expect(saved.profiles[1].credential).toBeUndefined()
  await vault.save(added, 'second-secret'); added.credential = 'os-store'
  expect(await vault.resolve(profile, profile.config)).toBe('first-secret')
  expect(await vault.resolve(added, added.config)).toBe('second-secret')
  expect(entries.size).toBe(2)
  // Adding a profile also remains possible while an unrelated stored secret
  // is locked; no removal/replacement is needed for the unchanged entry.
  lock()
  expect((await vault.prepareWorkspace(workspace, incoming)).profiles[0]).toEqual(profile)
})
it('fails closed on unavailable stores without exposing backend errors or discarding profile references', async () => {
  const { vault, profile, workspace, lock } = fixture(); lock()
  const status = await vault.status(profile)
  expect(status.available).toBe(false); expect(status.saved).toBe(true); expect(JSON.stringify(status)).not.toContain('sensitive-value')
  await expect(vault.save(profile, 'secret')).rejects.toThrow('not saved')
  await expect(vault.prepareWorkspace(workspace, { ...workspace, profiles: [] })).rejects.toThrow('profile has been retained')
  await expect(vault.resolve(profile, profile.config)).rejects.toThrow('unavailable or locked')
  expect(workspace.profiles[0].credential).toBe('os-store')
  await expect(vault.prepareWorkspace({ ...workspace, profiles: [] }, { ...workspace, profiles: [] })).resolves.toBeDefined()
})
it('rejects malformed vault records without echoing their contents', async () => {
  const { vault, entries, profile } = fixture()
  for (const value of ['sensitive-value', JSON.stringify({ password: 'sensitive-value' })]) {
    entries.set(profile.id, value)
    try { await vault.resolve(profile, profile.config); expect.fail('Must reject invalid records') } catch (error) { expect(String(error)).not.toContain('sensitive-value') }
  }
})
it('excludes embedded databases and access tokens and scopes credentials to the local workspace', async () => {
  const { vault, profile } = fixture()
  for (const engine of ['sqlite', 'duckdb'] as const) {
    const embedded = { ...profile, config: { ...profile.config, engine } }
    expect(passwordEligible(embedded.config)).toBe(false)
    await expect(vault.save(embedded, 'secret')).rejects.toThrow('server passwords')
  }
  await expect(vault.save({ ...profile, config: { ...profile.config, engine: 'azure-sql', authentication: 'entra-token' } }, 'token')).rejects.toThrow('Access tokens')
  expect(new PasswordVault('/one').service).not.toBe(new PasswordVault('/two').service)
  expect(new PasswordVault('/one').service).toBe(new PasswordVault('/one').service)
})

it('reads path-bound legacy passwords, prefers replacements and removes both namespaces', async () => {
  const { profile } = fixture(), records = new Map<string, string>()
  const factory: EntryFactory = async (service, account) => {
    const key = `${service}:${account}`
    return { async getPassword() { return records.get(key) ?? null }, async setPassword(value) { records.set(key, value) }, async deleteCredential() { return records.delete(key) } }
  }
  const vault = new PasswordVault('/existing/workspace', factory)
  await vault.save(profile, 'existing-secret')
  const key = `${vault.service}:${profile.id}`, legacyKey = key.replace('org.dbcommander.', 'org.sqlcommander.')
  records.set(legacyKey, records.get(key)!); records.delete(key)
  expect(await vault.resolve(profile, profile.config)).toBe('existing-secret')
  await expect(new PasswordVault('/other/workspace', factory).resolve(profile, profile.config)).rejects.toThrow('missing')
  await vault.save(profile, 'replacement-secret')
  expect(await vault.resolve(profile, profile.config)).toBe('replacement-secret')
  await vault.remove(profile)
  expect(records.size).toBe(0)
  await expect(vault.resolve(profile, profile.config)).rejects.toThrow('missing')
})
