import type { GridQuery } from './table-editor'
import mysql, { type Connection as MysqlConnection, type FieldPacket } from 'mysql2'
import mariadb, { type Connection as MariaConnection, type FieldInfo } from 'mariadb'
import { checkServerIdentity, rootCertificates, type TLSSocket, type ConnectionOptions as TlsOptions } from 'node:tls'
import { isIP, connect } from 'node:net'
import { endpoint, isRouted } from '../connections/transport'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { Cell, Column, ConnectionConfig } from '../shared/contracts'

type MysqlFrame = { kind: 'fields'; columns: Column[] } | { kind: 'row'; row: Cell[] } | { kind: 'ok'; affectedRows: number; warnings: number }
export interface MysqlTransport {
  id: number
  bound: GridQuery
  query(sql: string, values?: unknown[]): Promise<Cell[][]>
  stream(sql: string, values?: (string|Buffer|null)[]): AsyncIterable<MysqlFrame>
  status(afterError?: boolean): Promise<number>
  onLost(listener: () => void): void
  end(): Promise<void>
  destroy(): void
}
const hex = (value: Buffer | null): Cell => value === null ? null : `0x${value.toString('hex')}`
const isBinary = (type: number, charset: number) => type === 16 || type === 255 || (charset === 63 && [15, 249, 250, 251, 252, 253, 254].includes(type))
const fieldMarker = Symbol('column metadata')
type FieldMarker = { [fieldMarker]: Column[] }

async function* frames(source: Readable): AsyncIterable<MysqlFrame> {
  // Queue metadata in the SAME Readable as rows. Forwarding fields directly to
  // consumers can reorder CALL's result sets while the row stream is paused.
  for await (const item of source) {
    if (fieldMarker in item) yield { kind: 'fields', columns: (item as FieldMarker)[fieldMarker] }
    else if (Array.isArray(item)) yield { kind: 'row', row: item.map(value=>value===null?null:Buffer.isBuffer(value)?hex(value):value instanceof Date?value.toISOString():String(value)) }
    else yield { kind: 'ok', affectedRows: Number(item.affectedRows), warnings: Number(item.warningStatus ?? item.warningCount ?? 0) }
  }
}

async function* connectionFrames(source: Readable, connection: EventEmitter): AsyncIterable<MysqlFrame> {
  // mysql2 emits fatal socket failures on the connection, not on Query.stream.
  // Forward them so a pending iterator cannot hang forever after disconnect.
  const failed = (error: Error) => source.destroy(error)
  const ended = () => { if (!source.readableEnded) source.destroy(Object.assign(new Error('Database connection closed.'), { code: 'CONNECTION_LOST', fatal: true })) }
  connection.on('error', failed); connection.on('end', ended)
  try { yield* frames(source) }
  finally { connection.off('error', failed); connection.off('end', ended) }
}

function options(config: ConnectionConfig) {
  return { host: config.host, port: config.port, user: config.user, password: config.password, database: config.database || undefined,
    ...(isRouted(config) ? { stream: () => connect(endpoint(config)) } : {}),
    connectTimeout: 8000, multipleStatements: false, rowsAsArray: true, charset: 'utf8mb4',
    // Supplying roots explicitly also disables MariaDB's automatic fingerprint
    // authentication: verify-full must always verify a trusted CA and hostname.
    ssl: config.tls === 'verify-full' ? { rejectUnauthorized: true, ca: config.ca || [...rootCertificates] } : undefined }
}

