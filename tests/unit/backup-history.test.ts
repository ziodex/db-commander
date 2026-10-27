import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BackupHistory } from '../../src/backup/history'
import type { BackupJob } from '../../src/shared/backup'

const job = (): BackupJob => ({ id: randomUUID(), sessionId: randomUUID(), engine: 'sqlite', action: 'backup', database: 'local', artifact: '/backup', status: 'running', startedAt: new Date().toISOString(), phase: 'Starting', log: [] })
function fixture() {
  const writes: { jobs: BackupJob[]; resolve(): void; reject(error: Error): void }[] = [], events: BackupJob[] = []
  const history = new BackupHistory({ load: async () => [], flush: async () => {}, save: jobs => new Promise<void>((resolve, reject) => writes.push({ jobs, resolve, reject })) }, event => events.push(event))
  return { history, writes, events }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
describe('backup job status during journal failures', () => {
  it('never republishes an obsolete running snapshot when its delayed write fails', async () => {
    const { history, writes, events } = fixture(), running = job(), completed: BackupJob = { ...running, status: 'completed', phase: 'Backup completed' }
    history.publish(running); history.publish(completed)
    writes[0].reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })); await settle()
    expect(events.map(event => event.status)).toEqual(['running', 'completed'])
    writes[1].reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })); await settle()
    expect(history.list()).toMatchObject([{ status: 'completed', phase: 'Backup completed', historyError: expect.stringContaining('ENOSPC') }])
    expect(events.at(-1)).toEqual(history.list()[0])
    history.publish({ ...completed, phase: 'Latest completed state' }); writes[2].resolve(); await settle()
    expect(history.list()[0]).not.toHaveProperty('historyError')
    expect(writes[2].jobs[0]).not.toHaveProperty('historyError')
    expect(events.at(-1)).toEqual(history.list()[0])
  })
  it('keeps the latest warning across job updates until their full snapshot is saved', async () => {
    const { history, writes, events } = fixture(), first = job(), second = job()
    history.publish(first); writes[0].reject(new Error('permission denied')); await settle()
    history.publish(second)
    expect(history.list().every(item => item.historyError?.includes('write permissions'))).toBe(true)
    history.publish({ ...second, status: 'cancelled' })
    writes[1].resolve(); await settle()
    expect(history.list().every(item => item.historyError?.includes('write permissions'))).toBe(true)
    writes[2].resolve(); await settle()
    expect(history.list().every(item => !item.historyError)).toBe(true)
    expect(events.at(-1)).toMatchObject({ id: second.id, status: 'cancelled' })
  })
  it('retries only the journal snapshot without publishing or starting another operation', async () => {
    const { history, writes } = fixture(), completed: BackupJob = { ...job(), status: 'completed' }
    history.publish(completed); writes[0].reject(new Error('disk full')); await settle()
    const retry = history.retry()
    expect(writes[1].jobs).toEqual([completed])
    writes[1].resolve(); await retry
    expect(history.list()).toEqual([completed])
  })
  it('retains a running job while limiting completed history to forty jobs', async () => {
    const { history, writes } = fixture(), running = job()
    history.publish(running)
    for (let index = 0; index < 45; index++) history.publish({ ...job(), status: 'completed' })
    writes.forEach(write => write.resolve()); await settle()
    expect(history.list()).toHaveLength(40)
    expect(history.list()[0]).toEqual(running)
  })
})
