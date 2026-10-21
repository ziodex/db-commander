import type { SessionAccess } from '../driver/session-access'
import { randomUUID } from 'node:crypto'
import type { Completion } from '../driver/driver'
import { bindRequest } from '../driver/parameters'
import { transferRequestSchema, type TransferJob, type TransferRequest } from '../shared/transfer'
import { exportFile, validateExportSql } from './export'

export class TransferJobs {
  private jobs = new Map<string, TransferJob>()
  private controllers = new Map<string, AbortController>()
  constructor(private access: SessionAccess, private publishJob: (job: TransferJob) => void = () => {}) {}
  start(input: TransferRequest): TransferJob {
    const request = transferRequestSchema.parse(input), driver = this.access.driver(request.sessionId), session = driver.getSession(request.sessionId)
    this.access.protect(session.id)
    if (this.access.running(session.id)) throw new Error('Stop the running query before transferring data.')
    if (session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Commit or roll back and enable autocommit before transferring data.')
    if (this.controllers.size >= 2) throw new Error('Wait for one of the two active data transfers to finish.')
    if (request.action === 'export') {
      validateExportSql(request.sql, session.engine, session.mysqlSqlMode)
      // Validate bindings before reserving the session or touching the destination.
      // Adapters still compile through their own native execution path.
      bindRequest({ sessionId: session.id, sql: request.sql, parameters: request.parameters, maxRows: 1 }, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
    }
    const controller = new AbortController()
    const job: TransferJob = { id: randomUUID(), sessionId: session.id, action: request.action, file: request.file, rows: 0, status: 'running', phase: 'Starting data transfer' }
    this.jobs.set(job.id, job); this.controllers.set(job.id, controller)
    const publish = () => this.publishJob(structuredClone(job))
    let lastPublish = 0
    const context = { signal: controller.signal, progress: (rows: number) => { job.rows = rows; if (Date.now() - lastPublish > 200) { lastPublish = Date.now(); job.phase = `${rows} rows ${request.action === 'import' ? 'inserted; not committed' : 'written'}`; publish() } } }
    // Claim the session synchronously before announcing the running job.
    void this.access.operation(session.id, async () => {
      try {
        context.signal.throwIfAborted()
        if (request.action === 'import') {
          const response = await driver.editGrid(request, context)
          job.session = response.session
          if (response.error) throw new Error(response.error)
          job.rows = response.imported ?? 0
          job.phase = 'Import complete. Review the data, then Commit or Rollback in this tab.'
        } else {
          await exportFile(request, context, async consume => {
            const queryId = randomUUID()
            let failure: unknown, completion: Completion | undefined
            // A disk/format error cancels the query through its native path;
            // don't throw into a transport and abandon a half-consumed socket.
            const releaseConsumer = this.access.consume(queryId, async event => {
              if (failure || event.type === 'complete') return
              try { await consume(event) } catch (error) { failure = error; void driver.cancel(session.id).catch(() => {}) }
            })
            const cancel = () => { void driver.cancel(session.id).catch(() => {}) }
            context.signal.addEventListener('abort', cancel, { once: true })
            try {
              context.signal.throwIfAborted()
              driver.start({ sessionId: session.id, queryId, sql: request.sql, parameters: request.parameters, maxRows: Number.MAX_SAFE_INTEGER, fullExport: true }, event => { completion = event })
              await driver.wait(session.id)
              if (failure) throw failure
              if (!completion || completion.status !== 'completed') {
                // Native conversion errors can echo bound values. Do not retain
                // those diagnostics in the transfer list or send them to the UI.
                if (request.parameters) throw new Error(`Parameterized export ${completion?.status ?? 'outcome unknown'}. No file was published. Check SQL and parameter types; server diagnostics were omitted because they may contain parameter values.`)
                throw new Error(completion?.error ?? `Export ${completion?.status ?? 'outcome unknown'}.`)
              }
            } finally { releaseConsumer(); context.signal.removeEventListener('abort', cancel) }
          }, session.engine)
          job.phase = 'Full result exported. Existing files were not replaced.'
        }
        job.status = 'completed'
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Data transfer failed.'
        job.status = /unknown|rollback could not|disconnected|worker closed|connection.*(?:lost|closed)/i.test(message) ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'
        // Job diagnostics are transient and never persist SQL or imported values.
        job.phase = message.slice(0, 2000)
      } finally {
        try { job.session = this.access.decorate(driver.getSession(session.id)) } catch { job.session = { ...session, transaction: 'unknown' } }
        this.controllers.delete(job.id)
        // Release the operation lock before publishing terminal status.
      }
    }).finally(() => {
      publish()
      for (const [id, previous] of this.jobs) if (this.jobs.size > 40 && previous.status !== 'running') this.jobs.delete(id)
    })
    publish()
    return structuredClone(job)
  }
  list() { return [...this.jobs.values()].map(job => structuredClone(job)) }
  cancel(id: string) {
    const controller = this.controllers.get(id), job = this.jobs.get(id)
    if (!controller || !job) return { requested: false }
    if (job.cancellationRequested) return { requested: true }
    job.cancellationRequested = true; job.phase = 'Cancellation requested; waiting for the current database call and rollback.'
    this.publishJob(structuredClone(job)); controller.abort(new Error('Cancellation requested.'))
    return { requested: true }
  }
  async wait(id: string) { const job = this.jobs.get(id); if (job) await this.access.wait(job.sessionId); return this.jobs.get(id) }
}
