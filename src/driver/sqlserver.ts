import { failureSource } from '../language/execution'
import type { ActivityObserver } from '../activity/control'
import { readActivity } from '../activity/read'
import type { DiagramScope } from '../shared/diagram'
import { readDiagram } from '../catalog/diagram'
import { bindRequest, boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { sqlServerCatalog } from '../catalog/sqlserver'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import { TableEditor, runGridOperation } from './table-editor'
import type { GridResponse } from '../shared/contracts'
import { schemaSnapshot } from './schema'
import { SessionResultCache } from './result-cache'
import { randomUUID } from 'node:crypto'
import type { Connection } from 'tedious'
import type { ConnectionConfig, ResultSet, SchemaTable, SessionInfo } from '../shared/contracts'
import { exportResultCsv, type Completion, type DatabaseDriver, type Emit } from './driver'
import { splitSqlServerBatches } from '../shared/sql/sqlserver'
import { openSqlServer, sqlServerQuery, sqlServerBound, streamSqlServer } from './sqlserver-transport'

interface Operation { id: string; cancelled: boolean; cancel?: () => void; done?: Promise<void> }
interface Session { nativeId:string; editor?: TableEditor; client: Connection; config: ConnectionConfig; info: SessionInfo; lost: boolean; busy?: Operation; metadata?: Promise<SchemaTable[]> }
export class SqlServerDriver implements DatabaseDriver {
  private sessions = new Map<string, Session>()
  private results = new SessionResultCache()
  constructor(private emit: Emit, readonly engine: 'sqlserver' | 'azure-sql' = 'sqlserver') {}
  async connect(config: ConnectionConfig): Promise<SessionInfo> {
    if (config.engine !== this.engine) throw new Error('Connection engine does not match the selected driver.')
    const client = await openSqlServer(config)
    const session: Session = { nativeId:'', client, config, lost: false, info: {
      id: randomUUID(), engine: this.engine, name: config.name, database: config.database, user: config.user,
      host: config.host, port: config.port, tls: config.tls === 'verify-full', transaction: 'unknown', version: ''
    } }
    const lost = () => { if (this.sessions.has(session.info.id)) this.lost(session) }
    client.on('error', lost); client.on('end', lost)
    client.on('databaseChange', database => { session.info.database = database })
    try {
      const [server]=await sqlServerQuery(client,'SELECT @@VERSION,@@SPID');session.info.version=server[0]!;session.nativeId=server[1]!
      await this.updateStatus(session)
      this.sessions.set(session.info.id, session)
      return { ...session.info }
    } catch (error) { client.close(); throw error }
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
  private async updateStatus(session: Session) {
    try {
      // Capture transaction state before the metadata SELECT. Combining
      // XACT_STATE with system variables can observe that SELECT's own work
      // and falsely mark an autocommit session as having an open transaction.
      const [row] = await sqlServerQuery(session.client, `DECLARE @dbcommander_state smallint = XACT_STATE();
        DECLARE @dbcommander_options int = @@OPTIONS;
        SELECT @dbcommander_state, @dbcommander_options, DB_NAME()`)
      session.info.transaction = row[0] === '-1' ? 'failed' : row[0] === '1' ? 'transaction' : 'idle'
      session.info.autocommit = !(Number(row[1]) & 2)
      session.info.database = row[2]!
    } catch (error) { this.lost(session); session.client.close(); throw error }
  }
  async disconnect(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.busy) throw new Error('Stop the running query before disconnecting.')
    if (!session.lost && session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    this.results.forget(id); this.sessions.delete(id); session.client.close()
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (request.action === 'release') this.results.forget(request.sessionId, request.viewId)
    if (session.busy) throw new Error('Wait for the running query before editing data.')
    session.editor ??= new TableEditor(this.engine, (sql, values) => sqlServerBound(session.client, sql, values))
    const options = await sqlServerBound(session.client, 'DBCC USEROPTIONS')
    if (options.rows.some(row => row[0]?.toLowerCase() === 'rowcount' && Number(row[1]) !== 0)) return { session: { ...session.info }, error: 'Run SET ROWCOUNT 0 before opening or applying table edits.' }
    const previous = (await sqlServerBound(session.client, 'SELECT @@LOCK_TIMEOUT')).rows[0][0]
    await sqlServerBound(session.client, 'SET LOCK_TIMEOUT 2000')
    try { return await runGridOperation(session.editor, request, session.info, () => this.updateStatus(session), context) }
    finally { await sqlServerBound(session.client, `SET LOCK_TIMEOUT ${Number(previous)}`) }
  }
  start(request: DriverRunRequest, completed?: (event: Completion) => void): string {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine)
    if (session.busy) throw new Error('This console already has a running query.')
    const batches = request.bound ? [request.sql] : splitSqlServerBatches(request.sql)
    if (request.singleUnit && batches.length !== 1) throw new Error('Run current requires exactly one statement or batch. Select SQL explicitly or use Run script.')
    if (!batches.length) throw new Error('There is no SQL statement to execute.')
    session.editor?.invalidate()
    const operation: Operation = { id: request.queryId ?? randomUUID(), cancelled: false }
    session.busy = operation; this.results.begin(request.sessionId, operation.id, request.fullExport, request.viewId)
    operation.done = this.execute(session, operation, request, batches, completed)
    return operation.id
  }
  private async execute(session: Session, operation: Operation, request: DriverRunRequest, statements: string[], completed?: (event: Completion) => void) {
    const started = performance.now()
    let activeStatement = -1
    let status: Completion['status'] = 'completed', message: string | undefined, code: string | undefined
    let remainingBytes = 8 * 1024 * 1024, noticeCount = 0
    const retained = this.results.get(operation.id)!
    try {
      for (const statement of statements) {
        activeStatement++
        if (operation.cancelled) { status = 'cancelled'; break }
        let result: ResultSet | undefined, batch: (string | null)[][] = [], batchBytes = 0
        const announce = async () => {
          if (!result) return
          const { rows: _rows, ...metadata } = result
          await this.emit({ type: 'result', sessionId: session.info.id, queryId: operation.id, result: metadata })
        }
        const flush = async () => {
          if (!result || !batch.length) return
          await this.emit({ type: 'rows', sessionId: session.info.id, queryId: operation.id, index: result.index, rows: batch })
          batch = []; batchBytes = 0
        }
        const finish = async () => { await flush(); await announce(); result = undefined }
        const create = () => {
          if (retained.length >= 200) throw new Error('The execution exceeded the 200 result-set limit.')
          result = { index: retained.length, statement, columns: [], rows: [], rowCount: 0, command: 'T-SQL', truncated: false }
          retained.push(result); return result
        }
        const stream = streamSqlServer(session.client, request.bound?.sql ?? statement, request.bound?.values.map(boundValue))
        operation.cancel = stream.cancel
        try {
          for await (const frame of stream.frames) {
            if (frame.kind === 'fields') { await finish(); create().columns = frame.columns; await announce() }
            else if (frame.kind === 'done') {
              if (result) { if (frame.count !== undefined) result.rowCount = frame.count; await finish() }
              // DONE counts also occur for DECLARE/SET and DML. Without
              // column metadata these are messages, not empty result sets.
              else if (frame.count !== undefined && noticeCount++ < 100) await this.emit({ type: 'notice', sessionId: session.info.id, queryId: operation.id, message: `${frame.count} ${frame.count === 1 ? 'row' : 'rows'} affected.` })
            } else if (frame.kind === 'row') {
              if (!result) throw new Error('Received rows without column metadata.')
              result.rowCount!++
              const size = frame.row.reduce((sum, value) => sum + (value === null ? 4 : Buffer.byteLength(value)), 0)
              if (!request.fullExport && (result.truncated || result.rows.length >= request.maxRows || size > remainingBytes)) { result.truncated = true; continue }
              if (request.fullExport && size > 8 * 1024 * 1024) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.')
              if (!request.fullExport) { remainingBytes -= size; result.rows.push(frame.row) }; batch.push(frame.row); batchBytes += size
              if (batch.length >= 200 || batchBytes >= 128 * 1024) await flush()
            } else if (frame.kind === 'notice') {
              if (noticeCount++ < 100) await this.emit({ type: 'notice', sessionId: session.info.id, queryId: operation.id, message: frame.message.slice(0, 8192) })
            } else { await finish(); throw frame.error }
          }
          await finish()
        } catch (error) {
          const failure = error as Error & { code?: string }
          // Only SQL errors and acknowledged ATTENTION leave a reusable socket.
          if (!['EREQUEST', 'ECANCEL'].includes(failure.code ?? '')) { this.lost(session); session.client.close() }
          throw error
        } finally { operation.cancel = undefined }
      }
      if (operation.cancelled) status = 'cancelled'
    } catch (error) {
      const failure = error as Error & { code?: string; errors?: Error[] }
      code = failure.code; message = failure.message || failure.errors?.map(error => error.message).join('\n')
      status = session.lost ? 'unknown' : operation.cancelled && code === 'ECANCEL' ? 'cancelled' : 'failed'
    } finally {
      if (!session.lost) {
        try { await this.updateStatus(session) } catch (error) { message = (error as Error).message; status = 'unknown' }
      } else status = 'unknown'
      session.busy = undefined
      if (request.fullExport) this.results.finishStream(operation.id)
      const event: Completion = { type: 'complete', sessionId: session.info.id, queryId: operation.id, status, failure: status === 'failed' ? failureSource(request.sql, session.info.engine, activeStatement, Boolean(request.bound)) : undefined, durationMs: Math.round(performance.now() - started), error: message, code,
        transaction: session.info.transaction, autocommit: session.info.autocommit, database: session.info.database }
      completed?.(event); await this.emit(event)
    }
  }
  async cancel(id: string) {
    const operation = this.session(id).busy
    if (!operation) return { requested: false }
    operation.cancelled = true; operation.cancel?.()
    return { requested: true }
  }
  async listDatabases(id: string) {
    const session = this.session(id)
    let client: Connection
    try { client = await openSqlServer({ ...session.config, database: this.engine === 'azure-sql' ? 'master' : session.info.database }) }
    catch (error) {
      if (this.engine !== 'azure-sql' || (error as { code?: string }).code !== 'ELOGIN') throw error
      return { databases: [session.info.database], current: session.info.database, switchable: true,
        notice: 'Logical-server master is unavailable to this account. Only the current database is listed. Connect with an explicit database for contained users.' }
    }
    try {
      // Azure SQL Database has no cross-database HAS_DBACCESS. Probe each
      // master-visible name with the same credentials using a new connection.
      const { rows } = await sqlServerBound(client, this.engine === 'azure-sql'
        ? 'SELECT name FROM sys.databases WHERE state=0 ORDER BY name'
        : 'SELECT name FROM sys.databases WHERE state=0 AND HAS_DBACCESS(name)=1 ORDER BY name')
      const databases: string[] = []
      for (const [name] of rows) {
        if (!name) continue
        if (this.engine !== 'azure-sql' || name === session.info.database) { databases.push(name); continue }
        try { const probe = await openSqlServer({ ...session.config, database: name }); probe.close(); databases.push(name) }
        catch (error) { if ((error as { code?: string }).code !== 'ELOGIN') throw error }
      }
      if (!databases.includes(session.info.database)) databases.push(session.info.database)
      return { databases: databases.sort(), current: session.info.database, switchable: true,
        ...(this.engine === 'azure-sql' ? { notice: 'Lists databases visible in logical-server master that this account can open. Other contained databases require an explicit connection.' } : {}) }
    } finally { client.close() }
  }
  activity(id:string, includeSql:boolean) { return this.withActivity(id,o=>readActivity(o.engine,o.database,o.currentSessionId,o.query,includeSql)) }
  activityId(id:string) { const session=this.session(id); return session.nativeId }
  invalidateActivity(id:string) { const session=this.sessions.get(id);if(!session||session.lost)return;session.lost=true;session.info.transaction='unknown';void this.emit({type:'session-lost',sessionId:id,message:'Session termination was requested. The connection is no longer usable; verify rollback and reconnect explicitly.'}) }
  async withActivity<T>(id:string, read:(observer:ActivityObserver)=>Promise<T>):Promise<T> {
    const session=this.session(id), database=session.info.database, client=await openSqlServer({...session.config,database})
    const timer=setTimeout(()=>client.close(),15000)
    try { return await read({engine:this.engine,database,currentSessionId:session.nativeId,query:sql=>sqlServerQuery(client,sql,501)}) }
    finally { clearTimeout(timer);client.close() }
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id), client = await openSqlServer({ ...session.config, database: session.info.database })
    const timeout = setTimeout(() => client.close(), 20000)
    try { const query: import('../catalog/common').CatalogQuery=async(sql,values)=>(await sqlServerBound(client,sql,values)).rows,adapter=sqlServerCatalog(query);return diagram?{diagram:await readDiagram(adapter,query,session.info.engine,diagram,'catalog-connection')}:await inspect(adapter,object) }
    finally { clearTimeout(timeout); client.close() }
  }
  async schema(id: string) {
    const session = this.session(id), client = await openSqlServer({ ...session.config, database: session.info.database })
    const timeout = setTimeout(() => client.close(), 10000)
    try {
      const rows = await sqlServerQuery(client, `SELECT TOP (10001) NULL,s.name,o.name,CASE WHEN o.type='V' THEN 'view' ELSE 'table' END,
        c.name,t.name,c.is_nullable,c.column_id FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
        LEFT JOIN sys.columns c ON c.object_id=o.object_id LEFT JOIN sys.types t ON t.user_type_id=c.user_type_id
        WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name,c.column_id`, 10001)
      return schemaSnapshot(rows, session.info.database, 'catalog-connection')
    } finally { clearTimeout(timeout); client.close() }
  }
  async tables(id: string): Promise<SchemaTable[]> {
    const session = this.session(id)
    session.metadata ??= (async () => {
      const client = await openSqlServer({ ...session.config, database: session.info.database })
      try {
        const rows = await sqlServerQuery(client, `SELECT TOP (2000) s.name, o.name, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
          WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name, o.name`)
        return rows.map(row => ({ schema: row[0]!, name: row[1]!, kind: row[2]?.trim() === 'V' ? 'view' : 'table' }))
      } finally { client.close() }
    })().finally(() => { session.metadata = undefined })
    return session.metadata
  }
  async exportCsv(queryId: string, index: number, path: string) { await exportResultCsv(this.results.get(queryId)?.find(result => result.index === index), path) }
  getSession(id: string) { return { ...this.session(id).info } }
  async wait(id: string) { await this.sessions.get(id)?.busy?.done }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      if (session.busy) { await this.cancel(session.info.id).catch(() => {}); await session.busy?.done }
      this.results.forget(session.info.id); this.sessions.delete(session.info.id); session.client.close()
    }))
  }
}
