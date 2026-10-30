import { beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE } from '../../src/shared/contracts'
import type { BackupInspection, BackupRequest } from '../../src/shared/backup'

const state = vi.hoisted(() => ({ queries: [] as string[], targetExists: false, sourceState: 'ONLINE' }))
vi.mock('../../src/driver/sqlserver-transport', () => ({
  openSqlServer: async () => ({ close() {} }),
  streamSqlServer: (_connection: unknown, sql: string) => {
    state.queries.push(sql)
    return { cancel() {}, frames: (async function* () {
      if (sql.startsWith('SELECT name') && state.targetExists) yield { kind: 'row', row: ['existing'] }
      if (sql.startsWith('SELECT state_desc')) yield { kind: 'row', row: [state.sourceState] }
    })() }
  }
}))
import { inspectBackupServer } from '../../src/backup/server-inspection'

beforeEach(() => { state.queries = []; state.targetExists = false; state.sourceState = 'ONLINE' })
const config = { ...DEFAULT_PROFILE, engine: 'azure-sql' as const, database: 'original', password: '', tls: 'verify-full' as const }
const context = () => ({ signal: new AbortController().signal, log() {} })
const result = (): BackupInspection => ({ checkedAt: new Date().toISOString(), ready: false, checks: [], metadata: [] })
const request = (action: 'backup' | 'restore'): BackupRequest => ({ sessionId: randomUUID(), action, artifact: 'recovery', target: 'restored', content: 'all', confirmed: true })

it.each(['backup', 'restore'] as const)('inspects an Azure %s using metadata only, without starting a billed copy', async action => {
  const output = result()
  await inspectBackupServer(config, request(action), context(), output)
  expect(output.metadata).toContainEqual({ label: 'Source database state', value: 'ONLINE' })
  expect(output.checks.some(check => /separately billed/.test(check.detail))).toBe(true)
  expect(state.queries).toHaveLength(2)
  expect(state.queries.every(sql => sql.startsWith('SELECT '))).toBe(true)
  expect(state.queries.join('\n')).not.toMatch(/CREATE|BACKUP|RESTORE|DROP/)
})
it('refuses an existing Azure target or a source that is not ONLINE without provisioning anything', async () => {
  state.targetExists = true
  await expect(inspectBackupServer(config, request('restore'), context(), result())).rejects.toThrow(/already exists/)
  expect(state.queries).toHaveLength(1)
  state.targetExists = false; state.sourceState = 'COPYING'
  await expect(inspectBackupServer(config, request('restore'), context(), result())).rejects.toThrow(/ONLINE/)
  expect(state.queries.every(sql => sql.startsWith('SELECT '))).toBe(true)
})
