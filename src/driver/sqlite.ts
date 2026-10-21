import type { DiagramScope } from '../shared/diagram'
import { bindRequest } from './parameters'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import type { GridResponse } from '../shared/contracts'
import type { BackupRequest } from '../shared/backup'
import type { BackupContext } from '../backup/context'
import { SessionResultCache } from './result-cache'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { sqliteWorkerPath } from './sqlite-worker-path'
import type { ConnectionConfig, DatabaseEvent, SchemaTable, SchemaSnapshot, SessionInfo } from '../shared/contracts'
import { type Completion, type DatabaseDriver, type Emit, exportResultCsv } from './driver'
import { inspectSqliteSql } from './sqlite-sql'

export interface SqliteDriverOptions { workerPath?: string; executablePath?: string }
interface Operation { id: string; fullExport?: boolean; started: number; completed?: (event: Completion) => void; done: Promise<void>; resolve(): void }
interface Session { importProgress?: (rows: number) => void; backupLog?: (message: string) => void; child: ChildProcess; info: SessionInfo; busy?: Operation; lost: boolean; stopped: boolean; closing: boolean; pending: Map<string, { resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>; events: Promise<void>; inspection?: Promise<SchemaSnapshot> }
/** Synchronous native SQLite is isolated per connection. Killing only this
 * worker can always stop a native VM step without blocking other drivers. */
export class SqliteDriver implements DatabaseDriver {
  private sessions = new Map<string, Session>()
  private results = new SessionResultCache()
  constructor(private emit: Emit, private options: SqliteDriverOptions = {}) {}
  private rpc(session: Session, method: string, payload?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = ['backup', 'editGrid'].includes(method) ? undefined : setTimeout(() => { session.pending.delete(id); reject(new Error('SQLite worker timed out. Reconnect explicitly.')); session.child.kill('SIGKILL') }, 15000)
      session.pending.set(id, { resolve, reject, timer })
      session.child.send({ id, method, payload }, error => { if (error) { clearTimeout(timer); session.pending.delete(id); reject(error) } })
    })
  }
  async connect(config: ConnectionConfig): Promise<SessionInfo> {
    if (config.engine !== 'sqlite') throw new Error('Expected a SQLite connection.')
    const child = fork(this.options.workerPath ?? sqliteWorkerPath(__dirname), [], { execPath: this.options.executablePath ?? process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    // Drain diagnostic output without echoing database paths or SQL literals.
    child.stderr?.resume()
    const session: Session = { child, lost: false, stopped: false, closing: false, pending: new Map(), events: Promise.resolve(), info: {
      id: randomUUID(), engine: 'sqlite', name: config.name, database: config.sqliteMode === 'memory' ? ':memory:' : basename(config.filePath ?? ''),
      user: 'local', host: config.sqliteMode === 'memory' ? ':memory:' : config.filePath ?? '', port: 0, tls: false, transaction: 'idle', autocommit: true, version: ''
    } }
    child.on('message', (message: { id?: string; ok?: boolean; error?: string; value?: unknown; event?: DatabaseEvent; ack?: number; backupProgress?: string; importProgress?: number }) => {
      if (message.importProgress !== undefined) { session.importProgress?.(message.importProgress); return }
      if (message.backupProgress) { session.backupLog?.(message.backupProgress); return }
      if (message.event) {
        const event = message.event
        session.events = session.events.then(async () => {
          if (session.lost) return
          if (event.type === 'result') {
            const results = this.results.get(event.queryId)
            if (results) results[event.result.index] = { ...event.result, rows: results[event.result.index]?.rows ?? [] }
          } else if (event.type === 'rows' && !session.busy?.fullExport) this.results.get(event.queryId)?.[event.index]?.rows.push(...event.rows)
          else if (event.type === 'complete') { await this.complete(session, event); return }
          await this.emit(event)
          if (message.ack && child.connected) child.send({ ack: message.ack })
        }).catch(() => { child.kill('SIGKILL') })
      } else if (message.id) {
        const pending = session.pending.get(message.id)
        if (pending) { clearTimeout(pending.timer); session.pending.delete(message.id); if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error)) }
      }
    })
    const lost = () => {
      if (session.lost) return
      session.lost = true; session.info.transaction = 'unknown'
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The SQLite worker closed. Reconnect explicitly.')) }
      session.pending.clear()
      session.events = session.events.then(async () => {
        if (session.busy) await this.complete(session, { type: 'complete', sessionId: session.info.id, queryId: session.busy.id, status: 'unknown', durationMs: Math.round(performance.now() - session.busy.started), transaction: 'unknown', error: 'SQLite session ended. In-flight statements may have completed; no SQL was replayed.' })
        if (!session.closing && this.sessions.has(session.info.id)) await this.emit({ type: 'session-lost', sessionId: session.info.id, message: session.stopped ? 'SQLite execution stopped by closing its session. Earlier statements may be committed; in-flight outcomes may be unknown. Reconnect explicitly. Temporary and in-memory databases are lost.' : 'The SQLite session was lost. In-flight outcomes may be unknown. Reconnect explicitly; no SQL was replayed.' })
      }).catch(() => {})
    }
    child.on('error', lost); child.on('exit', lost)
    try {
      const opened = await this.rpc(session, 'open', config)
      session.info.version = opened.version
      this.sessions.set(session.info.id, session)
      return { ...session.info }
    } catch (error) { session.closing = true; child.kill('SIGKILL'); throw error }
  }
  private session(id: string) { const session = this.sessions.get(id); if (!session || session.lost) throw new Error('This SQLite session is disconnected. Reconnect explicitly.'); return session }
  private async complete(session: Session, event: Completion) {
    const operation = session.busy
    session.info.transaction = event.transaction; session.info.autocommit = event.autocommit
    session.busy = undefined
    if (operation?.fullExport) this.results.finishStream(event.queryId)
    try { operation?.completed?.(event); await this.emit(event) } finally { operation?.resolve() }
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (session.busy || session.inspection) throw new Error('Wait for the query to finish before editing data.')
    context?.signal.throwIfAborted()
    const cancel = () => { void this.rpc(session, 'cancelImport').catch(() => {}) }
    context?.signal.addEventListener('abort', cancel, { once: true }); session.importProgress = context?.progress
    try {
      const response: GridResponse = await this.rpc(session, 'editGrid', { request, session: session.info })
      session.info = response.session
      return response
    } finally { context?.signal.removeEventListener('abort', cancel); session.importProgress = undefined }
  }
  async backup(request: BackupRequest, context: BackupContext) {
    const session = this.session(request.sessionId)
    context.signal.throwIfAborted()
    const cancel = () => { void this.rpc(session, 'cancelBackup').catch(() => {}) }
    context.signal.addEventListener('abort', cancel, { once: true })
    session.backupLog = context.log
    try { await this.rpc(session, 'backup', request) }
    finally { context.signal.removeEventListener('abort', cancel); session.backupLog = undefined }
  }
  start(request: DriverRunRequest, completed?: (event: Completion) => void) {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine)
    if (session.busy || session.inspection) throw new Error('This console already has a running query.')
    const inspected = inspectSqliteSql(request.sql)
    if (!inspected.hasSql) throw new Error('There is no SQL statement to execute.')
    if (inspected.hasParameters && !request.bound) throw new Error('SQLite parameter binding is not available yet. Supply literal SQL values explicitly; unbound parameters are not executed as NULL.')
    let resolve!: () => void
    const operation: Operation = { id: request.queryId ?? randomUUID(), fullExport: request.fullExport, started: performance.now(), completed, done: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
    session.busy = operation; this.results.begin(request.sessionId, operation.id, request.fullExport)
    void this.rpc(session, 'execute', { ...request, queryId: operation.id }).catch(() => { session.child.kill('SIGKILL') })
    return operation.id
  }
  async cancel(id: string) {
    const session = this.session(id)
    if (!session.busy) return { requested: false }
    session.stopped = true; session.child.kill('SIGKILL')
    await session.busy.done
    return { requested: true }
  }
  async disconnect(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.busy || session.inspection) throw new Error('Stop the running query before disconnecting.')
    if (!session.lost && session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    session.closing = true
    if (!session.lost) await this.rpc(session, 'close')
    this.results.forget(id); this.sessions.delete(id)
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id)
    if (session.busy || session.inspection) throw new Error('Wait for the SQLite operation to finish before inspecting objects.')
    return this.rpc(session, 'explore', {object,diagram})
  }
  async schema(id: string): Promise<SchemaSnapshot> {
    const session = this.session(id)
    if (session.inspection) return session.inspection
    if (session.busy) throw new Error('Wait for the SQLite query to finish before refreshing its schema.')
    session.inspection = this.rpc(session, 'schema').then(schema => ({ ...schema, database: session.info.database }))
    try { return await session.inspection! } finally { session.inspection = undefined }
  }
  async tables(id: string): Promise<SchemaTable[]> { const session = this.session(id); if (session.busy || session.inspection) throw new Error('Wait for the SQLite query to finish before refreshing its schema.'); return this.rpc(session, 'tables') }
  getSession(id: string) { return { ...this.session(id).info } }
  async wait(id: string) { await this.sessions.get(id)?.busy?.done }
  async exportCsv(id: string, index: number, path: string) { await exportResultCsv(this.results.get(id)?.[index], path) }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      session.closing = true
      if (session.busy && !session.lost) await this.cancel(session.info.id)
      if (!session.lost) await this.rpc(session, 'close').catch(() => { session.child.kill('SIGKILL') })
    }))
    this.sessions.clear(); this.results.clear()
  }
}