export async function openMysqlTransport(config: ConnectionConfig): Promise<MysqlTransport> {
  if (config.engine === 'mariadb') {
    const base = options(config)
    const ssl: TlsOptions | undefined = base.ssl ? { ...base.ssl,
      ...(isIP(config.host) ? {} : { servername: config.host }),
      checkServerIdentity: (_host, certificate) => checkServerIdentity(config.host, certificate)
    } : undefined
    const connection = await mariadb.createConnection({ ...base, ssl, permitLocalInfile: false, pipelining: false, autoJsonMap: false,
    // The text protocol lets all numeric/date values remain exact strings.
    typeCast: field => isBinary(field.columnType, field.collation.index) ? hex(field.buffer()) : field.string() })
    connection.on('error', () => {})
    return {
      async bound(sql, values = []) {
        const result = await connection.execute(sql, values)
        return { rows: Array.isArray(result) ? result : [], affected: Number(result.affectedRows ?? 0), warnings: Number(result.warningStatus ?? 0) }
      },
      id: connection.threadId!, query: (sql, values) => connection.query<Cell[][]>(sql, values),
      async *stream(sql, values) {
        const prepared=values?await connection.prepare(sql):undefined
        const source = prepared ? prepared.executeStream(values) : connection.queryStream(sql)
        source.on('fields', (fields: FieldInfo[]) => {
          if (!source.push({ [fieldMarker]: fields.map(field => ({ name: field.name(), typeId: field.columnType, typeName: isBinary(field.columnType, field.collation.index) ? 'BINARY' : field.dataTypeName ?? field.type })) })) {
            // pause/resume are exposed at runtime in the pinned connector, but
            // omitted from its declarations. The Readable's _read resumes it.
            ;(connection as MariaConnection & { pause(): void }).pause()
          }
        })
        try { yield* connectionFrames(source,connection) } finally { prepared?.close() }
      },
      async status(afterError) { if (afterError) await connection.ping(); return connection.info!.status },
      onLost(listener) { connection.on('error', listener); connection.on('end', listener) },
      end: () => connection.end(), destroy: () => connection.destroy()
    }
  }
  const base = options(config)
  let serverStatus: number | undefined
  const connection = mysql.createConnection({ ...base, ssl: base.ssl ? { ...base.ssl, verifyIdentity: true } : undefined,
    flags: ['-LOCAL_FILES'], enableKeepAlive: true, typeCast: field => field.type === 'JSON' ? field.string('utf8') : field.string() })
  connection.on('error', () => {})
  try {
    await new Promise<void>((resolve, reject) => connection.connect(error => error ? reject(error) : resolve()))
    if (base.ssl) {
      // mysql2's built-in identity check omits IP hosts. Check the peer against
      // the original host ourselves, including iPAddress SANs, before returning.
      const socket = (connection as MysqlConnection & { stream: TLSSocket }).stream
      const error = checkServerIdentity(config.host, socket.getPeerCertificate(true))
      if (error) throw error
    }
  } catch (error) { connection.destroy(); throw error }
  return {
    id: connection.threadId!,
    bound(sql, values = []) {
      return new Promise((resolve, reject) => {
        const receive = (error: Error | null, result: unknown) => {
          if (error) { reject(error); return }
          const header = result as mysql.ResultSetHeader
          resolve({ rows: Array.isArray(result) ? (result as unknown[][]).map(row => row.map(value => value === null ? null : String(value))) : [], affected: Number(header.affectedRows ?? 0), warnings: Number(header.warningStatus ?? 0) })
        }
        // MySQL cannot prepare START TRANSACTION. Only these fixed, value-free
        // control statements use the text protocol; all row values stay bound.
        const command = !values.length && /^(START TRANSACTION|COMMIT|ROLLBACK)$/.test(sql)
          ? connection.query(sql, receive)
          : connection.execute({ sql, typeCast: (_field, next) => next(), dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }, values, receive)
        observeStatus(command, value => { serverStatus = value })
      })
    },
    query(sql, values) {
      return new Promise((resolve, reject) => {
        const query = connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows as Cell[][]))
        observeStatus(query, value => { serverStatus = value })
      })
    },
    stream(sql, values) {
      let fields: FieldPacket[] = [], ordinal = 0
      const query = values ? connection.execute({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,typeCast:(field,next)=>field.type==='JSON'?field.string('utf8'):field.type==='GEOMETRY'?hex(field.buffer()):next()},values) : connection.query({ sql, typeCast: field => {
        const column = fields[ordinal++ % fields.length]
        return column && isBinary(column.columnType ?? -1, column.characterSet ?? -1) ? hex(field.buffer()) : field.type === 'JSON' ? field.string('utf8') : field.string()
      } })
      observeStatus(query, value => { serverStatus = value })
      const source = query.stream({ highWaterMark: 16 })
      source.on('fields', (metadata: FieldPacket[] | undefined) => {
        if (!metadata) return
        fields = metadata; ordinal = 0
        if (!source.push({ [fieldMarker]: fields.map(field => ({ name: field.name, typeId: field.columnType, typeName: isBinary(field.columnType ?? -1, field.characterSet ?? -1) ? 'BINARY' : [15,249,250,251,252,253,254].includes(field.columnType ?? -1) ? 'TEXT' : undefined })) })) connection.pause()
      })
      return connectionFrames(source, connection)
    },
    status: async () => serverStatus ?? await mysqlStatus(connection),
    onLost(listener) { connection.on('error', listener); connection.on('end', listener) },
    end: () => connection.promise().end(), destroy: () => connection.destroy()
  }
}

interface StatusPacket {
  offset: number
  isError(): boolean
  isEOF(): boolean
  eofStatusFlags(): number
  readInt8(): number
  readLengthCodedNumber(): number
  readInt16(): number
}
interface PingCommand {
  execute(packet: StatusPacket | undefined, connection: unknown): boolean
}
function observeStatus(query: NodeJS.EventEmitter, receive: (status: number | undefined) => void) {
  const command = query as unknown as PingCommand
  const execute = command.execute
  command.execute = function(packet, connection) {
    if (packet?.isEOF()) receive(packet.eofStatusFlags())
    if (packet?.isError()) receive(undefined)
    return execute.call(this, packet, connection)
  }
  query.on('result', (result: { serverStatus?: number }) => { if (typeof result.serverStatus === 'number') receive(result.serverStatus) })
}
/** COM_PING recovers authoritative status after an error packet (which has no
 * status flags). Successful queries use their own EOF/OK status instead. PING
 * resets ROW_COUNT, so it must not be inserted after successful user statements.
 * mysql2 discards the status: this isolated pinned hook reads the OK packet and
 * restores its offset before delegating. Docker covers DDL, errors and manual mode.
 */
function mysqlStatus(connection: MysqlConnection): Promise<number> {
  return new Promise((resolve, reject) => {
    let status: number | undefined
    const command = connection.ping(error => error ? reject(error) : status === undefined ? reject(new Error('Missing MySQL transaction status.')) : resolve(status)) as unknown as PingCommand
    const execute = command.execute
    command.execute = function(packet, client) {
      if (packet && !packet.isError()) {
        const offset = packet.offset
        try {
          if (packet.readInt8() === 0) { packet.readLengthCodedNumber(); packet.readLengthCodedNumber(); status = packet.readInt16() }
        } finally { packet.offset = offset }
      }
      return execute.call(this, packet, client)
    }
  })
}
