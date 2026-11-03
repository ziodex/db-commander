import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { PostgresDriver } from '../../src/driver/postgres'
import { DEFAULT_PROFILE, type SessionInfo } from '../../src/shared/contracts'

afterEach(() => vi.restoreAllMocks())

it('reserves a catalog read before metadata starts and keeps SQL/disconnect blocked until settlement', async () => {
  const session: SessionInfo = { ...DEFAULT_PROFILE, id: randomUUID(), version: 'fixture', transaction: 'idle', tls: true }
  vi.spyOn(PostgresDriver.prototype, 'connect').mockResolvedValue(session)
  vi.spyOn(PostgresDriver.prototype, 'getSession').mockReturnValue(session)
  const start = vi.spyOn(PostgresDriver.prototype, 'start').mockReturnValue(randomUUID())
  let resolve!: (value: { page: import('../../src/shared/catalog').CatalogPage }) => void
  const pending = new Promise<{ page: import('../../src/shared/catalog').CatalogPage }>(yes => { resolve = yes })
  vi.spyOn(PostgresDriver.prototype, 'explore').mockReturnValue(pending)
  const registry = new DriverRegistry(() => {})
  try {
    await registry.connect({ ...DEFAULT_PROFILE, password: '' })
    const reading = registry.catalogPage({ sessionId: session.id, search: '', rootsOnly: true })
    expect(() => registry.start({ sessionId: session.id, sql: 'SELECT 1', maxRows: 1 })).toThrow('operation')
    await expect(registry.disconnect(session.id)).rejects.toThrow('operation')
    expect(start).not.toHaveBeenCalled()
    resolve({ page: { objects: [], source: 'catalog-connection', notice: '', fetchedAt: 'now' } })
    expect((await reading).objects).toEqual([])
  } finally { await registry.close() }
})

it('reserves the backup session before publishing the first running event', async () => {
  const session: SessionInfo = { ...DEFAULT_PROFILE, id: randomUUID(), version: 'fixture', transaction: 'idle', tls: true }
  vi.spyOn(PostgresDriver.prototype, 'connect').mockResolvedValue(session)
  vi.spyOn(PostgresDriver.prototype, 'getSession').mockReturnValue(session)
  const start = vi.spyOn(PostgresDriver.prototype, 'start').mockReturnValue(randomUUID())
  let observed = false, blocked: unknown
  const registry = new DriverRegistry(() => {}, undefined, { runTool: async () => { throw new Error('Controlled native tool failure') } }, job => {
    if (observed || job.status !== 'running') return
    observed = true
    try { registry.start({ sessionId: session.id, sql: 'SELECT 1', maxRows: 1 }) } catch (error) { blocked = error }
  })
  try {
    await registry.connect({ ...DEFAULT_PROFILE, password: '' })
    const job = registry.startBackup({ sessionId: session.id, action: 'backup', artifact: '/unused-fixture.dump', content: 'all', confirmed: true })
    expect(observed).toBe(true)
    expect(blocked).toBeInstanceOf(Error)
    expect(blocked).toMatchObject({ message: expect.stringContaining('operation') })
    expect(start).not.toHaveBeenCalled()
    expect(await registry.waitBackup(job.id)).toMatchObject({ status: 'failed', phase: expect.stringContaining('Controlled native tool failure') })
  } finally { await registry.close() }
})
