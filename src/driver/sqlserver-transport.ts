import { Readable } from 'node:stream'
import { connect } from 'node:net'
import { endpoint, isRouted } from '../connections/transport'
import { Connection, Request, TYPES, type ConnectionConfiguration } from 'tedious'
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'
import type { Cell, Column, ConnectionConfig } from '../shared/contracts'
import { enableExactTdsValues } from './sqlserver-values'

export function buildSqlServerConfig(config: ConnectionConfig): ConnectionConfiguration {
  if (!['sqlserver', 'azure-sql'].includes(config.engine)) throw new Error('Expected a SQL Server or Azure SQL connection.')
  if (config.engine === 'azure-sql' && config.tls !== 'verify-full') throw new Error('Azure SQL requires verified TLS.')
  const token = config.authentication === 'entra-token'
  if (token && (config.engine !== 'azure-sql' || !config.accessToken?.trim())) throw new Error('An Entra access token is required and is supported only for Azure SQL.')
  return {
    server: config.host,
    authentication: token ? { type: 'azure-active-directory-access-token', options: { token: config.accessToken! } } : { type: 'default', options: { userName: config.user, password: config.password } },
    options: { port: config.port, database: config.database || (config.engine === 'azure-sql' ? 'master' : undefined), appName: 'Db Commander',
      ...(isRouted(config) ? { connector: async (options?: { host: string; port: number }, _lookup?: unknown, signal?: AbortSignal) => {
        // The pinned driver passes these arguments at runtime; its declaration
        // omits them. Fail closed if that contract changes or a redirect occurs.
        if (options?.host !== config.host || options?.port !== config.port) throw new Error('SSH connections do not follow server redirects. Use a fixed endpoint (Azure SQL Proxy policy).')
        return new Promise<import('node:net').Socket>((resolve, reject) => { const socket = connect({ ...endpoint(config), signal }); socket.once('connect', () => resolve(socket)); socket.once('error', reject) })
      } } : {}),
      encrypt: config.tls === 'verify-full', trustServerCertificate: false, serverName: config.host,
      cryptoCredentialsDetails: config.ca?.trim() ? { ca: config.ca } : undefined,
      connectTimeout: 15000, requestTimeout: 0, cancelTimeout: 5000, maxRetriesOnTransientErrors: 0,
      rowCollectionOnDone: false, rowCollectionOnRequestCompletion: false, useColumnNames: false, useUTC: true }
  }
}
export type Frame = { kind: 'fields'; columns: Column[] } | { kind: 'row'; row: Cell[] } |
  { kind: 'done'; count: number | undefined } | { kind: 'notice'; message: string } | { kind: 'error'; error: Error }
function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return '0x' + value.toString('hex')
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}
export async function openSqlServer(config: ConnectionConfig): Promise<Connection> {
  const connection = new Connection(buildSqlServerConfig(config))
  enableExactTdsValues(connection)
  // Tedious can emit an error before connect completes; the callback carries it.
  connection.on('error', () => {})
  try { await new Promise<void>((resolve, reject) => connection.connect(error => error ? reject(error) : resolve())) }
  catch (error) { connection.close(); throw error }
  return connection
}
/** Bounded token queue. Pausing the request propagates to the TDS parser. */
export function streamSqlServer(connection: Connection, sql: string, values?: (string|Buffer|null)[], options?: { procedure: true }) {
  let finished = false
  const stream = new Readable({ objectMode: true, highWaterMark: 16, read() { request.resume() } })
  const push = (frame: Frame) => { if (!finished && !stream.push(frame)) request.pause() }
  const end = (error?: Error | null) => {
    if (finished) return
    connection.off('end', lost); connection.off('error', end); connection.off('infoMessage', notice)
    if (error) {
      if (error instanceof AggregateError && error.errors.every(item => item.code === 'EREQUEST')) Object.assign(error, { code: 'EREQUEST', message: error.errors.map(item => item.message).join('\n') })
      push({ kind: 'error', error })
    }
    finished = true; stream.push(null)
  }
  const lost = () => end(Object.assign(new Error('The SQL Server connection closed during execution.'), { code: 'ECONNCLOSED' }))
  const request = new Request(sql, error => end(error))
  request.on('columnMetadata', columns => push({ kind: 'fields', columns: (columns as ColumnMetadata[]).map(column => ({ name: column.colName, typeId: column.type.id, typeName: column.type.name })) }))
  request.on('row', columns => push({ kind: 'row', row: (columns as { value: unknown }[]).map(column => cell(column.value)) }))
  request.on('done', count => push({ kind: 'done', count }))
  request.on('doneInProc', count => push({ kind: 'done', count }))
  // DONEPROC is a procedure summary; counting it duplicates the last result.
  const notice = (info: { message: string }) => push({ kind: 'notice', message: info.message })
  connection.on('infoMessage', notice)
  connection.on('end', lost); connection.on('error', end)
  values?.forEach((value, index) => request.addParameter(`sc_p${index + 1}`, Buffer.isBuffer(value) ? TYPES.VarBinary : TYPES.NVarChar, value, { length: Infinity }))
  if (options?.procedure) connection.callProcedure(request)
  else if (values?.length) connection.execSql(request)
  else connection.execSqlBatch(request)
  return { frames: stream as AsyncIterable<Frame>, cancel() { if (!finished) { request.cancel(); request.resume() } } }
}
export async function sqlServerQuery(connection: Connection, sql: string, maxRows = 2000): Promise<Cell[][]> {
  const rows: Cell[][] = []
  for await (const frame of streamSqlServer(connection, sql).frames) {
    if (frame.kind === 'error') throw frame.error
    if (frame.kind === 'row') { if (rows.length >= maxRows) throw new Error('Internal query exceeded its row limit.'); rows.push(frame.row) }
  }
  return rows
}

/** True TDS parameters. @@ROWCOUNT is captured in the same batch, independent
 * of trigger DONE tokens and SET NOCOUNT. Grid SQL is generated by the host. */
export function sqlServerBound(connection: Connection, sql: string, values: Cell[] = []): Promise<import('./table-editor').GridQueryResult> {
  const dml = /^(INSERT|UPDATE|DELETE)\b/.test(sql), rows: Cell[][] = []
  return new Promise((resolve, reject) => {
    const request = new Request(dml ? `${sql}; SELECT @@ROWCOUNT AS dbcommander_affected` : sql, error => {
      if (error) reject(error)
      else resolve({ rows: dml ? [] : rows, affected: dml ? Number(rows.at(-1)?.[0] ?? -1) : 0 })
    })
    request.setTimeout(15000)
    values.forEach((value, index) => request.addParameter(`p${index + 1}`, TYPES.NVarChar, value, { length: Infinity }))
    request.on('row', columns => rows.push((columns as { value: unknown }[]).map(column => cell(column.value))))
    // sp_executesql requires the transaction count to match on return and
    // scopes SET options to its procedure call. Session control statements
    // without parameters must execute as batches so BEGIN/ROLLBACK and SET
    // remain effective for the following grid requests.
    if (values.length) connection.execSql(request)
    else connection.execSqlBatch(request)
  })
}
