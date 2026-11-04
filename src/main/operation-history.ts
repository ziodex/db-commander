import type { BackupJob } from '../shared/backup'
import type { TransferJob } from '../shared/transfer'
import type { DatabaseEngine } from '../shared/database-engines'
import type { OperationEntry } from '../shared/operation-history'

const volatileLimit = 80

/** This index contains no SQL, paths, raw errors, session names or credentials. */
export class OperationHistory {
  private entries = new Map<string, OperationEntry>()
  constructor(private notify: () => void, private now = () => new Date().toISOString()) {}

  update(entry: OperationEntry) {
    // Preserve active entries even while many short operations finish.
    this.entries.delete(entry.id)
    this.entries.set(entry.id, entry)
    const settled = [...this.entries.values()].filter(item => item.status !== 'running')
    for (const previous of settled.slice(0, Math.max(0, settled.length - volatileLimit))) this.entries.delete(previous.id)
    this.notify()
  }

  transfer(job: TransferJob, engine?: DatabaseEngine) {
    const id = `transfer:${job.id}`, previous = this.entries.get(id), at = this.now()
    const destination = job.action === 'copy' || job.action === 'import' ? job.session?.transaction : undefined
    this.update({
      id, kind: job.action, engine: previous?.engine ?? engine, status: job.status,
      startedAt: previous?.startedAt ?? at, finishedAt: job.status === 'running' ? undefined : previous?.finishedAt ?? at,
      rows: Number.isSafeInteger(job.rows) && job.rows >= 0 ? job.rows : undefined,
      destinationTransaction: destination === 'transaction' || destination === 'failed' ? 'open' : destination === 'unknown' ? 'unknown' : previous?.destinationTransaction,
      cancellationRequested: job.cancellationRequested
    })
  }

  interrupt() {
    let changed = false
    for (const entry of this.entries.values()) {
      if (entry.status !== 'running') continue
      this.entries.set(entry.id, { ...entry, status: 'unknown', finishedAt: this.now() })
      changed = true
    }
    if (changed) this.notify()
  }

  clearQueryEntries() {
    let changed = false
    for (const entry of this.entries.values()) {
      if (!['query', 'explain', 'schema'].includes(entry.kind) || entry.status === 'running') continue
      this.entries.delete(entry.id)
      changed = true
    }
    if (changed) this.notify()
  }

  list(backups: BackupJob[]) {
    const durable = backups.map((job): OperationEntry => ({
      id: `backup:${job.id}`, kind: job.action, engine: job.engine, status: job.status,
      startedAt: job.startedAt, finishedAt: job.finishedAt, cancellationRequested: job.cancellationRequested,
      journalWarning: !!job.historyError
    }))
    return [...durable, ...this.entries.values()].sort((a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt))
  }
}
