import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import type { Cell, ConnectionConfig } from '../shared/contracts'
import { physicalWorkerPath } from '../shared/physical-worker'
import { isRouted } from '../connections/transport'
import type { Frame } from './sqlserver-transport'

type Message = Exclude<Frame, { kind: 'error' }> | { kind: 'error'; message: string; code: string } |
  { kind: 'ready'; user: string } | { kind: 'database'; database: string } | { kind: 'complete' }

export function windowsSqlServerConfig(config: ConnectionConfig, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Windows Authentication requires Windows. Choose SQL login on this computer.')
  if (config.engine !== 'sqlserver' || config.authentication !== 'windows') throw new Error('Windows Authentication is available only for SQL Server.')
  if (config.ssh || isRouted(config)) throw new Error('Windows Authentication requires a direct SQL Server connection. Turn off the SSH tunnel.')
  if (config.ca?.trim()) throw new Error('Windows Authentication uses the Windows certificate store. Install your trusted CA there and clear the custom CA field.')
  return { Host: config.host, Port: config.port, Database: config.database, Encrypt: config.tls === 'verify-full' }
}

/** Yield one frame at a time. Stream backpressure reaches the helper's stdout,
 * bounding memory even for a full export or a slow consumer. */
async function* messages(output: Readable): AsyncGenerator<Message> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  for await (const chunk of output) {
    pending += decoder.write(chunk)
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      yield JSON.parse(line) as Message
    }
    if (pending.length > 64 * 1024 * 1024) throw new Error('A Windows SQL Server result exceeded the 64 MiB frame limit.')
  }
  if (pending.trim() || decoder.end()) throw new Error('Windows SQL Server returned an incomplete result.')
}

export class WindowsSqlServerConnection extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly input: AsyncGenerator<Message>
  private closed = false
  private busy = false
  user = ''

  constructor(config: ConnectionConfig, directory = __dirname) {
    super()
    const settings = windowsSqlServerConfig(config)
    this.child = spawn(physicalWorkerPath(directory, 'windows-sqlserver.exe', path), [], { windowsHide: true, stdio: 'pipe' })
    this.input = messages(this.child.stdout)
    this.on('error', () => {})
    this.child.on('error', () => { this.child.stdout.destroy(new Error('The Windows SQL Server helper could not start. Rebuild or reinstall Db Commander.')) })
    this.child.stdin.on('error', () => {})
    this.child.stderr.resume()
    this.child.once('exit', () => { this.closed = true; this.emit('end') })
    this.send(settings)
  }

  private send(value: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  async connect() {
    const timeout = setTimeout(() => this.close(), 20_000)
    try {
      while (true) {
        const next = await this.input.next()
        if (next.done) break
        const frame = next.value
        if (frame.kind === 'error') throw Object.assign(new Error(frame.message), { code: frame.code })
        if (frame.kind === 'ready') { this.user = frame.user; return }
      }
      throw new Error('Windows SQL Server did not finish opening the connection.')
    } finally { clearTimeout(timeout) }
  }

  close() { if (!this.closed) { this.closed = true; this.child.kill() } }

  stream(sql: string, values: (string | Buffer | null)[] = [], options?: { procedure?: boolean; prefix?: string; timeout?: number }) {
    if (this.closed) throw new Error('This Windows SQL Server connection is closed.')
    if (this.busy) throw new Error('This Windows SQL Server connection already has a running query.')
    this.busy = true
    this.send({ Action: 'query', Sql: sql, Parameters: values.map(value => ({ Value: Buffer.isBuffer(value) ? value.toString('base64') : value, Binary: Buffer.isBuffer(value) })), Prefix: options?.prefix ?? 'sc_p', Timeout: options?.timeout ?? 0, Procedure: options?.procedure ?? false })
    let finished = false, cancellation: ReturnType<typeof setTimeout> | undefined
    const self = this
    async function* frames(): AsyncGenerator<Frame> {
      let failure: Error | undefined
      try {
        while (true) {
          const next = await self.input.next()
          if (next.done) { yield { kind: 'error', error: Object.assign(new Error('The Windows SQL Server connection closed during execution.'), { code: 'ECONNCLOSED' }) }; break }
          const frame = next.value
          if (frame.kind === 'complete') { finished = true; if (failure) yield { kind: 'error', error: failure }; break }
          if (frame.kind === 'database') self.emit('databaseChange', frame.database)
          else if (frame.kind === 'error') failure = Object.assign(new Error(frame.message), { code: frame.code })
          else if (frame.kind !== 'ready') yield frame
        }
      } finally {
        if (cancellation) clearTimeout(cancellation)
        self.busy = false
        // An abandoned stream must not leave a reader or transaction reusable.
        if (!finished) self.close()
      }
    }
    return { frames: frames(), cancel() { if (!finished) { self.send({ Action: 'cancel' }); cancellation ??= setTimeout(() => self.close(), 5000) } } }
  }
}

export async function windowsSqlServerBound(connection: WindowsSqlServerConnection, sql: string, values: Cell[]) {
  const dml = /^(INSERT|UPDATE|DELETE)\b/.test(sql), rows: Cell[][] = []
  let failure: Error | undefined
  for await (const frame of connection.stream(dml ? `${sql}; SELECT @@ROWCOUNT AS dbcommander_affected` : sql, values, { prefix: 'p', timeout: 15 }).frames) {
    if (frame.kind === 'error') failure = frame.error
    else if (frame.kind === 'row') rows.push(frame.row)
  }
  if (failure) throw failure
  return { rows: dml ? [] : rows, affected: dml ? Number(rows.at(-1)?.[0] ?? -1) : 0 }
}
