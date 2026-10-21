import type { BackupJob } from '../shared/backup'
import type { BackupJournal } from './journal'

/** Persistence errors describe the journal, never the database operation. */
export class BackupHistory {
  private jobs = new Map<string, BackupJob>()
  private revision = 0
  private historyError?: string
  constructor(private journal: Pick<BackupJournal, 'load' | 'save' | 'flush'>, private notify: (job: BackupJob) => void) {}
  async load() { for (const job of await this.journal.load()) this.jobs.set(job.id, job) }
  values() { return this.jobs.values() }
  list() { return [...this.values()].map(job => this.describe(job)) }
  private describe(job: BackupJob): BackupJob { return this.historyError ? { ...job, historyError: this.historyError } : job }
  publish(job: BackupJob) {
    this.jobs.set(job.id, job)
    for (const [id, previous] of this.jobs) if (this.jobs.size > 40 && previous.status !== 'running') this.jobs.delete(id)
    this.notify(this.describe(job))
    void this.retry()
  }
  retry() {
    const revision = ++this.revision
    const settled = (error?: unknown) => {
      // A queued older save must never replay its obsolete running/completed
      // snapshot or clear a warning belonging to the latest snapshot.
      if (revision !== this.revision) return
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      const detail = error instanceof Error && error.message.includes('kept intact') ? error.message
        : code === 'ENOSPC' ? 'The profile disk is full (ENOSPC). Free space and retry saving job history. Unsaved job history can be lost on exit.'
          : 'Check available space and profile folder write permissions, then retry saving job history. Unsaved job history can be lost on exit.'
      const notice = error ? `Job history could not be saved to disk. ${detail}` : undefined
      if (notice === this.historyError) return
      this.historyError = notice
      for (const current of this.values()) this.notify(this.describe(current))
    }
    return this.journal.save([...this.values()]).then(() => settled(), error => settled(error))
  }
  flush() { return this.journal.flush() }
}
