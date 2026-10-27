import { failureSource } from '../language/execution'
import type { ActivityObserver } from '../activity/control'
import { readActivity } from '../activity/read'
import type { DiagramScope } from '../shared/diagram'
import { readDiagram } from '../catalog/diagram'
import { bindRequest, boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { mysqlCatalog } from '../catalog/mysql'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import { TableEditor, runGridOperation } from './table-editor'
import type { GridResponse } from '../shared/contracts'
import { mysqlSchema } from './mysql-schema'
import { SessionResultCache } from './result-cache'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ResultSet, SchemaTable, SessionInfo } from '../shared/contracts'
import { exportResultCsv, type Completion, type DatabaseDriver, type Emit } from './driver'
import { mysqlKeyword, splitMysqlScript, type MysqlSqlMode } from '../shared/sql/mysql'
import { openMysqlTransport, type MysqlTransport } from './mysql-transport'
import { quoteIdentifier } from '../shared/sql/common'

interface Operation { id: string; cancelled: boolean; active: boolean; cancelPromise?: Promise<boolean>; done?: Promise<void> }
interface Session { editor?: TableEditor; client: MysqlTransport; config: ConnectionConfig; info: SessionInfo; mode: MysqlSqlMode; lost: boolean; busy?: Operation; metadata?: Promise<SchemaTable[]> }
const MAX_BYTES = 8 * 1024 * 1024

/** Shared workbench semantics, with distinct mysql2 and MariaDB transports. */
export class MysqlDriver implements DatabaseDriver {
  private sessions = new Map<string, Session>()
  private results = new SessionResultCache()
  constructor(private emit: Emit, readonly engine: 'mysql' | 'mariadb' = 'mysql') {}

