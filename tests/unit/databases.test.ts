import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { connectionSchema, DEFAULT_PROFILE, MAX_TABS, profileSchema, type SessionInfo } from '../../src/shared/contracts'
import { canSwitchDatabase, emptyTabState, applyDatabaseEvent } from '../../src/renderer/query-tabs'
import { DriverRegistry } from '../../src/driver/registry'
import { PostgresDriver } from '../../src/driver/postgres'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'
const config = { ...DEFAULT_PROFILE, password: '', database: '' }
afterEach(() => vi.restoreAllMocks())
it('accepts omitted database names in connections and saved profiles while requiring an Oracle service', () => {
  const { database: _, ...omitted } = config
  for (const engine of ['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql'] as const) {
    expect(connectionSchema.parse({ ...omitted, engine }).database).toBe('')
    const { password: _, ...profile } = { ...omitted, engine }
    expect(profileSchema.parse(profile).database).toBe('')
  }
  expect(connectionSchema.safeParse({ ...omitted, engine: 'oracle' }).success).toBe(false)
  expect(profileSchema.safeParse({ ...DEFAULT_PROFILE, engine: 'oracle', database: ' ' }).success).toBe(false)
  expect(buildSqlServerConfig({ ...config, engine: 'sqlserver' }).options?.database).toBeUndefined()
  expect(buildSqlServerConfig({ ...config, engine: 'azure-sql' }).options?.database).toBe('master')
})
function fake() {
  const sessions = new Map<string, SessionInfo>()
  const connect = vi.spyOn(PostgresDriver.prototype, 'connect').mockImplementation(async value => {
    const info: SessionInfo = { ...value, id: randomUUID(), tls: true, database: value.database || 'postgres', transaction: 'idle', version: 'test' }
    sessions.set(info.id, info); return info
  })
  vi.spyOn(PostgresDriver.prototype, 'getSession').mockImplementation(id => {
    const session = sessions.get(id); if (!session) throw new Error('disconnected'); return { ...session }
  })
  const disconnect = vi.spyOn(PostgresDriver.prototype, 'disconnect').mockImplementation(async id => { sessions.delete(id) })
  return { sessions, connect, disconnect, registry: new DriverRegistry(() => {}) }
}
it('replaces a session at the tab limit without leaking capacity after repeated target failures', async () => {
  const { registry, sessions, connect } = fake()
  const first = await registry.connect(config)
  for (let i = 1; i < MAX_TABS; i++) await registry.connect(config)
  for (let i = 0; i < 3; i++) {
    connect.mockRejectedValueOnce(new Error('denied'))
    await expect(registry.switchDatabase({ sessionId: first.id, database: 'denied' })).rejects.toThrow('denied')
    expect(registry.getSession(first.id).database).toBe('postgres')
  }
  const next = await registry.switchDatabase({ sessionId: first.id, database: 'target' })
  expect(sessions.size).toBe(MAX_TABS); expect(sessions.has(first.id)).toBe(false)
  await expect(registry.connect(config)).rejects.toThrow('Up to')
  await registry.disconnect(next.id); await registry.connect(config)
  expect(sessions.size).toBe(MAX_TABS)
})
it('closes the candidate and keeps the original if retiring the original is refused', async () => {
  const { registry, disconnect, sessions } = fake(), old = await registry.connect(config)
  disconnect.mockRejectedValueOnce(new Error('Cannot retire session'))
  await expect(registry.switchDatabase({ sessionId: old.id, database: 'target' })).rejects.toThrow('Cannot retire')
  expect([...sessions.keys()]).toEqual([old.id])
  expect(registry.getSession(old.id).database).toBe('postgres')
})
it('holds an exclusive session lock while the replacement connects', async () => {
  const { registry, connect } = fake(), old = await registry.connect(config)
  let reject!: (error: Error) => void
  connect.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  const pending = registry.switchDatabase({ sessionId: old.id, database: 'target' })
  const rejection = expect(pending).rejects.toThrow('unavailable')
  await Promise.resolve()
  expect(() => registry.start({ sessionId: old.id, sql: 'SELECT 1', maxRows: 10 })).toThrow('operation')
  await expect(registry.disconnect(old.id)).rejects.toThrow('operation')
  await expect(registry.switchDatabase({ sessionId: old.id, database: 'target' })).rejects.toThrow('operation')
  reject(new Error('unavailable')); await rejection
  expect(registry.getSession(old.id).database).toBe('postgres')
})
it('blocks switching with drafts, background operations and uncertain transactions; clears catalogs on host loss', () => {
  const state = { ...emptyTabState(), session: { id: randomUUID(), transaction: 'idle' } as SessionInfo }
  expect(canSwitchDatabase(state)).toBeUndefined()
  expect(canSwitchDatabase({ ...state, gridChanges: [{ kind: 'delete', row: 0 }] })).toContain('staged')
  expect(canSwitchDatabase({ ...state, running: true })).toContain('running query')
  for (const key of ['gridBusy', 'schemaLoading', 'databasesLoading', 'switching'] as const) expect(canSwitchDatabase({ ...state, [key]: true })).toContain('Wait')
  for (const transaction of ['transaction', 'failed', 'unknown'] as const) expect(canSwitchDatabase({ ...state, session: { ...state.session, transaction } })).toContain('Commit')
  expect(canSwitchDatabase({ ...state, session: { ...state.session, autocommit: false } })).toContain('autocommit')
  expect(applyDatabaseEvent({ ...state, switching: true, databasesLoading: true, databases: { databases: ['db'], current: 'db', switchable: true } }, { type: 'host-lost', message: 'lost' })).toMatchObject({ switching: false, databasesLoading: false, databases: null })
})
