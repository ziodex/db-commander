import { executionUnits, failureSource } from '../language/execution'
import { readDiagram } from '../catalog/diagram'
import { boundValue } from './parameters'
import { inspect } from '../catalog/common'
import { sqliteCatalog } from '../catalog/sqlite'
import { TableEditor, runGridOperation } from './table-editor'
import type { SessionInfo } from '../shared/contracts'
import { schemaSnapshot } from './schema'
import { Worker } from 'node:worker_threads'
import { DatabaseSync, constants, backup as sqliteBackup } from 'node:sqlite'
import { header, publishFile } from '../backup/files'
import type { BackupRequest } from '../shared/backup'
import { closeSync, openSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ConnectionConfig, DatabaseEvent, ResultSet, SchemaTable } from '../shared/contracts'
import { inspectSqliteSql } from './sqlite-sql'
import { firstKeyword } from '../shared/sql/common'
import type { DriverRunRequest } from './driver'
import type { GridOperation } from '../shared/transfer'

// A native SQLite step can block this thread indefinitely. Watch the owning
// host from another thread so a host/renderer crash cannot orphan a worker
// holding database locks. No user-supplied code is evaluated here.
const watchdog = new Worker(`
  const { workerData } = require('node:worker_threads');
  setInterval(() => {
    try {
      if (process.ppid !== workerData.parent) throw new Error('Owner ended');
      process.kill(workerData.parent, 0);
    } catch { process.kill(process.pid, 'SIGKILL'); }
  }, 250);
`, { eval: true, workerData: { parent: process.ppid } })
watchdog.unref()

