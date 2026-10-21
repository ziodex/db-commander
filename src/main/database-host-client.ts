import { randomUUID } from 'node:crypto'
import type { DatabaseEvent } from '../shared/contracts'
import type { BackupJob } from '../shared/backup'
import type { TransferJob } from '../shared/transfer'
import type { HostArgs, HostMethod, HostResult, HostMessage } from '../shared/host-rpc'

interface HostCallbacks {
  event(event: DatabaseEvent, token?: string): void
  backup(job: BackupJob): void
  transfer(job: TransferJob): void
  exited(startupFailure?: string): void
}

interface HostProcess {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: HostMessage) => void): void
  on(event: 'exit', listener: () => void): void
  once(event: 'exit', listener: () => void): void
}

const unbounded = new Set<HostMethod>(['applyActivityAction', 'editGrid', 'inspectImport', 'startTransfer', 'switchDatabase', 'databases', 'applySchemaChange', 'connect', 'explain', 'compareData'])
const inspection = new Set<HostMethod>(['inspectRollback', 'inspectActivity', 'inspectObject', 'prepareSchemaChange', 'diagram', 'compareSchemas'])

/** One workspace owns this host until exit, including after startup failure. */
export class DatabaseHostClient {
  private child?: HostProcess
  private ready?: Promise<void>
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }>()
  private acknowledgements = new Set<string>()

  constructor(private launch: () => HostProcess, private callbacks: HostCallbacks) {}

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    const starting = new Promise<void>((resolve, reject) => {
      const child = this.launch()
      this.child = child
      let startupFailure: string | undefined
      const startup = setTimeout(() => {
        reject(new Error('Database host did not start.'))
        child.kill()
      }, 15000)
      child.on('message', (message: HostMessage) => {
        if ('startupError' in message) {
          startupFailure = message.startupError
          clearTimeout(startup); reject(new Error(startupFailure)); child.kill(); return
        }
        if ('ready' in message) { clearTimeout(startup); resolve(); return }
        if ('backupJob' in message) { this.callbacks.backup(message.backupJob); return }
        if ('transferJob' in message) { this.callbacks.transfer(message.transferJob); return }
        if ('event' in message) {
          if (message.token) this.acknowledgements.add(message.token)
          this.callbacks.event(message.event, message.token)
          return
        }
        const request = this.pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer); this.pending.delete(message.id)
        if (message.ok) request.resolve(message.value)
        else request.reject(new Error(message.error))
      })
      child.on('exit', () => {
        clearTimeout(startup)
        reject(new Error(startupFailure ?? 'Database host exited.'))
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('Database host exited. An in-flight operation may have an unknown outcome.'))
        }
        this.pending.clear(); this.acknowledgements.clear()
        this.child = undefined; this.ready = undefined
        this.callbacks.exited(startupFailure)
      })
    })
    this.ready = starting
    // A synchronous fork failure has no exit event to clear readiness.
    void starting.catch(() => { if (!this.child && this.ready === starting) this.ready = undefined })
    return starting
  }

  async call<K extends HostMethod>(method: K, ...args: HostArgs<K>): Promise<HostResult<K>> {
    await this.ensureReady()
    const child = this.child
    if (!child) throw new Error('Database host exited. An in-flight operation may have an unknown outcome.')
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      // Writes remain owned until completion or host exit. A transport timeout
      // must never make an ongoing database change look safe to retry.
      const timer = unbounded.has(method) ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Operation timed out. Inspect connection state before retrying.'))
      }, inspection.has(method) ? 60000 : 30000)
      // Request/result correlation is erased only inside this transport map.
      this.pending.set(id, { resolve: value => resolve(value as HostResult<K>), reject, timer })
      try { child.postMessage({ id, method, payload: args[0] }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  acknowledge(token: string) {
    if (this.acknowledgements.delete(token)) this.child?.postMessage({ ack: token })
  }

  kill() { this.child?.kill() }

  stop(): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise(resolve => { child.once('exit', () => resolve()); child.kill() })
  }
}
