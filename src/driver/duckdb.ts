import { failureSource } from '../language/execution'
import type { DiagramScope } from '../shared/diagram'
import { readDiagram } from '../catalog/diagram'
import { bindRequest, boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { duckdbCatalog } from '../catalog/duckdb'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import { TableEditor, runGridOperation } from './table-editor'
import type { BackupRequest } from '../shared/backup'
import type { BackupContext } from '../backup/context'
import { publishFile } from '../backup/files'
import { copyDuckDatabase, restoreDuckDatabase } from '../backup/embedded'
import type { GridResponse } from '../shared/contracts'
import { schemaSnapshot } from './schema'
import { SessionResultCache } from './result-cache'
import { randomUUID } from 'node:crypto'
import { chmod, link, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DuckDBBlobValue, DuckDBInstance, ResultReturnType, StatementType, version, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import type { Cell, ConnectionConfig, ResultSet, SchemaTable, SchemaSnapshot, SessionInfo } from '../shared/contracts'
import { exportResultCsv, type Completion, type DatabaseDriver, type Emit } from './driver'

const MAX_BYTES = 8 * 1024 * 1024
interface Database { instance: DuckDBInstance; readOnly: boolean; references: number }
interface Operation { cancelled: boolean; native: boolean; done?: Promise<void> }
interface Session { editor?: TableEditor; client: DuckDBConnection; database: Database; key?: string; info: SessionInfo; busy?: Operation; metadata?: Promise<SchemaTable[]>; inspection?: Promise<SchemaSnapshot> }
const options = (readOnly: boolean) => ({ access_mode: readOnly ? 'READ_ONLY' : 'READ_WRITE',
  // Local analytical queries must not unexpectedly download extensions. Users
  // can explicitly INSTALL/LOAD signed extensions or opt in with SET.
  autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', memory_limit: '512MB', threads: '4' })

function duckdbCell(value: DuckDBValue): Cell {
  if (value === null) return null
  if (value instanceof DuckDBBlobValue) return '0x' + Buffer.from(value.bytes).toString('hex')
  // Neo's exact value classes format decimals, nanosecond timestamps and nested
  // values without passing through JS Number, Date or JSON serialization.
  return String(value)
}

/** Async native DuckDB runs in the existing database utility process. Each
 * console retains a connection; file instances are shared and reference counted. */
export class DuckDBDriver implements DatabaseDriver {
  async backup(request: BackupRequest, context: BackupContext) {
    const session = this.session(request.sessionId)
    if (request.action === 'restore') {
      const info = await stat(request.artifact, { bigint: true })
      if (this.databases.has(`${info.dev}:${info.ino}`)) throw new Error('Disconnect tabs using this backup file before restoring it.')
      return restoreDuckDatabase(request, context)
    }
    // A private connection shares this instance (including in-memory catalogs)
    // but leaves the query tab's settings and attachments alone.
    const client = await session.database.instance.connect()
    try { await publishFile(request.artifact, context, path => copyDuckDatabase(client, session.info.database, path, request.content === 'schema', context)) }
    finally { client.closeSync() }
  }
  private sessions = new Map<string, Session>()
  private databases = new Map<string, Database>()
  private results = new SessionResultCache()
  private connecting: Promise<unknown> = Promise.resolve()
  constructor(private emit: Emit) {}

  connect(config: ConnectionConfig): Promise<SessionInfo> {
    // Serialize opens so aliases/concurrent requests cannot create two native
    // instances for a file or race an exclusive creation within this driver.
    const pending = this.connecting.then(() => this.open(config))
    this.connecting = pending.catch(() => {})
    return pending
  }
  private async open(config: ConnectionConfig): Promise<SessionInfo> {
    if (config.engine !== 'duckdb') throw new Error('Expected a DuckDB connection.')
    const mode = config.duckdbMode ?? 'read-write', readOnly = mode === 'read-only'
    let path = ':memory:', key: string | undefined
    if (mode !== 'memory') {
      if (!config.filePath || !isAbsolute(config.filePath) || config.filePath.includes('\0')) throw new Error('Choose an absolute path to a local DuckDB database file.')
      path = config.filePath
      if (mode === 'create') {
        // DuckDB rejects empty files, so O_EXCL followed by open is insufficient.
        // Initialize a private sibling, then link the closed valid database into
        // place atomically. link refuses ANY existing target, including symlinks.
        const directory = await mkdtemp(join(dirname(path), '.dbcommander-duckdb-'))
        try {
          const temporary = join(directory, 'database.duckdb')
          const instance = await DuckDBInstance.create(temporary, options(false))
          instance.closeSync()
          await chmod(temporary, 0o600)
          await link(temporary, path)
        } finally { await rm(directory, { recursive: true, force: true }) }
      }
      path = await realpath(path)
      const info = await stat(path, { bigint: true })
      if (!info.isFile()) throw new Error('Choose a regular DuckDB database file.')
      // Device/inode identity also catches hard links, unlike path normalization.
      key = `${info.dev}:${info.ino}`
    }
    let database = key ? this.databases.get(key) : undefined
    if (database && database.readOnly !== readOnly) throw new Error('This DuckDB file is already open with a different access mode. Disconnect it before changing modes.')
    if (!database) {
      database = { instance: await DuckDBInstance.create(path, options(readOnly)), readOnly, references: 0 }
      if (key) this.databases.set(key, database)
    }
    // Reserve before awaiting native connect, so disconnecting the previous last
    // console cannot close this instance while a new connection is being opened.
    database.references++
    let client: DuckDBConnection | undefined
    try {
      client = await database.instance.connect()
      const row = (await client.runAndReadAll('SELECT system.main.current_database()')).getRows()[0]
      const info: SessionInfo = { id: randomUUID(), engine: 'duckdb', name: config.name, database: String(row[0]),
        user: 'local', host: path, port: 0, tls: false, transaction: 'idle', autocommit: true, version: version() }
      this.sessions.set(info.id, { client, database, key, info })
      return { ...info }
    } catch (error) {
      client?.closeSync()
      if (--database.references === 0) { database.instance.closeSync(); if (key) this.databases.delete(key) }
      throw error
    }
  }
  private session(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new Error('This DuckDB session is disconnected. Reconnect explicitly.')
    return session
  }
  private release(session: Session) {
    session.client.closeSync()
    if (--session.database.references === 0) {
      session.database.instance.closeSync()
      if (session.key) this.databases.delete(session.key)
    }
    this.results.forget(session.info.id); this.sessions.delete(session.info.id)
  }
  async disconnect(id: string) {
    const session = this.session(id)
    if (session.busy || session.metadata || session.inspection) throw new Error('Wait for the running query before disconnecting.')
    if (session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    this.release(session)
  }
  private async refreshState(session: Session) {
    // There is no public C/Neo autocommit flag. These two fully consumed native
    // queries have equal IDs iff they share an explicit transaction. Qualifying
    // builtins prevents a user macro/search_path from shadowing the probe.
    try {
      const sql = 'SELECT system.main.current_transaction_id(), system.main.current_database()'
      const first = (await session.client.runAndReadAll(sql)).getRows()[0]
      const second = (await session.client.runAndReadAll(sql)).getRows()[0]
      session.info.transaction = first[0] === second[0] ? 'transaction' : 'idle'
      session.info.database = String(second[1])
    } catch (error) {
      session.info.transaction = /TransactionContext Error: Current transaction is aborted/.test((error as Error).message) ? 'failed' : 'unknown'
    }
    session.info.autocommit = session.info.transaction === 'idle' ? true : session.info.transaction === 'unknown' ? undefined : false
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (request.action === 'release') this.results.forget(request.sessionId, request.viewId)
    if (session.busy || session.metadata || session.inspection) throw new Error('Wait for the running query before editing data.')
    session.editor ??= new TableEditor('duckdb', async (sql, values = []) => {
      const result = await session.client.runAndReadAll(sql, values.length ? values : undefined)
      return { rows: result.getRows().map(row => row.map(duckdbCell)), affected: result.rowsChanged }
    }, session.database.readOnly)
    return runGridOperation(session.editor, request, session.info, () => this.refreshState(session), context)
  }
  start(request: DriverRunRequest, completed?: (event: Completion) => void) {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine)
    if (session.busy || session.metadata || session.inspection) throw new Error('This console already has a running query.')
    session.editor?.invalidate()
    const id = request.queryId ?? randomUUID(), operation: Operation = { cancelled: false, native: false }
    session.busy = operation; this.results.begin(request.sessionId, id, request.fullExport, request.viewId)
    operation.done = this.execute(session, operation, request, id, completed)
    // Completion owns error reporting; never leave an unhandled event rejection.
    void operation.done.catch(() => {})
    return id
  }
  private async execute(session: Session, operation: Operation, request: DriverRunRequest, queryId: string, completed?: (event: Completion) => void) {
    const started = performance.now(), sessionId = session.info.id
    let activeStatement = -1, nativeCount: number | undefined
    let bytes = 0, status: Completion['status'] = 'completed', error: string | undefined
    const checkCancelled = () => { if (operation.cancelled) throw new Error('Query cancelled. Earlier statements may have committed.') }
    const native = async <T>(action: () => Promise<T>): Promise<T> => {
      checkCancelled(); operation.native = true
      try { return await action() } finally { operation.native = false }
    }
    try {
      const statements = await native(() => session.client.extractStatements(request.bound?.sql ?? request.sql))
      nativeCount = statements.count
      if (request.singleUnit && statements.count !== 1) throw new Error('Run current requires exactly one statement. Select SQL explicitly or use Run script.')
      if (!statements.count) throw new Error('There is no SQL statement to execute.')
      if (statements.count > 200) throw new Error('A script may contain up to 200 statements in this preview.')
      for (let index = 0; index < statements.count; index++) {
        activeStatement = index
        const prepared = await native(() => statements.prepare(index))
        try {
          if (prepared.parameterCount && !request.bound) throw new Error('DuckDB parameter binding requires :name placeholders and values in the Run prompt. Earlier statements may have committed.')
          if(request.bound)request.bound.values.forEach((p,i)=>{const n=i+1;if(p.type==='null')prepared.bindNull(n);else if(p.type==='hex')prepared.bindBlob(n,Buffer.from(p.value,'hex'));else if(p.type==='integer')prepared.bindBigInt(n,BigInt(p.value));else if(p.type==='boolean')prepared.bindBoolean(n,p.value==='true');else prepared.bindVarchar(n,boundValue(p) as string)})
          const result = await native(() => prepared.stream())
          const queryResult = result.returnType === ResultReturnType.QUERY_RESULT
          const command = StatementType[result.statementType] ?? 'SQL'
          const retained: ResultSet = { index, statement: statements.count === 1 ? request.sql : `${command} (statement ${index + 1})`,
            command, columns: queryResult ? result.columnNames().map((name, column) => ({ name, typeId: result.columnTypeId(column), typeName: String(result.columnType(column)) })) : [],
            rows: [], rowCount: null, truncated: false }
          this.results.get(queryId)?.push(retained)
          const metadata = async () => { const { rows: _, ...data } = retained; await this.emit({ type: 'result', sessionId, queryId, result: { ...data } }) }
          await metadata()
          let count = 0
          for (;;) {
            const chunk = await native(() => result.fetchChunk())
            if (!chunk || !chunk.rowCount) break
            count += chunk.rowCount
            if (!queryResult) continue
            let batch: Cell[][] = [], batchBytes = 0
            const flush = async () => {
              if (batch.length) { if (!request.fullExport) retained.rows.push(...batch); await this.emit({ type: 'rows', sessionId, queryId, index, rows: batch }); batch = []; batchBytes = 0 }
            }
            // Decode only retained rows. Native chunks and individual values can
            // exceed the retained preview budget; do not materialize entire results.
            const vectors = retained.rows.length < request.maxRows && !retained.truncated ? retained.columns.map((_, i) => chunk.getColumnVector(i)) : []
            for (let row = 0; row < chunk.rowCount; row++) {
              if (!request.fullExport && (retained.rows.length + batch.length >= request.maxRows || retained.truncated)) { retained.truncated = true; break }
              const cells = vectors.map(vector => duckdbCell(vector.getItem(row)))
              const size = cells.reduce((total, cell) => total + (cell === null ? 1 : Buffer.byteLength(cell)) + 4, 0)
              if (!request.fullExport && bytes + size > MAX_BYTES) { retained.truncated = true; break }
              if (request.fullExport && size > MAX_BYTES) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.');
              if (!request.fullExport) bytes += size; batchBytes += size; batch.push(cells)
              if (batch.length >= 200 || batchBytes >= 128 * 1024) { await flush(); checkCancelled() }
            }
            await flush()
          }
          retained.rowCount = queryResult ? count : result.returnType === ResultReturnType.CHANGED_ROWS ? result.rowsChanged : 0
          await metadata()
          if (retained.truncated) await this.emit({ type: 'notice', sessionId, queryId, message: 'Preview limit reached. CSV exports only fetched rows; remaining rows were drained without re-executing SQL.' })
        } finally { prepared.destroySync() }
      }
    } catch (cause) {
      status = operation.cancelled ? 'cancelled' : 'failed'; error = (cause as Error).message
    } finally {
      // Also closes any abandoned streaming result before probing transaction state.
      await this.refreshState(session)
      if (session.info.transaction === 'unknown') { status = 'unknown'; error = `${error ?? 'Execution finished.'} DuckDB transaction state could not be confirmed. Run ROLLBACK before disconnecting.` }
      if (request.fullExport) this.results.finishStream(queryId)
      const event: Completion = { type: 'complete', sessionId, queryId, status, error, failure: status === 'failed' ? failureSource(request.sql, 'duckdb', activeStatement, Boolean(request.bound), undefined, nativeCount) : undefined, durationMs: Math.round(performance.now() - started),
        transaction: session.info.transaction, autocommit: session.info.autocommit, database: session.info.database }
      try { completed?.(event); await this.emit(event) } finally { session.busy = undefined }
    }
  }
  async cancel(id: string) {
    const session = this.session(id), operation = session.busy
    if (!operation) return { requested: false }
    operation.cancelled = true
    // Never interrupt an idle connection while waiting for renderer backpressure
    // or probing state. The next boundary still stops the rest of the script.
    if (operation.native) session.client.interrupt()
    return { requested: true }
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id)
    if (session.busy || session.metadata || session.inspection) throw new Error('Wait for the DuckDB operation to finish before inspecting objects.')
    const query: import('../catalog/common').CatalogQuery=async(sql,values=[])=>(await session.client.runAndReadAll(sql,values)).getRows().map(row=>row.map(duckdbCell)),adapter=duckdbCatalog(query)
    return diagram?{diagram:await readDiagram(adapter,query,'duckdb',diagram,'session')}:inspect(adapter,object,'session')
  }
  async schema(id: string): Promise<SchemaSnapshot> {
    const session = this.session(id)
    if (session.inspection) return session.inspection
    if (session.busy || session.metadata) throw new Error('Wait for the DuckDB query to finish before refreshing its schema.')
    session.inspection = (async () => {
      const result = await session.client.runAndReadAll(`WITH objects AS (
        SELECT database_name,schema_name,table_name AS name,'table' AS kind FROM system.main.duckdb_tables() WHERE NOT internal
        UNION ALL SELECT database_name,schema_name,view_name,'view' FROM system.main.duckdb_views() WHERE NOT internal)
        SELECT o.database_name,o.schema_name,o.name,o.kind,c.column_name,c.data_type,c.is_nullable,c.column_index
        FROM objects o LEFT JOIN system.main.duckdb_columns() c ON c.database_name=o.database_name AND c.schema_name=o.schema_name AND c.table_name=o.name
        ORDER BY o.database_name,o.schema_name,o.name,c.column_index LIMIT 10001`)
      return schemaSnapshot(result.getRows(), session.info.database, 'session')
    })()
    try { return await session.inspection } finally { session.inspection = undefined }
  }
  async tables(id: string): Promise<SchemaTable[]> {
    const session = this.session(id)
    if (session.busy || session.metadata || session.inspection) throw new Error('Wait for the DuckDB query to finish before refreshing its schema.')
    session.metadata = (async () => {
      const result = await session.client.runAndReadAll(`SELECT database_name, schema_name, table_name, 'table' FROM system.main.duckdb_tables() WHERE NOT internal
        UNION ALL SELECT database_name, schema_name, view_name, 'view' FROM system.main.duckdb_views() WHERE NOT internal
        ORDER BY 1, 2, 3 LIMIT 2000`)
      return result.getRows().map(row => ({ catalog: String(row[0]), schema: String(row[1]), name: String(row[2]), kind: String(row[3]) }))
    })()
    try { return await session.metadata } finally { session.metadata = undefined }
  }
  getSession(id: string) { return { ...this.session(id).info } }
  async wait(id: string) { await this.sessions.get(id)?.busy?.done }
  async exportCsv(id: string, index: number, path: string) { await exportResultCsv(this.results.get(id)?.[index], path) }
  async close() {
    await this.connecting
    for (const session of this.sessions.values()) {
      if (session.busy) { await this.cancel(session.info.id); await session.busy?.done }
      await session.metadata?.catch(() => {}); await session.inspection?.catch(() => {})
      this.release(session) // native disconnect rolls back uncommitted work
    }
    this.results.clear()
  }
}
