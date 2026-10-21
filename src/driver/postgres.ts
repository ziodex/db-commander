import { failureSource } from '../language/execution'
import type { ActivityObserver } from '../activity/control'
import { readActivity } from '../activity/read'
import type { DiagramScope } from '../shared/diagram'
import { readDiagram } from '../catalog/diagram'
import { bindRequest, boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { postgresCatalog } from '../catalog/postgres'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import { TableEditor, runGridOperation } from './table-editor'
import type { GridResponse } from '../shared/contracts'
import { schemaSnapshot } from './schema'
import { SessionResultCache } from './result-cache'
import { randomUUID } from 'node:crypto'
import { exportResultCsv, type DatabaseDriver } from './driver'
import pg from 'pg'
import { endpoint } from '../connections/transport'
import { checkServerIdentity } from 'node:tls'
import { isIP } from 'node:net'
import Cursor from 'pg-cursor'
import type { Cell, ConnectionConfig, DatabaseEvent, ResultSet, SchemaTable, SessionInfo, TransactionState } from '../shared/contracts'
import { firstKeyword, splitPostgresScript } from '../shared/sql/common'

interface Operation { id: string; cancelled: boolean; cancelPromise?: Promise<boolean>; done?: Promise<void> }
interface Session { editor?: TableEditor; client: pg.Client; config: ConnectionConfig; info: SessionInfo; pid: number; busy?: Operation; lost: boolean; metadata?: Promise<SchemaTable[]> }
type Emit = (event: DatabaseEvent) => void | Promise<void>
const MAX_BYTES = 8 * 1024 * 1024
const rawTypes = { getTypeParser: () => (value: string) => value }

export class PostgresDriver implements DatabaseDriver {
  private sessions = new Map<string, Session>()
  private results = new SessionResultCache()
  constructor(private emit: Emit) {}

  private config(config: ConnectionConfig): pg.ClientConfig {
    return { ...endpoint(config), user: config.user, password: config.password, database: config.database || 'postgres',
      application_name: 'Db Commander', connectionTimeoutMillis: 8000, keepAlive: true,
      ssl: config.tls === 'verify-full' ? { rejectUnauthorized: true, ...(isIP(config.host) ? {} : { servername: config.host }), checkServerIdentity: (_host, cert) => checkServerIdentity(config.host, cert), ...(config.ca ? { ca: config.ca } : {}) } : false }
  }
  async connect(config: ConnectionConfig): Promise<SessionInfo> {
    const client = new pg.Client(this.config(config))
    const session: Session = { client, config, pid: 0, lost: false, info: { id: randomUUID(), engine: 'postgres', name: config.name, database: config.database, user: config.user,
      host: config.host, port: config.port, tls: config.tls === 'verify-full', transaction: 'unknown', version: '' } }
    const lost = () => {
      if (session.lost) return
      session.lost = true; session.info.transaction = 'unknown'
      void this.emit({ type: 'session-lost', sessionId: session.info.id, message: 'The database connection was lost. Any in-flight operation may have an unknown outcome. Reconnect explicitly.' })
    }
    client.on('error', lost)
    client.on('end', () => { if (this.sessions.has(session.info.id)) lost() })
    client.on('notice', (notice) => { if (session.busy) void this.emit({ type: 'notice', sessionId: session.info.id, queryId: session.busy.id, message: notice.message ?? 'Database notice' }) })
    // pg exposes no public transaction status API. This single, version-pinned
    // protocol hook is covered by the Docker transaction contract tests.
    const connection = (client as unknown as { connection: NodeJS.EventEmitter }).connection
    connection.on('readyForQuery', (message: { status: string }) => {
      session.info.transaction = ({ I: 'idle', T: 'transaction', E: 'failed' } as Record<string, TransactionState>)[message.status] ?? 'unknown'
    })
    try {
      await client.connect()
      const result = await client.query("SELECT pg_backend_pid() AS pid, version() AS version, current_database() AS database; SET standard_conforming_strings = on")
      const first = Array.isArray(result) ? result[0] : result
      session.pid = first.rows[0].pid
      session.info.version = first.rows[0].version
      session.info.database = first.rows[0].database
      this.sessions.set(session.info.id, session)
      return { ...session.info }
    } catch (error) { await client.end().catch(() => {}); throw error }
  }
  private session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.lost) throw new Error('This session is disconnected. Reconnect to create a new session.')
    return session
  }
  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.busy) throw new Error('Stop the running query before disconnecting.')
    if (!session.lost && session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    this.results.forget(id); this.sessions.delete(id)
    await session.client.end()
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (session.busy) throw new Error('Wait for the running query before editing data.')
    session.editor ??= new TableEditor('postgres', async (text, values = []) => {
      const result = await session.client.query({ text, values, rowMode: 'array', types: rawTypes })
      return { rows: result.rows, affected: result.rowCount ?? 0 }
    })
    return runGridOperation(session.editor, request, session.info, async () => {}, context)
  }
  start(request: DriverRunRequest, completed?: (event: Extract<DatabaseEvent, { type: 'complete' }>) => void): string {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine)
    if (session.busy) throw new Error('This console already has a running query.')
    const statements = request.bound ? [request.sql] : splitPostgresScript(request.sql)
    if (request.singleUnit && statements.length !== 1) throw new Error('Run current requires exactly one statement or batch. Select SQL explicitly or use Run script.')
    if (!statements.length) throw new Error('There is no SQL statement to execute.')
    if (statements.length > 200) throw new Error('A script may contain up to 200 statements in this preview.')
    // COPY protocol needs its own importer/exporter. It cannot run through Cursor.
    if (statements.some(sql => firstKeyword(sql) === 'COPY')) throw new Error('COPY is not supported in the query console yet. Use SELECT and Export CSV.')
    session.editor?.invalidate()
    const operation: Operation = { id: request.queryId ?? randomUUID(), cancelled: false }
    session.busy = operation
    this.results.begin(request.sessionId, operation.id, request.fullExport)
    operation.done = this.execute(session, operation, request, statements, completed)
    return operation.id
  }
  private async execute(session: Session, operation: Operation, request: DriverRunRequest, statements: string[], completed?: (event: Extract<DatabaseEvent, { type: 'complete' }>) => void): Promise<void> {
    const started = performance.now()
    let status: 'completed' | 'failed' | 'cancelled' | 'unknown' = 'completed'
    let errorMessage: string | undefined, code: string | undefined
    let activeStatement = -1
    let remainingBytes = MAX_BYTES
    try {
      for (let index = 0; index < statements.length; index++) {
        if (operation.cancelled) { status = 'cancelled'; break }
        activeStatement = index
        const statement = statements[index]
        // Server-side simple-query parsing safely handles SQL-standard function bodies
        // only when sent as one statement; unsupported script forms are documented.
        const cursor = session.client.query(new Cursor<Cell[]>(request.bound?.sql ?? statement, request.bound?.values.map(p=>p.type==='boolean'?p.value:boundValue(p)) ?? [], { rowMode: 'array', types: rawTypes }))
        const result: ResultSet = { index, statement, columns: [], rows: [], rowCount: null, command: '', truncated: false }
        this.results.get(operation.id)!.push(result)
        let announced = false
        let batchSize = 1
        try {
          while (true) {
            if (operation.cancelled) { status = 'cancelled'; break }
            const batch = await new Promise<{ rows: Cell[][]; result?: pg.QueryResult }>((resolve, reject) => {
              cursor.read(Math.min(batchSize, request.maxRows - result.rows.length + 1), (error, rows, value) => error ? reject(error) : resolve({ rows, result: value }))
            })
            if (!batch.result) break // pg-cursor omits metadata when read after completion.
            result.columns = batch.result.fields.map(field => ({ name: field.name, typeId: field.dataTypeID }))
            result.command = batch.result.command ?? ''
            result.rowCount = batch.result.rowCount
            if (!announced) { const { rows: _rows, ...metadata } = result; await this.emit({ type: 'result', sessionId: session.info.id, queryId: operation.id, result: metadata }); announced = true }
            const accepted: Cell[][] = []
            for (const row of batch.rows) {
              const size = row.reduce((sum, value) => sum + (value === null ? 4 : Buffer.byteLength(value)), 0)
              batchSize = Math.min(200, Math.max(1, Math.floor(128 * 1024 / Math.max(1, size))))
              if (!request.fullExport && (result.rows.length >= request.maxRows || size > remainingBytes)) { result.truncated = true; break }
              if (request.fullExport && size > MAX_BYTES) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.')
              if (!request.fullExport) { remainingBytes -= size; result.rows.push(row) }; accepted.push(row)
            }
            if (accepted.length) await this.emit({ type: 'rows', sessionId: session.info.id, queryId: operation.id, index, rows: accepted })
            if (result.truncated || !batch.rows.length || batch.result.command) break
          }
        } catch (error) {
          if (/^(57P0[123]|08)/.test((error as { code?: string }).code ?? '')) { session.lost = true; session.info.transaction = 'unknown' }
          throw error
        } finally {
          if (!session.lost) {
            await new Promise<void>((resolve, reject) => {
              const done = () => { clearTimeout(timer); session.client.removeListener('end', ended); resolve() }
              const ended = () => { session.lost = true; session.info.transaction = 'unknown'; done() }
              const timer = setTimeout(() => { session.client.removeListener('end', ended); session.lost = true; session.info.transaction = 'unknown'; void session.client.end(); reject(new Error('Connection did not finish closing its cursor; outcome unknown.')) }, 3000)
              session.client.once('end', ended)
              void cursor.close().then(done, error => { clearTimeout(timer); session.client.removeListener('end', ended); reject(error) })
            })
          }
        }
        const { rows: _rows, ...metadata } = result
        await this.emit({ type: 'result', sessionId: session.info.id, queryId: operation.id, result: metadata })
      }
    } catch (error) {
      const failure = error as Error & { code?: string }
      code = failure.code
      errorMessage = failure.message
      status = code === '57014' ? 'cancelled' : session.lost || /connection|socket|ECONN|EPIPE/i.test(`${code} ${errorMessage}`) ? 'unknown' : 'failed'
    } finally {
      // A late cancel must never target the next query on this physical session.
      await operation.cancelPromise?.catch(() => false)
      session.busy = undefined
      if (request.fullExport) this.results.finishStream(operation.id)
      const event: Extract<DatabaseEvent, { type: 'complete' }> = { type: 'complete', sessionId: session.info.id, queryId: operation.id, status, durationMs: Math.round(performance.now() - started), error: errorMessage, code, failure: status === 'failed' ? failureSource(request.sql, 'postgres', activeStatement, Boolean(request.bound)) : undefined, transaction: session.info.transaction }
      completed?.(event)
      await this.emit(event)
    }
  }
  async cancel(id: string): Promise<{ requested: boolean }> {
    const session = this.session(id), operation = session.busy
    if (!operation) return { requested: false }
    operation.cancelled = true
    operation.cancelPromise ??= (async () => {
      const control = new pg.Client(this.config(session.config))
      control.on('error', () => {})
      try { await control.connect(); const result = await control.query('SELECT pg_cancel_backend($1) AS cancelled', [session.pid]); return Boolean(result.rows[0].cancelled) }
      finally { await control.end().catch(() => {}) }
    })()
    return { requested: await operation.cancelPromise }
  }
  async listDatabases(id: string) {
    const session = this.session(id), client = new pg.Client(this.config(session.config))
    client.on('error', () => {})
    try {
      await client.connect()
      await client.query('SET statement_timeout = 10000')
      const result = await client.query(`SELECT datname FROM pg_catalog.pg_database
        WHERE datallowconn AND pg_catalog.has_database_privilege(datname, 'CONNECT') ORDER BY datname`)
      return { databases: result.rows.map(row => row.datname as string), current: session.info.database, switchable: true }
    } finally { await client.end().catch(() => {}) }
  }
  activity(id:string, includeSql:boolean) { return this.withActivity(id,o=>readActivity(o.engine,o.database,o.currentSessionId,o.query,includeSql)) }
  activityId(id:string) { const session=this.session(id); return String(session.pid) }
  invalidateActivity(id:string) { const session=this.sessions.get(id);if(!session||session.lost)return;session.lost=true;session.info.transaction='unknown';void this.emit({type:'session-lost',sessionId:id,message:'Session termination was requested. The connection is no longer usable; verify rollback and reconnect explicitly.'}) }
  async withActivity<T>(id:string, read:(observer:ActivityObserver)=>Promise<T>):Promise<T> {
    const session=this.session(id), database=session.info.database, client=new pg.Client({...this.config(session.config),database})
    client.on('error',()=>{})
    try {
      await client.connect();await client.query('SET statement_timeout = 5000');await client.query('SET search_path = pg_catalog')
      return await read({engine:'postgres',database,currentSessionId:String(session.pid),query:async sql=>(await client.query({text:sql,rowMode:'array',types:rawTypes})).rows})
    } finally { await client.end().catch(()=>{}) }
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id), client = new pg.Client(this.config(session.config))
    client.on('error', () => {})
    try {
      await client.connect(); await client.query('SET statement_timeout = 10000'); await client.query("SET search_path = pg_catalog")
      const query: import('../catalog/common').CatalogQuery = async (text, values = []) => (await client.query({ text, values, rowMode: 'array' })).rows.map(row => row.map((cell: unknown) => cell == null ? null : String(cell)))
      const adapter=postgresCatalog(query)
      return diagram ? { diagram: await readDiagram(adapter,query,'postgres',diagram,'catalog-connection') } : await inspect(adapter,object)
    } finally { await client.end().catch(() => {}) }
  }
  async schema(id: string) {
    const session = this.session(id), client = new pg.Client(this.config(session.config))
    client.on('error', () => {})
    try {
      await client.connect()
      await client.query('SET statement_timeout = 10000')
      const result = await client.query({ text: `SELECT NULL, n.nspname, c.relname,
        CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END,
        a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, a.attnum
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r','p','v','m','f') AND substring(n.nspname from 1 for 3)<>'pg_' AND n.nspname<>'information_schema'
          AND (pg_catalog.has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE') OR pg_catalog.has_any_column_privilege(c.oid,'SELECT'))
        ORDER BY n.nspname,c.relname,a.attnum LIMIT 10001`, rowMode: 'array' })
      return schemaSnapshot(result.rows, session.info.database, 'catalog-connection')
    } finally { await client.end().catch(() => {}) }
  }
  async tables(id: string): Promise<SchemaTable[]> {
    const session = this.session(id)
    session.metadata ??= (async () => {
      const client = new pg.Client(this.config(session.config))
      client.on('error', () => {})
      try {
        await client.connect()
        const result = await client.query<SchemaTable>(`SELECT n.nspname AS schema, c.relname AS name,
          CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END AS kind
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON c.relnamespace=n.oid
          WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY n.nspname, c.relname LIMIT 2000`)
        return result.rows
      } finally { await client.end().catch(() => {}); session.metadata = undefined }
    })()
    return session.metadata
  }
  async exportCsv(queryId: string, index: number, path: string): Promise<void> {
    await exportResultCsv(this.results.get(queryId)?.find(result => result.index === index), path)
  }
  getSession(id: string): SessionInfo { return { ...this.session(id).info } }
  async wait(id: string): Promise<void> { await this.session(id).busy?.done }
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      if (session.busy) { await this.cancel(session.info.id).catch(() => {}); await session.busy?.done }
      this.results.forget(session.info.id); this.sessions.delete(session.info.id)
      await session.client.end()
    }))
    this.sessions.clear(); this.results.clear()
  }
}
