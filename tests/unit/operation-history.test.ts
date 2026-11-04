import { describe, expect, it, vi } from 'vitest'
import { OperationHistory } from '../../src/main/operation-history'
import type { BackupJob } from '../../src/shared/backup'
import type { OperationEntry } from '../../src/shared/operation-history'

const time = '2026-11-04T12:00:00.000Z'
const job: BackupJob = {
  id: 'backup-job', sessionId: 'private-session', engine: 'postgres', action: 'restore', status: 'completed',
  database: 'private-database', server: 'private-server', artifact: 'private-path', target: 'private-target',
  startedAt: time, finishedAt: time, phase: 'private-phase', log: ['private-log'], historyError: 'private-journal-error'
}
const query: OperationEntry = { id: 'query', kind: 'query', startedAt: time, status: 'running' }

describe('unified operation history', () => {
  it('projects only operational metadata and keeps pending import writes explicit', () => {
    const history = new OperationHistory(vi.fn(), () => time)
    history.transfer({ id: 'import', sessionId: 'private-session', action: 'import', status: 'completed', phase: 'private-error',
      file: 'private-file', rows: 37, session: { id: 'private-session', engine: 'sqlite', name: 'private-name', database: 'private-db',
        user: 'private-user', host: 'private-host', port: 1, tls: false, transaction: 'transaction', version: '0' } }, 'sqlite')
    const entries = history.list([job])
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'restore', journalWarning: true }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'import', rows: 37, destinationTransaction: 'open' }))
    expect(JSON.stringify(entries)).not.toContain('private')
  })
  it('retains live operations across eviction and settles them as unknown on host loss', () => {
    const history = new OperationHistory(vi.fn(), () => time)
    history.update(query)
    for (let index = 0; index < 100; index++) history.update({ ...query, id: `settled-${index}`, status: 'completed' })
    expect(history.list([])).toHaveLength(81)
    expect(history.list([])[0]).toEqual(query)
    history.interrupt()
    expect(history.list([])).toContainEqual({ ...query, status: 'unknown', finishedAt: time })
    history.clearQueryEntries()
    expect(history.list([job]).map(row => row.kind)).toEqual(['restore'])
  })
})