  async connect(config: ConnectionConfig): Promise<SessionInfo> {
    if (config.engine !== this.engine) throw new Error('Connection engine does not match the selected driver.')
    const client = await openMysqlTransport(config)
    const session: Session = { client, config, lost: false, mode: { noBackslashEscapes: false, ansiQuotes: false }, info: {
      id: randomUUID(), engine: this.engine, name: config.name, database: config.database, user: config.user,
      host: config.host, port: config.port, tls: config.tls === 'verify-full', transaction: 'unknown', version: ''
    } }
    client.onLost(() => { if (this.sessions.has(session.info.id)) this.lost(session) })
    try {
      const rows = await client.query('SELECT VERSION(), DATABASE(), @@SESSION.sql_mode')
      session.info.version = rows[0][0]!
      this.context(session, rows[0].slice(1))
      await this.updateStatus(session)
      this.sessions.set(session.info.id, session)
      return { ...session.info }
    } catch (error) { client.destroy(); throw error }
  }
  private context(session: Session, row: (string | null)[]) {
    session.info.database = row[0] ?? ''
    const modes = (row[1] ?? '').split(',')
    session.mode = { noBackslashEscapes: modes.includes('NO_BACKSLASH_ESCAPES'), ansiQuotes: modes.includes('ANSI_QUOTES') }; session.info.mysqlSqlMode = { ...session.mode }
  }
  private lost(session: Session) {
    if (session.lost) return
    session.lost = true; session.info.transaction = 'unknown'
    void this.emit({ type: 'session-lost', sessionId: session.info.id, message: 'The database connection was lost. An in-flight operation may have an unknown outcome. Reconnect explicitly.' })
  }
  private session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.lost) throw new Error('This session is disconnected. Reconnect to create a new session.')
    return session
  }
  private async updateStatus(session: Session, afterError = false) {
    try {
      const status = await session.client.status(afterError)
      session.info.transaction = status & 1 ? 'transaction' : 'idle'
      session.info.autocommit = Boolean(status & 2)
      session.mode.noBackslashEscapes = Boolean(status & 512); session.info.mysqlSqlMode = { ...session.mode }
    } catch (error) { this.lost(session); session.client.destroy(); throw error }
  }
  async disconnect(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.busy) throw new Error('Stop the running query before disconnecting.')
    if (!session.lost && session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    this.results.forget(id); this.sessions.delete(id)
    if (session.lost) session.client.destroy()
    else await session.client.end()
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (request.action === 'release') this.results.forget(request.sessionId, request.viewId)
    if (session.busy) throw new Error('Wait for the running query before editing data.')
    session.editor ??= new TableEditor(this.engine, (sql, values) => session.client.bound(sql, values))
    const previous = (await session.client.bound('SELECT @@SESSION.innodb_lock_wait_timeout')).rows[0][0]
    await session.client.bound('SET SESSION innodb_lock_wait_timeout=2')
    try { return await runGridOperation(session.editor, request, session.info, () => this.updateStatus(session, true), context) }
    finally { await session.client.bound(`SET SESSION innodb_lock_wait_timeout=${Number(previous)}`) }
  }
  start(request: DriverRunRequest, completed?: (event: Completion) => void): string {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine, session.mode.noBackslashEscapes, session.mode.ansiQuotes)
    if (session.busy) throw new Error('This console already has a running query.')
    const statements = request.bound ? [request.sql] : splitMysqlScript(request.sql, session.mode)
    if (request.singleUnit && statements.length !== 1) throw new Error('Run current requires exactly one statement or batch. Select SQL explicitly or use Run script.')
    if (!statements.length) throw new Error('There is no SQL statement to execute.')
    if (statements.length > 200) throw new Error('A script may contain up to 200 statements in this preview.')
    // A mode change can change the boundaries of the rest of a script. Require
    // it in its own execution rather than misinterpret and execute that script.
    if (statements.length > 1 && statements.some(sql => /\bsql_mode\b/i.test(sql) && (mysqlKeyword(sql) === 'SET' || /^\s*\/\*[M!]/i.test(sql)))) {
      throw new Error('Run SQL_MODE changes separately, then execute the script using the new mode.')
    }
    session.editor?.invalidate()
    const operation: Operation = { id: request.queryId ?? randomUUID(), active: false, cancelled: false }
    session.busy = operation
    this.results.begin(request.sessionId, operation.id, request.fullExport, request.viewId)
    operation.done = this.execute(session, operation, request, statements, completed)
    return operation.id
  }
  private async execute(session: Session, operation: Operation, request: DriverRunRequest, statements: string[], completed?: (event: Completion) => void) {
    const started = performance.now()
    let activeStatement = -1
    let status: Completion['status'] = 'completed', message: string | undefined, code: string | undefined
    let remainingBytes = MAX_BYTES
    const retained = this.results.get(operation.id)!
    try {
      for (const statement of statements) {
        activeStatement++
        if (operation.cancelled) { status = 'cancelled'; break }
        let result: ResultSet | undefined, batch: (string | null)[][] = [], batchBytes = 0
        const flush = async () => {
          if (!batch.length || !result) return
          await this.emit({ type: 'rows', sessionId: session.info.id, queryId: operation.id, index: result.index, rows: batch })
          batch = []; batchBytes = 0
        }
        const announce = async () => {
          if (!result) return
          const { rows: _rows, ...metadata } = result
          await this.emit({ type: 'result', sessionId: session.info.id, queryId: operation.id, result: metadata })
        }
        const finish = async () => { await flush(); await announce() }
        const create = () => {
          if (retained.length >= 200) throw new Error('The execution exceeded the 200 result-set limit.')
          result = { index: retained.length, statement, columns: [], rows: [], rowCount: 0, command: mysqlKeyword(statement), truncated: false }
          retained.push(result)
          return result
        }
        operation.active = true
        try {
          for await (const frame of session.client.stream(request.bound?.sql ?? statement, request.bound?.values.map(boundValue))) {
            if (frame.kind === 'fields') {
              await finish(); create().columns = frame.columns; await announce()
            } else if (frame.kind === 'ok') {
              await finish(); create().rowCount = frame.affectedRows; await announce()
              if (frame.warnings) await this.emit({ type: 'notice', sessionId: session.info.id, queryId: operation.id, message: `${frame.warnings} server warning(s). Run SHOW WARNINGS to inspect them.` })
            } else {
              if (!result) throw new Error('Received rows without column metadata.')
              result.rowCount!++
              const size = frame.row.reduce((sum, value) => sum + (value === null ? 4 : Buffer.byteLength(value)), 0)
              // Keep draining after the cap: no SQL rewriting, hidden query kill,
              // or abandoned socket. Backpressure bounds memory; Stop still works.
              if (!request.fullExport && (result.truncated || result.rows.length >= request.maxRows || size > remainingBytes)) { result.truncated = true; continue }
              if (request.fullExport && size > 8 * 1024 * 1024) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.')
              if (!request.fullExport) { remainingBytes -= size; result.rows.push(frame.row) }; batch.push(frame.row); batchBytes += size
              if (batch.length >= 200 || batchBytes >= 128 * 1024) await flush()
            }
          }
          await finish()
        } catch (error) {
          const failure = error as Error & { fatal?: boolean; code?: string; errno?: number }
          // SQL errors finish the protocol normally. Consumer/IPC errors do not:
          // discard the session rather than reuse a half-consumed response.
          if ((failure.fatal && failure.errno !== 1317) || !failure.code) { this.lost(session); session.client.destroy() }
          throw error
        } finally { operation.active = false }
        await operation.cancelPromise
        if (operation.cancelled) { status = 'cancelled'; break }
        if (mysqlKeyword(statement) === 'USE' || /\bsql_mode\b/i.test(statement)) {
          this.context(session, (await session.client.query('SELECT DATABASE(), @@SESSION.sql_mode'))[0])
        }
        await this.updateStatus(session)
      }
    } catch (error) {
      const failure = error as Error & { code?: string; errno?: number }
      code = failure.code; message = failure.message
      status = session.lost ? 'unknown' : operation.cancelled && [1317, 1969].includes(failure.errno ?? 0) ? 'cancelled' : 'failed'
    } finally {
      // A late control connection must finish before this session is reusable.
      await operation.cancelPromise?.catch(() => false)
      if (!session.lost) {
        try { await this.updateStatus(session, status === 'failed' || status === 'cancelled') } catch (error) { message = (error as Error).message; status = 'unknown' }
      } else status = 'unknown'
      session.busy = undefined
      if (request.fullExport) this.results.finishStream(operation.id)
      const event: Completion = { type: 'complete', sessionId: session.info.id, queryId: operation.id, status, failure: status === 'failed' ? failureSource(request.sql, session.info.engine, activeStatement, Boolean(request.bound), session.info.mysqlSqlMode) : undefined,
        durationMs: Math.round(performance.now() - started), error: message, code, transaction: session.info.transaction,
        autocommit: session.info.autocommit, database: session.info.database, mysqlSqlMode: session.info.mysqlSqlMode }
      completed?.(event); await this.emit(event)
    }
  }
  async cancel(id: string): Promise<{ requested: boolean }> {
    const session = this.session(id), operation = session.busy
    if (!operation) return { requested: false }
    operation.cancelled = true
    operation.cancelPromise ??= (async () => {
      const control = await openMysqlTransport(session.config)
      try {
        if (!operation.active || session.lost) return false
        if (!Number.isSafeInteger(session.client.id) || session.client.id <= 0) throw new Error('Invalid server connection ID.')
        await control.query(`KILL QUERY ${session.client.id}`)
        return true
      } finally { await control.end().catch(() => control.destroy()) }
    })()
    return { requested: await operation.cancelPromise }
  }
  async listDatabases(id: string) {
    const session = this.session(id), client = await openMysqlTransport({ ...session.config, database: '' })
    try {
      const rows = await client.query('SHOW DATABASES'), databases: string[] = []
      // SHOW DATABASES alone can expose names through global privileges. Check
      // USE on this disposable connection, never on the user's physical session.
      for (const [name] of rows) {
        if (!name) continue
        try { await client.query(`USE ${quoteIdentifier(name, this.engine)}`); databases.push(name) }
        catch (error) { if (![1044, 1049].includes(Number((error as { errno?: number }).errno))) throw error }
      }
      return { databases: databases.sort(), current: session.info.database, switchable: true }
    } finally { await client.end().catch(() => { client.destroy() }) }
  }
  activity(id:string, includeSql:boolean) { return this.withActivity(id,o=>readActivity(o.engine,o.database,o.currentSessionId,o.query,includeSql)) }
  activityId(id:string) { const session=this.session(id); return String(session.client.id) }
  invalidateActivity(id:string) { const session=this.sessions.get(id);if(!session||session.lost)return;session.lost=true;session.info.transaction='unknown';void this.emit({type:'session-lost',sessionId:id,message:'Session termination was requested. The connection is no longer usable; verify rollback and reconnect explicitly.'}) }
  async withActivity<T>(id:string, read:(observer:ActivityObserver)=>Promise<T>):Promise<T> {
    const session=this.session(id), database=session.info.database, client=await openMysqlTransport({...session.config,database})
    const timer=setTimeout(()=>client.destroy(),15000)
    try { return await read({engine:this.engine,database,currentSessionId:String(session.client.id),query:sql=>client.query(sql)}) }
    finally { clearTimeout(timer);await client.end().catch(()=>client.destroy()) }
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id), client = await openMysqlTransport({ ...session.config, database: session.info.database })
    const timeout = setTimeout(() => client.destroy(), 20000)
    try { const query: import('../catalog/common').CatalogQuery=(sql,values)=>client.query(sql,values),adapter=mysqlCatalog(query,session.info.database);return diagram?{diagram:await readDiagram(adapter,query,session.info.engine,diagram,'catalog-connection')}:await inspect(adapter,object) }
    finally { clearTimeout(timeout); await client.end().catch(() => client.destroy()) }
  }
  async schema(id: string) {
    const session = this.session(id)
    const client = await openMysqlTransport({ ...session.config, database: session.info.database || session.config.database })
    const timeout = setTimeout(() => client.destroy(), 10000)
    try {
      return await mysqlSchema((sql,values)=>client.query(sql,values),session.info.database)
    } finally { clearTimeout(timeout); await client.end().catch(() => client.destroy()) }
  }
  async tables(id: string): Promise<SchemaTable[]> {
    const session = this.session(id)
    session.metadata ??= (async () => {
      const client = await openMysqlTransport({ ...session.config, database: session.info.database || session.config.database })
      try {
        const rows = await client.query(`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 2000`, [session.info.database])
        return rows.map(row => ({ schema: row[0]!, name: row[1]!, kind: row[2] === 'VIEW' ? 'view' : 'table' }))
      } finally { await client.end().catch(() => client.destroy()) }
    })().finally(() => { session.metadata = undefined })
    return session.metadata
  }
  async exportCsv(queryId: string, index: number, path: string) { await exportResultCsv(this.results.get(queryId)?.find(result => result.index === index), path) }
  getSession(id: string) { return { ...this.session(id).info } }
  async wait(id: string) { await this.sessions.get(id)?.busy?.done }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      if (session.busy) { await this.cancel(session.info.id).catch(() => {}); await session.busy?.done }
      this.results.forget(session.info.id); this.sessions.delete(session.info.id); session.client.destroy()
    }))
  }
}
