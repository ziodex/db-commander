import { expect, it } from 'vitest'
import { connectionProfile, hasConfiguredConnection, sameConnectionProfile } from '../../src/shared/connection-profiles'
import { DEFAULT_PROFILE, engineSchema, profileSchema, type ConnectionProfile } from '../../src/shared/contracts'

it('distinguishes an unconfigured tab from saved, live and customized connection settings', () => {
  const blank = { profile: { ...DEFAULT_PROFILE } }
  expect(hasConfiguredConnection(blank)).toBe(false)
  expect(hasConfiguredConnection({ ...blank, profileId: 'saved-profile' })).toBe(true)
  expect(hasConfiguredConnection(blank, { ...DEFAULT_PROFILE, id: 'live', tls: true, transaction: 'idle', version: '' })).toBe(true)
  expect(hasConfiguredConnection({ profile: { ...DEFAULT_PROFILE, host: 'actual-server' } })).toBe(true)
})

it('reuses equivalent recovered/form settings regardless of property order, whitespace and omitted defaults', () => {
  const original = { ...DEFAULT_PROFILE, folder: 'Reporting', name: 'Saved server' }
  const recovered = profileSchema.parse(JSON.parse(JSON.stringify(original)))
  const form = { ...Object.fromEntries(Object.entries(recovered).reverse()), name: ' Saved server ', folder: ' Reporting ', ca: undefined,
    favorite: false, protected: false, recordHistory: true, authentication: 'sql-password' } as ConnectionProfile
  expect(sameConnectionProfile(original, form)).toBe(true)
  expect(sameConnectionProfile(form, original)).toBe(true)
})

it.each([
  { name: 'Another saved server' }, { host: 'other-host' }, { port: 9999 }, { database: 'another-db' }, { user: 'other-user' },
  { tls: 'disable' as const }, { ca: 'changed trust' }, { authentication: 'entra-token' as const }, { engine: 'mysql' as const },
  { folder: 'Other folder' }, { favorite: true }, { protected: true }, { environment: 'production' as const }, { recordHistory: false }
])('retains the earlier profile instead of replacing it when settings change (%j)', patch => {
  const changed = { ...DEFAULT_PROFILE, ...patch }
  expect(sameConnectionProfile(DEFAULT_PROFILE, changed)).toBe(false)
  expect(sameConnectionProfile(changed, DEFAULT_PROFILE)).toBe(false)
})

for (const engine of engineSchema.options) it(`reuses an unchanged ${engine} profile while excluding session-only secrets`, () => {
  const original: ConnectionProfile = { ...DEFAULT_PROFILE, engine }
  const config = { ...original, password: 'session-secret', accessToken: 'token-secret', sshSecrets: { password: 'ssh-secret', passphrase: 'key-secret' } }
  expect(connectionProfile(config)).toEqual(original)
  expect(sameConnectionProfile(original, connectionProfile(config))).toBe(true)
  expect(config.password).toBe('session-secret')
  expect(JSON.stringify(connectionProfile(config))).not.toContain('secret')
})

for (const engine of ['sqlite', 'duckdb'] as const) it(`keeps ${engine} file/mode identity while reusing a newly created database profile`, () => {
  const mode = engine === 'sqlite' ? 'sqliteMode' : 'duckdbMode'
  const original: ConnectionProfile = { ...DEFAULT_PROFILE, engine, filePath: '/private/source.db', [mode]: 'create' }
  expect(sameConnectionProfile(original, { ...original, [mode]: 'read-write' })).toBe(true)
  expect(sameConnectionProfile(original, { ...original, [mode]: undefined })).toBe(true)
  for (const patch of [{ filePath: '/private/other.db' }, { [mode]: 'memory' }, { [mode]: 'read-only' }]) expect(sameConnectionProfile(original, { ...original, ...patch })).toBe(false)
})

it('compares nested SSH settings consistently and preserves changed routes as separate profiles', () => {
  const ssh = { host: 'bastion.example', port: 22, user: 'alice', authentication: 'password' as const, fingerprint: 'SHA256:' + 'A'.repeat(43) }
  const original = { ...DEFAULT_PROFILE, ssh }
  expect(sameConnectionProfile(original, { ...original, ssh: Object.fromEntries(Object.entries(ssh).reverse()) as typeof ssh })).toBe(true)
  for (const patch of [{ host: 'other-bastion' }, { port: 2222 }, { user: 'bob' }, { fingerprint: 'SHA256:' + 'B'.repeat(43) }, { destinationHost: 'other-server' }, { authentication: 'agent' as const }]) expect(sameConnectionProfile(original, { ...original, ssh: { ...ssh, ...patch } })).toBe(false)
})

it('tolerates incomplete dialog drafts without treating invalid profiles as reusable', () => {
  for (const patch of [{ name: '' }, { host: '' }, { port: 0 }, { engine: 'oracle' as const, database: '' }]) {
    const draft = { ...DEFAULT_PROFILE, ...patch }
    expect(() => sameConnectionProfile(DEFAULT_PROFILE, draft)).not.toThrow()
    expect(sameConnectionProfile(DEFAULT_PROFILE, draft)).toBe(false)
    expect(sameConnectionProfile(draft, draft)).toBe(false)
  }
  expect(sameConnectionProfile(DEFAULT_PROFILE, { ...DEFAULT_PROFILE })).toBe(true)
})
