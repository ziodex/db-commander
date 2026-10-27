import { open, rename, rm, mkdir, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { BackupJob } from '../shared/backup'

const jobSchema = z.object({
  id: z.uuid(), sessionId: z.uuid(), engine: z.enum(['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql', 'oracle', 'sqlite', 'duckdb']),
  action: z.enum(['backup', 'restore']), database: z.string().max(4096), server: z.string().max(8192).optional(), artifact: z.string().max(4096), target: z.string().max(4096).optional(),
  startedAt: z.string().max(100), finishedAt: z.string().max(100).optional(), status: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']),
  phase: z.string().max(2000), log: z.array(z.string().max(2000)).max(40), cancellationRequested: z.boolean().optional()
}).strict()
/** Public job metadata only. Never serializes connection configs or credentials. */
export class BackupJournal {
  private pending: Promise<void> = Promise.resolve()
  private loadError?: Error
  constructor(private file: string) {}
  async load(): Promise<BackupJob[]> {
    try {
      const info = await lstat(this.file)
      if (!info.isFile() || info.size > 4_000_000) throw new Error('Invalid backup job history.')
      const file = await open(this.file, 'r')
      let contents: string
      try {
        // Bound the read even if the journal grows after lstat.
        const bytes = Buffer.alloc(4_000_001)
        let size = 0
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > 4_000_000) throw new Error('Invalid backup job history.')
        contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
      } finally { await file.close() }
      const jobs = z.array(jobSchema).max(40).parse(JSON.parse(contents)).map((job): BackupJob => job.status === 'running' ? {
        ...job, status: 'unknown', finishedAt: new Date().toISOString(), phase: 'The application ended before this job was confirmed. Inspect the artifact, server job and restore target before retrying. No operation was replayed.'
      } : job)
      this.loadError = undefined
      return jobs
    } catch (error) {
      this.loadError = (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : new Error('Backup job history could not be read and has been kept intact. Inspect or move backup-jobs.json and restart to enable history saving. No operation was replayed.')
      return []
    }
  }
  save(jobs: BackupJob[]) {
    const contents = JSON.stringify(jobs)
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (this.loadError) throw this.loadError
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
        await rename(temporary, this.file)
      }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
    })
    return this.pending
  }
  flush() { return this.pending }
}
