import { failureSource } from '../language/execution'
import type { ActivityObserver } from '../activity/control'
import { readActivity } from '../activity/read'
import type { DiagramScope } from '../shared/diagram'
import { readDiagram } from '../catalog/diagram'
import { bindRequest, boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { endpoint, isRouted } from '../connections/transport'
import { oracleCatalog } from '../catalog/oracle'
import type { CatalogObject } from '../shared/catalog'
import type { DriverRunRequest } from './driver'
import type { GridOperation, ImportContext } from '../shared/transfer'
import { TableEditor, runGridOperation } from './table-editor'
import type { GridResponse } from '../shared/contracts'
import { schemaSnapshot } from './schema'
import { SessionResultCache } from './result-cache'
import { randomUUID } from 'node:crypto'
import oracledb from 'oracledb'
import type { Cell, ConnectionConfig, ResultSet, SchemaTable, SessionInfo } from '../shared/contracts'
import { exportResultCsv, type Completion, type DatabaseDriver, type Emit } from './driver'
import { firstKeyword } from '../shared/sql/common'
import { splitOracleScript } from '../shared/sql/oracle'
import { enableExactOracleDates } from './oracle-values'

const MAX_BYTES = 8 * 1024 * 1024
interface Operation { id: string; cancelled: boolean; active: boolean; outputBytes: number; cancelPromise?: Promise<void>; done?: Promise<void> }
interface Session { nativeId:string; editor?: TableEditor; client: oracledb.Connection; config: ConnectionConfig; info: SessionInfo; lost: boolean; busy?: Operation; metadata?: Promise<SchemaTable[]> }

export function oracleConnectionOptions(config: ConnectionConfig): oracledb.ConnectionAttributes {
  if (config.engine !== 'oracle') throw new Error('Connection engine does not match the Oracle driver.')
  // These are individual fields, never a TNS descriptor or provider URL. Prevent
  // delimiters from smuggling in retry, wallet, proxy or authentication options.
  if (!/^[\w.:[\]-]+$/.test(config.host) || !/^[\w.$#-]+$/.test(config.database)) throw new Error('Enter an Oracle host and service name, not a connection string or TNS alias.')
  if (config.authentication === 'entra-token') throw new Error('Oracle currently supports username and password authentication.')
  if (config.ca?.trim()) throw new Error('Oracle TLS uses the runtime trust store. Configure NODE_EXTRA_CA_CERTS before launching Db Commander for a private CA.')
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host
  return { user: config.user, password: config.password,
    ...(isRouted(config) ? { httpsProxy: endpoint(config).host, httpsProxyPort: endpoint(config).port } : {}),
    connectString: `${config.tls === 'verify-full' ? 'tcps' : 'tcp'}://${host}:${config.port}/${config.database}`,
    sslServerDNMatch: true, sslAllowWeakDNMatch: false,
    connectTimeout: 15, transportConnectTimeout: 10, retryCount: 0, stmtCacheSize: 0 }
}

const textualTypes = new Set<oracledb.DbType>([oracledb.DB_TYPE_NUMBER, oracledb.DB_TYPE_DATE, oracledb.DB_TYPE_TIMESTAMP,
  oracledb.DB_TYPE_TIMESTAMP_TZ, oracledb.DB_TYPE_TIMESTAMP_LTZ, oracledb.DB_TYPE_JSON])
const executionOptions: oracledb.ExecuteOptions = {
  resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: false,
  fetchArraySize: 32, prefetchRows: 0,
  fetchTypeHandler: metadata => {
    if (metadata.dbType && textualTypes.has(metadata.dbType)) return { type: oracledb.STRING }
    // JSON is fetched as server-produced text, preserving embedded NUMBERs.
    // Other complex types need an explicit SQL conversion until viewers exist.
    if (new Set<oracledb.DbType>([oracledb.DB_TYPE_OBJECT, oracledb.DB_TYPE_VECTOR, oracledb.DB_TYPE_BFILE]).has(metadata.dbType!)) {
      throw new Error(`Preview of ${metadata.dbTypeName} requires an explicit SQL conversion (for JSON, JSON_SERIALIZE(value RETURNING CLOB)).`)
    }
    return undefined
  }
}

function isLob(value: unknown): value is oracledb.Lob {
  return typeof value === 'object' && value !== null && 'getData' in value && typeof value.getData === 'function' && 'close' in value
}

async function openOracle(config: ConnectionConfig) {
  const client = await oracledb.getConnection(oracleConnectionOptions(config))
  try {
    enableExactOracleDates(client)
    // These formats also make explicit TO_CHAR conversions convenient. Raw date
    // previews use the exact decoder, independently of user NLS changes.
    for (const sql of [
      `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'`,
      `ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9'`,
      `ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'`,
      `ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`,
      `ALTER SESSION SET TIME_ZONE = '+00:00'`,
      `BEGIN DBMS_OUTPUT.ENABLE(1000000); END;`
    ]) await client.execute(sql)
    return client
  } catch (error) { await client.close().catch(() => {}); throw error }
}

/** One standalone Thin-mode connection per console; no pool or reconnect/replay. */
export class OracleDriver implements DatabaseDriver {
  private sessions = new Map<string, Session>()
  private results = new SessionResultCache()
  constructor(private emit: Emit) {}
  async connect(config: ConnectionConfig): Promise<SessionInfo> {
    const client = await openOracle(config)
    const info: SessionInfo = { id: randomUUID(), engine: 'oracle', name: config.name,
      database: client.serviceName ?? config.database, user: config.user, host: config.host, port: config.port,
      tls: client.protocol === 'TCPS', transaction: 'idle', autocommit: false, version: client.oracleServerVersionString }
    let nativeId:string
    try { const result=await client.execute<string[]>("SELECT SYS_CONTEXT('USERENV','INSTANCE')||':'||SYS_CONTEXT('USERENV','SID') FROM dual",[],{outFormat:oracledb.OUT_FORMAT_ARRAY});nativeId=result.rows![0][0] }
    catch(error) { await client.close().catch(()=>{});throw error }
    this.sessions.set(info.id, { client, config, info, lost: false, nativeId })
    return { ...info }
  }
  private lost(session: Session) {
    if (session.lost) return
    session.lost = true; session.info.transaction = 'unknown'
    void this.emit({ type: 'session-lost', sessionId: session.info.id, message: 'The Oracle connection was lost. The in-flight outcome may be unknown. Reconnect explicitly.' })
  }
  private session(id: string) {
    const session = this.sessions.get(id)
    if (!session || session.lost) throw new Error('This session is disconnected. Reconnect to create a new session.')
    return session
  }
  async disconnect(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.busy) throw new Error('Stop the running query before disconnecting.')
    if (!session.lost && session.info.transaction !== 'idle') throw new Error('Commit or roll back the transaction before disconnecting.')
    this.results.forget(id); this.sessions.delete(id); await session.client.close().catch(error => { if (!session.lost) throw error })
  }
  async editGrid(request: GridOperation, context?: ImportContext): Promise<GridResponse> {
    const session = this.session(request.sessionId)
    if (session.busy) throw new Error('Wait for the running query before editing data.')
    session.editor ??= new TableEditor('oracle', async (sql, values = []) => {
      const binds = Object.fromEntries(values.map((value, index) => [`p${index + 1}`, { val: value, type: oracledb.STRING }]))
      const result = await session.client.execute<unknown[]>(sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: false, maxRows: 202 })
      const rows: Cell[][] = []
      for (const row of result.rows ?? []) {
        const cells: Cell[] = []
        try {
          for (let value of row) {
            if (isLob(value)) value = await value.getData(1, value.type === oracledb.DB_TYPE_BLOB ? 131073 : 262145)
            cells.push(value === null ? null : Buffer.isBuffer(value) ? '0x' + value.toString('hex') : String(value))
          }
        } finally { for (const value of row) if (isLob(value)) await value.close() }
        rows.push(cells)
      }
      return { rows, affected: result.rowsAffected ?? 0 }
    })
    session.client.callTimeout = 10000
    try { return await runGridOperation(session.editor, request, session.info, async () => {
      await session.client.ping(); session.info.transaction = session.client.transactionInProgress ? 'transaction' : 'idle'
    }, context) } finally { session.client.callTimeout = 0 }
  }
  start(request: DriverRunRequest, completed?: (event: Completion) => void) {
    const session = this.session(request.sessionId)
    request = bindRequest(request, session.info.engine)
    if (session.busy) throw new Error('This console already has a running query.')
    const statements = request.bound ? [request.sql] : splitOracleScript(request.sql)
    if (request.singleUnit && statements.length !== 1) throw new Error('Run current requires exactly one statement or batch. Select SQL explicitly or use Run script.')
    if (!statements.length) throw new Error('There is no SQL statement to execute.')
    if (statements.length > 200) throw new Error('A script may contain up to 200 statements in this preview.')
    session.editor?.invalidate()
    const operation: Operation = { id: request.queryId ?? randomUUID(), cancelled: false, active: false, outputBytes: 1_000_000 }
    session.busy = operation; this.results.begin(request.sessionId, operation.id, request.fullExport)
    operation.done = this.execute(session, operation, request, statements, completed)
    return operation.id
  }
  private async execute(session: Session, operation: Operation, request: DriverRunRequest, statements: string[], completed?: (event: Completion) => void) {
    const started = performance.now(), retained = this.results.get(operation.id)!
    let activeStatement = -1
    let status: Completion['status'] = 'completed', error: string | undefined, code: string | undefined, remaining = MAX_BYTES
    const announce = async (result: ResultSet) => {
      const { rows: _rows, ...metadata } = result
      await this.emit({ type: 'result', sessionId: session.info.id, queryId: operation.id, result: metadata })
    }
    const serverCall = async <T>(action: () => Promise<T>): Promise<T> => {
      operation.active = true
      try { return await action() } finally { operation.active = false }
    }
    try {
      for (const statement of statements) {
        activeStatement++
        if (operation.cancelled) break
        const response = await serverCall(() => session.client.execute<unknown[]>(request.bound?.sql ?? statement, request.bound ? Object.fromEntries(request.bound.values.map((p,i)=>[`sc_p${i+1}`, {val:boundValue(p),type:p.type==='hex'?oracledb.BUFFER:oracledb.STRING}])) : [], executionOptions))
        const cursors = [response.resultSet, ...(response.implicitResults ?? [])].filter(Boolean) as oracledb.ResultSet<unknown[]>[]
        try {
          for (const cursor of cursors.length ? cursors : [undefined]) {
            if (operation.cancelled) break
            if (retained.length >= 200) throw new Error('The execution exceeded the 200 result-set limit.')
            const result: ResultSet = { index: retained.length, statement, command: firstKeyword(statement),
              columns: cursor?.metaData.map(column => ({ name: column.dbColumnName ?? column.name,
                typeId: column.dbType?.num ?? 0, typeName: column.dbTypeName })) ?? [],
              rows: [], rowCount: response.rowsAffected ?? 0, truncated: false }
            retained.push(result); await announce(result)
            if (cursor) {
              let batch: Cell[][] = [], batchBytes = 0, count = 0
              const flush = async () => {
                if (batch.length) await this.emit({ type: 'rows', sessionId: session.info.id, queryId: operation.id, index: result.index, rows: batch })
                batch = []; batchBytes = 0
              }
              while (!operation.cancelled) {
                const row = await serverCall(() => cursor.getRow())
                if (!row) break
                let size = 0
                const cells: Cell[] = []
                try {
                  if (!request.fullExport && result.rows.length >= request.maxRows) { result.truncated = true; break }
                  for (const value of row) {
                    let cell: Cell
                    if (value === null || value === undefined) cell = null
                    else if (isLob(value)) {
                      // Bound LOB reads before allocation; a row that doesn't fit
                      // is omitted, never silently cut into a misleading value.
                      const data = await serverCall(() => value.getData(1, Math.max(1, remaining - size + 1)))
                      cell = Buffer.isBuffer(data) ? '0x' + data.toString('hex') : data
                    } else if (Buffer.isBuffer(value)) cell = '0x' + value.toString('hex')
                    else if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) cell = String(value)
                    else throw new Error('This Oracle value needs an explicit SQL conversion before previewing.')
                    cells.push(cell); size += cell === null ? 4 : Buffer.byteLength(cell)
                    if (size > remaining) break
                  }
                } finally { for (const value of row) if (isLob(value)) await value.close() }
                if (size > remaining) { if (request.fullExport) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.'); result.truncated = true; break }
                if (!request.fullExport) { remaining -= size; result.rows.push(cells) }; count++; batch.push(cells); batchBytes += size
                if (batch.length >= 100 || batchBytes >= 128 * 1024) await flush()
              }
              await flush()
              // Closing a bounded Oracle cursor avoids running the rest of a huge
              // SELECT. Its total row count is unknown, not the preview length.
              result.rowCount = result.truncated || operation.cancelled ? null : count
            }
            await announce(result)
          }
        } finally {
          for (const cursor of cursors) await cursor.close().catch(() => { this.lost(session) })
        }
        if (session.lost) throw new Error('Could not close the Oracle result cursors. Reconnect explicitly.')
        if (response.warning) await this.emit({ type: 'notice', sessionId: session.info.id, queryId: operation.id, message: response.warning.message })
        operation.active = false
        await operation.cancelPromise
        if (!operation.cancelled) await this.output(session, operation)
      }
      if (operation.cancelled) status = 'cancelled'
    } catch (failure) {
      const detail = failure as Error & { code?: string; errorNum?: number }
      error = detail.message; code = detail.code
      status = operation.cancelled && detail.errorNum === 1013 ? 'cancelled' : 'failed'
    } finally {
      operation.active = false
      await operation.cancelPromise?.catch(() => { this.lost(session) })
      try {
        // A dead peer must not hang session-state recovery indefinitely.
        session.client.callTimeout = 5000
        // Failed PL/SQL can leave DBMS_OUTPUT in the retained session. Attribute
        // it to this execution, never to the next query.
        if (status !== 'completed' && session.client.isHealthy()) await this.output(session, operation)
        await session.client.ping()
        session.client.callTimeout = 0
        session.info.transaction = session.client.transactionInProgress ? 'transaction' : 'idle'
      } catch { this.lost(session) }
      if (session.lost) status = 'unknown'
      session.busy = undefined
      if (request.fullExport) this.results.finishStream(operation.id)
      const event: Completion = { type: 'complete', sessionId: session.info.id, queryId: operation.id, status, failure: status === 'failed' ? failureSource(request.sql, session.info.engine, activeStatement, Boolean(request.bound)) : undefined, error, code,
        durationMs: Math.round(performance.now() - started), transaction: session.info.transaction, autocommit: false, database: session.info.database }
      completed?.(event); await this.emit(event)
    }
  }
  private async output(session: Session, operation: Operation) {
    // DBMS_OUTPUT is bounded to 1 MB per session. GET_LINES empties it after each
    // statement; one notice keeps the renderer from accumulating thousands of nodes.
    const response = await session.client.execute<{ lines: string[]; count: number }>(
      'BEGIN DBMS_OUTPUT.GET_LINES(:lines, :count); END;', {
        lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxArraySize: 1000, maxSize: 32767 },
        count: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: 1000 }
      })
    if (response.outBinds?.lines.length && operation.outputBytes > 0) {
      const data = Buffer.from(response.outBinds.lines.join('\n'))
      const truncated = data.length > operation.outputBytes || response.outBinds.count === 1000
      const text = data.subarray(0, operation.outputBytes).toString('utf8')
      operation.outputBytes -= Math.min(data.length, operation.outputBytes)
      await this.emit({ type: 'notice', sessionId: session.info.id, queryId: operation.id,
        message: text + (truncated ? '\n[DBMS_OUTPUT preview limit reached]' : '') })
    }
    // Discard excess without retaining another buffer; re-enable the same cap.
    if (response.outBinds?.count === 1000) await session.client.execute('BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(1000000); END;')
  }
  async cancel(id: string) {
    const session = this.session(id), operation = session.busy
    if (!operation) return { requested: false }
    operation.cancelled = true
    if (operation.active) operation.cancelPromise ??= session.client.break()
    await operation.cancelPromise
    return { requested: true }
  }
  activity(id:string, includeSql:boolean) { return this.withActivity(id,o=>readActivity(o.engine,o.database,o.currentSessionId,o.query,includeSql)) }
  activityId(id:string) { const session=this.session(id); return session.nativeId }
  invalidateActivity(id:string) { const session=this.sessions.get(id);if(!session||session.lost)return;session.lost=true;session.info.transaction='unknown';void this.emit({type:'session-lost',sessionId:id,message:'Session termination was requested. The connection is no longer usable; verify rollback and reconnect explicitly.'}) }
  async withActivity<T>(id:string, read:(observer:ActivityObserver)=>Promise<T>):Promise<T> {
    const session=this.session(id), database=session.info.database, client=await openOracle(session.config)
    try {
      client.callTimeout=5000
      return await read({engine:'oracle',database,currentSessionId:session.nativeId,query:async sql=>{
        const result=await client.execute<unknown[]>(sql,[],{outFormat:oracledb.OUT_FORMAT_ARRAY,maxRows:501,fetchTypeHandler:metadata=>metadata.dbType===oracledb.DB_TYPE_NUMBER?{type:oracledb.STRING}:undefined})
        return (result.rows??[]).map(row=>row.map(cell=>cell==null?null:String(cell)))
      }})
    } finally { await client.close().catch(()=>{}) }
  }
  async explore(id: string, object?: CatalogObject, diagram?: DiagramScope) {
    const session = this.session(id), client = await openOracle(session.config)
    let definitionClient: oracledb.Connection | undefined
    const deadline = Date.now() + 45000
    function timeout(reader: oracledb.Connection, limit: number) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Oracle metadata inspection timed out. Refresh the object to retry.')
      reader.callTimeout = Math.min(limit, remaining)
    }
    try {
      if (object && !diagram && !['constraint', 'materialized view'].includes(object.kind)) {
        // One optional reader overlaps full native DDL with the required detail
        // sections. Session limits retain the original single-reader path.
        try { definitionClient = await openOracle(session.config) } catch { /* Optional optimization; use the existing reader. */ }
      }
      const queryFor = (reader: oracledb.Connection): import('../catalog/common').CatalogQuery => async (sql, values = []) => {
        // Cold DBMS_METADATA package initialization can exceed ordinary catalog reads.
        timeout(reader, sql.includes('DBMS_METADATA.GET_DDL') ? 30000 : 10000)
        const result = await reader.execute<unknown[]>(sql, values, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 2001, fetchTypeHandler: metadata => metadata.dbType === oracledb.DB_TYPE_NUMBER ? { type: oracledb.STRING } : undefined })
        const rows: (string | null)[][] = []
        for (const row of result.rows ?? []) {
          const cells: (string | null)[] = []
          for (const value of row) {
            if (value && typeof value === 'object' && 'getData' in value) { const lob = value as oracledb.Lob; try { timeout(reader, 10000); cells.push(String(await lob.getData(1, 1_000_001))) } finally { await lob.close() } }
            else cells.push(value == null ? null : String(value))
          }
          rows.push(cells)
        }
        return rows
      }
      const query = queryFor(client), adapter=oracleCatalog(query, definitionClient && queryFor(definitionClient))
      return diagram?{diagram:await readDiagram(adapter,query,'oracle',diagram,'catalog-connection')}:await inspect(adapter,object)
    } finally {
      const readers = definitionClient ? [client, definitionClient] : [client]
      const closed = await Promise.allSettled(readers.map(async reader => { await reader.close() }))
      const failed = closed.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
  async schema(id: string) {
    const session = this.session(id), client = await openOracle(session.config)
    try {
      client.callTimeout = 10000
      const result = await client.execute<unknown[]>(`SELECT NULL,o.owner,o.object_name,o.object_type,c.column_name,c.data_type,c.nullable,c.column_id
        FROM all_objects o LEFT JOIN all_tab_columns c ON c.owner=o.owner AND c.table_name=o.object_name
        WHERE o.owner=USER AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')
        ORDER BY o.owner,o.object_name,c.column_id FETCH FIRST 10001 ROWS ONLY`, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 10001 })
      const rows = (result.rows ?? []).map(row => { row[6] = row[6] === 'Y'; return row })
      return schemaSnapshot(rows, session.info.database, 'catalog-connection')
    } finally { await client.close() }
  }
  async tables(id: string): Promise<SchemaTable[]> {
    const session = this.session(id)
    session.metadata ??= (async () => {
      const client = await openOracle(session.config)
      try {
        const result = await client.execute<[string, string, string]>(`SELECT owner, object_name, object_type FROM all_objects
          WHERE owner = USER AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
          ORDER BY object_name FETCH FIRST 2000 ROWS ONLY`, [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
        return (result.rows ?? []).map(row => ({ schema: row[0], name: row[1], kind: row[2] === 'TABLE' ? 'table' : 'view' }))
      } finally { await client.close() }
    })().finally(() => { session.metadata = undefined })
    return session.metadata
  }
  async exportCsv(id: string, index: number, path: string) { await exportResultCsv(this.results.get(id)?.find(result => result.index === index), path) }
  getSession(id: string) { return { ...this.session(id).info } }
  async wait(id: string) { await this.sessions.get(id)?.busy?.done }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      if (session.busy) { await this.cancel(session.info.id).catch(() => {}); await session.busy?.done }
      await session.metadata?.catch(() => {}); await session.client.close().catch(() => {})
    }))
    this.sessions.clear(); this.results.clear()
  }
}
