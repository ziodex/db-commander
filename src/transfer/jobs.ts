import type { SessionAccess } from '../driver/session-access'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionInfo } from '../shared/contracts'
import type { Completion, DatabaseDriver } from '../driver/driver'
import { bindRequest } from '../driver/parameters'
import { transferRequestSchema, type TransferJob, type TransferRequest, type ImportContext, type DatabaseCopyReview } from '../shared/transfer'
import { exportFile, validateExportSql } from './export'

type ExportRequest = Extract<TransferRequest, { action: 'export' }>
interface Capture { review: DatabaseCopyReview; file: string; directory: string; timer: ReturnType<typeof setTimeout> }
export class TransferJobs {
  private jobs = new Map<string, TransferJob>()
  private controllers = new Map<string, AbortController>()
  private captures = new Map<string, Capture>()
  constructor(private access: SessionAccess, private publishJob: (job: TransferJob) => void = () => {}) {}
  async discardCapture(id: string) {
    const capture = this.captures.get(id)
    if (!capture) return
    this.retireCapture(id)
    await rm(capture.directory, { recursive: true, force: true })
  }
  private retireCapture(id: string) {
    const retained = this.captures.get(id)
    if (retained) clearTimeout(retained.timer)
    this.captures.delete(id)
    for (const job of this.jobs.values()) if (job.capture?.id === id) { delete job.capture; delete job.session; delete job.relatedSessions; job.reviewOnly = true; this.publishJob(structuredClone(job)) }
  }
  async close() { await Promise.all([...this.captures.keys()].map(id => this.discardCapture(id))) }
  start(input: TransferRequest): TransferJob {
    const request = transferRequestSchema.parse(input), driver = this.access.driver(request.sessionId), session = driver.getSession(request.sessionId)
    this.access.protect(session.id)
    const ids = [session.id]
    if (request.action === 'capture') {
      if (request.targetSessionId === session.id) throw new Error('Choose a different physical connection for the destination.')
      ids.push(request.targetSessionId)
      if (this.captures.size + [...this.jobs.values()].filter(job => job.action === 'capture' && job.status === 'running').length >= 2) throw new Error('Discard a captured transfer before preparing another. At most two captures can be retained.')
    }
    const drivers = new Map<string, DatabaseDriver>(), initialSessions = new Map<string, SessionInfo>()
    for (const id of ids) {
      const owned = this.access.driver(id); drivers.set(id, owned)
      const info = owned.getSession(id); initialSessions.set(id, info)
      if (this.access.running(id)) throw new Error('Stop running queries before transferring data.')
      if (info.transaction !== 'idle' || info.engine !== 'oracle' && info.autocommit === false) throw new Error('Commit or roll back and enable autocommit on both connections before transferring data.')
    }
    if (this.controllers.size >= 2) throw new Error('Wait for one of the two active data transfers to finish.')
    if (request.action === 'export' || request.action === 'capture') {
      validateExportSql(request.sql, session.engine, session.mysqlSqlMode)
      bindRequest({ sessionId: session.id, sql: request.sql, parameters: request.parameters, maxRows: 1 }, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
    }
    const retained = request.action === 'copy' ? this.captures.get(request.captureId) : undefined
    if (request.action === 'copy') {
      if (!retained || retained.review.targetSessionId !== session.id || request.signature !== retained.review.preview.signature) throw new Error('This captured transfer is unavailable. Capture and review the source again.')
      if (Date.now() >= Date.parse(retained.review.expiresAt)) { void this.discardCapture(request.captureId).catch(() => {}); throw new Error('This captured transfer expired. Capture and review the source again.') }
      // Consume before scheduling writes: no retry can replay this capture.
      this.retireCapture(request.captureId)
    }
    const controller = new AbortController()
    const job: TransferJob = { id: randomUUID(), sessionId: session.id, relatedSessionIds: ids, action: request.action, file: 'file' in request ? request.file : 'Private database capture', rows: 0, status: 'running', phase: 'Starting data transfer' }
    this.jobs.set(job.id, job); this.controllers.set(job.id, controller)
    const publish = () => this.publishJob(structuredClone(job))
    let lastPublish = 0
    const context: ImportContext = { signal: controller.signal, progress: rows => { job.rows = rows; if (Date.now() - lastPublish > 200) { lastPublish = Date.now(); job.phase = `${rows} rows ${request.action === 'import' || request.action === 'copy' ? 'inserted; not committed' : 'captured or written'}`; publish() } } }
    // Every reservation is installed synchronously before the work starts.
    const task = Promise.resolve().then(async () => {
      let temporary: string | undefined
      try {
        context.signal.throwIfAborted()
        if (request.action === 'import' || request.action === 'copy') {
          const importing = request.action === 'import' ? request : { action: 'import' as const, sessionId: session.id, table: retained!.review.table, file: retained!.file, format: 'json' as const, signature: request.signature, mapping: request.mapping, confirmed: true as const }
          const response = await driver.editGrid(importing, context)
          job.session = response.session
          if (response.error) throw new Error(response.error)
          job.rows = response.imported ?? 0
          job.phase = 'Import complete. Review the data, then Commit or Rollback in the destination tab.'
        } else if (request.action === 'capture') {
          temporary = await mkdtemp(join(tmpdir(), 'dbcommander-transfer-')); await chmod(temporary, 0o700)
          const file = join(temporary, 'rows.json')
          await this.writeExport({ action: 'export', sessionId: session.id, sql: request.sql, parameters: request.parameters, file, format: 'json', confirmed: true }, context, driver)
          context.signal.throwIfAborted()
          const target = drivers.get(request.targetSessionId)!
          const response = await target.editGrid({ action: 'inspect-import', sessionId: request.targetSessionId, table: request.table, file, format: 'json' })
          if (response.error || !response.importPreview) throw new Error(response.error ?? 'The destination cannot import this capture.')
          context.signal.throwIfAborted()
          const review: DatabaseCopyReview = { id: randomUUID(), sourceSessionId: session.id, targetSessionId: request.targetSessionId, table: request.table, preview: response.importPreview, rows: job.rows, expiresAt: new Date(Date.now() + 600000).toISOString() }
          const timer = setTimeout(() => { void this.discardCapture(review.id).catch(() => {}) }, 600000); timer.unref()
          this.captures.set(review.id, { review, file, directory: temporary, timer }); temporary = undefined
          job.capture = review
          job.phase = 'Source captured once. Review mappings before inserting these captured rows; the source query will not run again.'
        } else {
          await this.writeExport(request, context, driver)
          job.phase = 'Full result exported. Existing files were not replaced.'
        }
        job.status = 'completed'
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Data transfer failed.'
        job.status = /unknown|rollback could not|disconnected|worker closed|connection.*(?:lost|closed)/i.test(message) ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'
        job.phase = message.slice(0, 2000)
      } finally {
        for (const directory of [temporary, retained?.directory]) if (directory) {
          try { await rm(directory, { recursive: true, force: true }) } catch { job.phase += ' Private temporary data could not be removed; remove the dbcommander-transfer folder from the OS temporary directory.' }
        }
        job.relatedSessions = ids.map(id => { try { return this.access.decorate(drivers.get(id)!.getSession(id)) } catch { return { ...initialSessions.get(id)!, transaction: 'unknown' as const } } })
        job.session = job.relatedSessions[0]
        this.controllers.delete(job.id)
      }
    })
    void Promise.all(ids.map(id => this.access.operation(id, () => task))).finally(() => {
      publish()
      for (const [id, previous] of this.jobs) if (this.jobs.size > 40 && previous.status !== 'running') this.jobs.delete(id)
    })
    publish()
    return structuredClone(job)
  }
  private async writeExport(request: ExportRequest, context: ImportContext, driver: DatabaseDriver) {
    const session = driver.getSession(request.sessionId)
    await exportFile(request, context, async consume => {
      const queryId = randomUUID()
      let failure: unknown, completion: Completion | undefined
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
          if (request.parameters) throw new Error(`Parameterized export ${completion?.status ?? 'outcome unknown'}. No file was published. Check SQL and parameter types; server diagnostics were omitted because they may contain parameter values.`)
          throw new Error(completion?.error ?? `Export ${completion?.status ?? 'outcome unknown'}.`)
        }
      } finally { releaseConsumer(); context.signal.removeEventListener('abort', cancel) }
    }, session.engine)
  }
  list() { return [...this.jobs.values()].map(job => structuredClone(job)) }
  cancel(id: string) {
    const controller = this.controllers.get(id), job = this.jobs.get(id)
    if (!controller || !job) return { requested: false }
    if (job.cancellationRequested) return { requested: true }
    job.cancellationRequested = true; job.phase = 'Cancellation requested; waiting for database settlement and rollback.'
    this.publishJob(structuredClone(job)); controller.abort(new Error('Cancellation requested.'))
    return { requested: true }
  }
  async wait(id: string) { const job = this.jobs.get(id); if (job) await this.access.wait(job.sessionId); return this.jobs.get(id) }
}