// Node 24's public authorizer API is newer than the project's Node 22 types.
interface AuthorizedDatabase extends DatabaseSync { setAuthorizer(callback: (action: number, first: string | null, second: string | null) => number): void }
const auth = constants as typeof constants & { SQLITE_ATTACH: number; SQLITE_PRAGMA: number; SQLITE_DENY: number; SQLITE_OK: number }
let db: AuthorizedDatabase | undefined
let editor: TableEditor | undefined
let readOnly = false
let active = false
let backupController: AbortController | undefined
let importController: AbortController | undefined
let token = 0
const acknowledgements = new Map<number, () => void>()
const send = (value: unknown) => process.send?.(value)
async function emit(event: DatabaseEvent) {
  const ack = ++token
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { acknowledgements.delete(ack); reject(new Error('The result consumer stopped responding.')) }, 15000)
    acknowledgements.set(ack, () => { clearTimeout(timeout); resolve() })
    send({ event, ack })
  })
}
function state() { return db!.isTransaction ? 'transaction' as const : 'idle' as const }
function open(config: ConnectionConfig) {
  if (typeof (DatabaseSync.prototype as AuthorizedDatabase).setAuthorizer !== 'function') throw new Error('The SQLite worker requires Node 24.10 or newer. Use the bundled Electron runtime or the Docker test runner.')
  const mode = config.sqliteMode ?? 'read-write'
  const path = mode === 'memory' ? ':memory:' : config.filePath
  if (!path || (mode !== 'memory' && (!isAbsolute(path) || path.includes('\0')))) throw new Error('Choose an absolute SQLite database file path.')
  if (mode === 'create') closeSync(openSync(path, 'wx', 0o600))
  else if (mode !== 'memory' && !statSync(path).isFile()) throw new Error('Choose a regular SQLite database file.')
  const client = new DatabaseSync(path, { readOnly: mode === 'read-only', allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, timeout: 1000 }) as AuthorizedDatabase
  try {
    client.prepare('PRAGMA schema_version').get() // Reject corrupt/encrypted/non-database files at connect.
    if (mode === 'create') client.exec('PRAGMA user_version=0') // Initialize the exclusively created file.
    if (mode === 'read-only') {
      client.exec('PRAGMA query_only=ON')
      client.setAuthorizer((action, first, second) => action === auth.SQLITE_ATTACH || action === auth.SQLITE_PRAGMA && first?.toLowerCase() === 'query_only' && second !== null ? auth.SQLITE_DENY : auth.SQLITE_OK)
    }
    db = client; readOnly = mode === 'read-only'
    return { version: String(client.prepare('SELECT sqlite_version() AS version').get()!.version), transaction: state() }
  } catch (error) { client.close(); throw error }
}
function cell(value: unknown): string | null {
  if (value === null) return null
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex')
  return String(value)
}
async function execute(request: DriverRunRequest & { queryId: string }) {
  editor?.invalidate()
  const { sessionId, queryId } = request, started = performance.now()
  let remaining = request.bound?.sql ?? request.sql, index = 0, budget = 8 * 1024 * 1024
  let activeStatement = -1
  let status: 'completed' | 'failed' = 'completed', error: string | undefined, code: string | undefined
  try {
    // Some PRAGMAs take effect during prepare: reject lexical multi-unit input first.
    if (request.singleUnit && executionUnits(remaining, 'sqlite').length !== 1) throw new Error('Run current requires exactly one statement. Select SQL explicitly or use Run script.')
    while (inspectSqliteSql(remaining).hasSql) {
      activeStatement = index
      if (index >= 200) throw new Error('The execution exceeded the 200 statement limit. Earlier statements may have completed.')
      const statement = db!.prepare(remaining)
      const bindings = request.bound?.values.map(p=>p.type==='integer'?BigInt(p.value):boundValue(p)) ?? []
      const source = statement.sourceSQL
      if (!source.length || !remaining.startsWith(source)) throw new Error('SQLite returned an invalid statement boundary.')
      remaining = remaining.slice(source.length)
      if (request.singleUnit && inspectSqliteSql(remaining).hasSql) throw new Error('Run current requires exactly one statement. Select SQL explicitly or use Run script.')
      statement.setReadBigInts(true); statement.setReturnArrays(true)
      const columns = statement.columns().map(column => ({ name: column.name, typeId: 0, typeName: column.type ?? 'dynamic' }))
      const result: Omit<ResultSet, 'rows'> = { index: index++, statement: request.bound ? request.sql : source, columns, rowCount: 0, command: firstKeyword(source), truncated: false }
      await emit({ type: 'result', sessionId, queryId, result: { ...result } })
      if (!columns.length) {
        // changes() is sticky after DDL. A total_changes delta distinguishes it
        // from DML without guessing through WITH clauses or trigger definitions.
        const before = db!.prepare('SELECT total_changes() AS n'); before.setReadBigInts(true)
        const total = before.get()!.n as bigint
        const changed = statement.run(...bindings)
        result.rowCount = (before.get()!.n as bigint) === total ? 0 : Number(changed.changes)
      } else {
        let rows: (string | null)[][] = [], bytes = 0, seen = 0, retained = 0
        const flush = async () => { if (rows.length) { await emit({ type: 'rows', sessionId, queryId, index: result.index, rows }); rows = []; bytes = 0 } }
        try {
          for (const values of statement.iterate(...bindings) as unknown as Iterable<unknown[]>) {
            seen++
            const row = values.map(cell), size = row.reduce((sum, value) => sum + (value === null ? 4 : Buffer.byteLength(value)), 0)
            if (request.fullExport && size > 8 * 1024 * 1024) throw new Error('An export row exceeds 8 MiB. Select smaller values explicitly.')
            if (!request.fullExport && (result.truncated || retained >= request.maxRows || size > budget)) result.truncated = true
            else { if (!request.fullExport) budget -= size; retained++; rows.push(row); bytes += size }
            if (rows.length >= 200 || bytes >= 128 * 1024) await flush()
            // Yield even while draining discarded rows. Stop remains available
            // through the parent, including when one native step never returns.
            if (seen % 200 === 0) await new Promise<void>(resolve => setImmediate(resolve))
          }
        } finally { result.rowCount = seen; await flush(); await emit({ type: 'result', sessionId, queryId, result: { ...result } }) }
      }
      if (!columns.length) await emit({ type: 'result', sessionId, queryId, result })
    }
  } catch (failure) { status = 'failed'; error = (failure as Error).message; code = String((failure as Error & { errcode?: number; code?: string }).errcode ?? (failure as { code?: string }).code ?? 'SQLITE_ERROR') }
  active = false
  send({ event: { type: 'complete', sessionId, queryId, status, error, code, failure: status === 'failed' ? failureSource(request.sql, 'sqlite', activeStatement, Boolean(request.bound)) : undefined, durationMs: Math.round(performance.now() - started), transaction: state(), autocommit: !db!.isTransaction } satisfies DatabaseEvent })
}
function tables(): SchemaTable[] {
  if (active) throw new Error('Wait for the SQLite query to finish before refreshing its schema.')
  return db!.prepare(`SELECT schema, name, type FROM pragma_table_list
    WHERE type IN ('table','view','virtual') AND substr(name,1,7)<>'sqlite_'
    ORDER BY schema,name LIMIT 2000`).all()
    .map(row => ({ schema: String(row.schema), name: String(row.name), kind: row.type === 'view' ? 'view' : 'table' }))
}
function schema() {
  if (active) throw new Error('Wait for the SQLite query to finish before refreshing its schema.')
  const statement = db!.prepare(`SELECT NULL,t.schema,t.name,t.type,c.name,c.type,NOT c.[notnull],c.cid
    FROM pragma_table_list t LEFT JOIN pragma_table_xinfo(t.name,t.schema) c
    WHERE t.type IN ('table','view','virtual') AND substr(t.name,1,7)<>'sqlite_' AND (c.hidden IS NULL OR c.hidden<>1)
    ORDER BY t.schema,t.name,c.cid LIMIT 10001`)
  statement.setReturnArrays(true)
  const rows = statement.all() as unknown as unknown[][]
  return schemaSnapshot(rows, ':local:', 'session')
}
process.on('message', async (message: { id: string; method: string; payload: any; ack?: number }) => {
  if (message.ack) { acknowledgements.get(message.ack)?.(); acknowledgements.delete(message.ack); return }
  const { id, method, payload } = message
  try {
    let value: unknown
    if (method === 'open') value = open(payload)
    else if (method === 'execute') { active = true; send({ id, ok: true }); await execute(payload); return }
    else if (method === 'tables') value = tables()
    else if (method === 'schema') value = schema()
    else if (method === 'explore') {
      if (active) throw new Error('Wait for the SQLite operation to finish before inspecting objects.')
      active = true
      try { const query: import('../catalog/common').CatalogQuery=async(sql,values=[])=>{
        const statement = db!.prepare(sql); statement.setReturnArrays(true); statement.setReadBigInts(true)
        return (statement.all(...values) as unknown as unknown[][]).map(row => row.map(cell))
      };const adapter=sqliteCatalog(query);value=payload.diagram?{diagram:await readDiagram(adapter,query,'sqlite',payload.diagram,'session')}:await inspect(adapter,payload.object,'session') } finally { active = false }
    }
    else if (method === 'cancelBackup') backupController?.abort()
    else if (method === 'cancelImport') importController?.abort(new Error('Cancellation requested.'))
    else if (method === 'backup') {
      if (active || db!.isTransaction) throw new Error('Stop queries and commit or roll back before backup or restore.')
      const request = payload as BackupRequest
      backupController = new AbortController(); active = true
      const context = { signal: backupController.signal, log(message: string) { send({ backupProgress: message }) } }
      let source: DatabaseSync = db!, owned = false
      try {
        if (request.action === 'restore') {
          if (!(await header(request.artifact, 16)).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Choose a SQLite database snapshot.')
          source = new DatabaseSync(request.artifact, { readOnly: true, allowExtension: false }); owned = true
          if (source.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('SQLite backup integrity check failed.')
        }
        await publishFile(request.action === 'backup' ? request.artifact : request.target!, context, async path => {
          let last = -1
          await sqliteBackup(source, path, { rate: 128, progress: progress => {
            context.signal.throwIfAborted()
            const percent = Math.floor(100 * (progress.totalPages - progress.remainingPages) / Math.max(1, progress.totalPages))
            if (percent >= last + 5) { last = percent; send({ backupProgress: `SQLite snapshot: ${percent}% of pages copied.` }) }
          } })
        })
      } finally { if (owned) source.close(); active = false; backupController = undefined }
    }
    else if (method === 'editGrid') {
      if (active) throw new Error('Wait for the query to finish before editing data.')
      editor ??= new TableEditor('sqlite', async (sql, values = []) => {
        const statement = db!.prepare(sql)
        statement.setReadBigInts(true); statement.setReturnArrays(true)
        if (statement.columns().length) return { rows: (statement.all(...values) as unknown as unknown[][]).map(row => row.map(cell)), affected: 0 }
        return { rows: [], affected: Number(statement.run(...values).changes) }
      }, readOnly)
      active = true
      const info = payload.session as SessionInfo
      importController = new AbortController()
      try { value = await runGridOperation(editor, payload.request as GridOperation, info, async () => { info.transaction = state(); info.autocommit = !db!.isTransaction }, { signal: importController.signal, progress: rows => { if (rows % 100 === 0) send({ importProgress: rows }) } }) }
      finally { active = false; importController = undefined }
    }
    else if (method === 'close') { db?.close(); db = undefined; send({ id, ok: true }); process.disconnect(); return }
    else throw new Error('Unsupported SQLite operation.')
    send({ id, ok: true, value })
  } catch (error) { send({ id, ok: false, error: (error as Error).message }) }
})
process.on('disconnect', () => { db?.close(); process.exit(0) })
