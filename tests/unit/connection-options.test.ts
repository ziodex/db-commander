import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE, connectionSchema, profileSchema, workspaceSchema } from '../../src/shared/contracts'
import { credentialBinding } from '../../src/shared/credentials'
import { SessionProtection } from '../../src/connections/protection'
import { sshSchema } from '../../src/shared/connection-options'
import { routed } from '../../src/connections/transport'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'

const ssh = { host: 'bastion.example', port: 22, user: 'alice', authentication: 'password' as const, fingerprint: 'SHA256:'+'A'.repeat(43) }
it('persists organization and SSH public settings while rejecting secrets and host routing in profiles', () => {
  const profile = { ...DEFAULT_PROFILE, folder: 'Team / Reporting', favorite: true, environment: 'production' as const, ssh }
  const id = randomUUID()
  const workspace = workspaceSchema.parse({ version: 2, activeTabId: id, profiles: [{ id, config: profile }], tabs: [{ id, title: 'Query', profile, sql: '' }] })
  expect(workspace.profiles[0].config).toMatchObject(profile)
  expect(profileSchema.safeParse({ ...profile, sshSecrets: { password: 'secret' } }).success).toBe(false)
  expect(profileSchema.safeParse({ ...profile, ssh: { ...ssh, password: 'secret' } }).success).toBe(false)
  expect(connectionSchema.safeParse({ ...profile, password: '', localTunnelPort: 1234 }).success).toBe(false)
  expect(connectionSchema.safeParse({ ...profile, engine: 'sqlite', password: '' }).success).toBe(false)
  for (const fingerprint of ['', 'SHA256:unknown', 'accept-any']) expect(sshSchema.safeParse({ ...ssh, fingerprint }).success).toBe(false)
})
it('preserves existing vault bindings and binds SSH endpoint, identity and trust without including profile organization', () => {
  const original = credentialBinding(DEFAULT_PROFILE)
  expect(original).toBe(JSON.stringify(['postgres','localhost',5432,'postgres','postgres','sql-password','verify-full','']))
  expect(credentialBinding({ ...DEFAULT_PROFILE, folder: 'Moved', environment: 'production', favorite: true, protected: true })).toBe(original)
  const profile = { ...DEFAULT_PROFILE, ssh }
  for (const patch of [{ host: 'other' }, { port: 23 }, { user: 'bob' }, { fingerprint: 'SHA256:'+'B'.repeat(43) }, { destinationHost: 'other-db' }, { authentication: 'agent' as const }]) expect(credentialBinding({ ...profile, ssh: { ...ssh, ...patch } })).not.toBe(credentialBinding(profile))
})
it('locks production automatically, scopes unlocks to sessions, expires after ten minutes and permits explicit relocking', () => {
  let now = 1000
  const guard = new SessionProtection(() => now), config = { ...DEFAULT_PROFILE, password: '', environment: 'production' as const, protected: false }
  guard.add('one', config); guard.add('two', config)
  expect(() => guard.assert('one')).toThrow(/locked/)
  expect(() => guard.unlock('one','wrong')).toThrow(/exact/)
  expect(guard.unlock('one',config.name).unlockedUntil).toBe(601000)
  expect(() => guard.assert('one')).not.toThrow(); expect(() => guard.assert('two')).toThrow(/locked/)
  now = 601000; expect(() => guard.assert('one')).toThrow(/locked/)
  guard.unlock('one',config.name); guard.lock('one'); expect(() => guard.assert('one')).toThrow(/locked/)
  guard.forget('one'); expect(() => guard.status('one')).toThrow(/disconnected/)
  guard.add('dev', { ...config, environment: 'development' }); expect(() => guard.assert('dev')).not.toThrow()
})
it('keeps SQL Server TLS identity and rejects redirected destinations before opening a tunneled socket', async () => {
  const config = routed({ ...DEFAULT_PROFILE, password: '', engine: 'azure-sql' }, { host: '127.0.0.1', port: 9 })
  const options = buildSqlServerConfig(config)
  expect(options.server).toBe(DEFAULT_PROFILE.host); expect(options.options?.serverName).toBe(DEFAULT_PROFILE.host); expect(options.options?.trustServerCertificate).toBe(false)
  const connector = options.options!.connector as unknown as (options: { host: string; port: number }) => Promise<unknown>
  await expect(connector({ host: 'redirect.example', port: 1433 })).rejects.toThrow(/redirect/)
})
