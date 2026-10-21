import type { SessionAccess } from '../driver/session-access'
import { randomUUID } from 'node:crypto'
import { backupCapabilities, backupRequestSchema, type BackupJob, type BackupRequest } from '../shared/backup'
import { logicalBackup } from './logical'
import { oracleBackup, sqlServerBackup } from './server'
import type { BackupOptions } from './tools'

export class BackupJobs {
  private jobs = new Map<string, BackupJob>()
  private controllers = new Map<string, AbortController>()
  constructor(private access: SessionAccess, private options: BackupOptions = {}, private publishJob: (job: BackupJob) => void = () => {}) {}
  start(input: BackupRequest): BackupJob {
    const request = backupRequestSchema.parse(input), driver = this.access.driver(request.sessionId), session = driver.getSession(request.sessionId)
    if (request.action === 'restore' || session.engine === 'azure-sql') this.access.protect(session.id)
    if (this.access.running(session.id)) throw new Error('Stop the running query before backup or restore.')
    if (session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Commit or roll back and enable autocommit before backup or restore.')
    if (this.controllers.size >= 2) throw new Error('Wait for one of the two active backup jobs to finish.')
    if (!session.database && request.action === 'backup') throw new Error('Select a database before creating a backup.')
    if (request.content !== 'all' && (!backupCapabilities[session.engine].schemaOnly || request.action === 'restore')) throw new Error('Schema-only mode is not supported for this operation.')
    const config = { ...this.access.config(session.id), database: session.database }
    if (config.ssh && ['mysql', 'mariadb'].includes(config.engine)) throw new Error('Native MySQL/MariaDB backup tools do not yet support managed SSH tunnels with verified database hostnames. Use a direct connection for backup/restore.')
    const controller = new AbortController()
    const job: BackupJob = { id: randomUUID(), sessionId: session.id, engine: session.engine, action: request.action, database: session.database, server: session.port ? `${session.host}:${session.port}` : session.host, artifact: request.artifact, target: request.target, status: 'running', phase: 'Checking backup requirements', startedAt: new Date().toISOString(), log: [] }
    this.jobs.set(job.id, job); this.controllers.set(job.id, controller)
    const redact = (text: string) => {
      for (const secret of [config.password, config.accessToken]) if (secret) for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) text = text.split(value).join('[redacted]')
      return text.slice(-2000)
    }
    const publish = () => this.publishJob(structuredClone(job))
    const log = (text: string) => { job.phase = redact(text); job.log.push(job.phase); job.log = job.log.slice(-40); publish() }
    void this.access.operation(session.id, async () => {
      try {
        const context = { signal: controller.signal, log }
        log(`${request.action === 'backup' ? 'Backup' : 'Restore'}: ${backupCapabilities[session.engine].format}`)
        if (driver.backup) await driver.backup(request, context)
        else if (['postgres', 'mysql', 'mariadb'].includes(session.engine)) await logicalBackup(config, request, context, this.options)
        else if (session.engine === 'oracle') await oracleBackup(config, request, context)
        else await sqlServerBackup(config, request, context)
        job.status = 'completed'; log('Completed. Verify the restored database before using it for production.')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Backup operation failed.'
        const unknown = (error as { outcomeUnknown?: boolean })?.outcomeUnknown || /connection.*(?:closed|lost)|worker.*closed|ECONN|socket|NJS-5|DPI-10/i.test(message) || controller.signal.aborted && session.engine === 'azure-sql'
        job.status = unknown ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'
        log(`${message}${request.action === 'restore' || session.engine === 'azure-sql' ? ' The target may contain partial changes. Inspect it before retrying; nothing was replayed.' : ' A server-side partial artifact or Data Pump job may remain; do not use it as a verified backup.'}`)
      } finally {
        job.finishedAt = new Date().toISOString(); this.controllers.delete(job.id); publish()
        for (const [id, previous] of this.jobs) if (this.jobs.size > 40 && previous.status !== 'running') this.jobs.delete(id)
      }
    })
    publish()
    return structuredClone(job)
  }
  list() { return [...this.jobs.values()].map(job => structuredClone(job)) }
  cancel(id: string) {
    const controller = this.controllers.get(id), job = this.jobs.get(id)
    if (!controller || !job) return { requested: false }
    job.cancellationRequested = true; job.phase = 'Cancellation requested; waiting for the engine to stop.'
    this.publishJob(structuredClone(job)); controller.abort(new Error('Cancellation requested.'))
    return { requested: true }
  }
  async wait(id: string) { const job = this.jobs.get(id); if (job) await this.access.wait(job.sessionId); return this.jobs.get(id) }
}
