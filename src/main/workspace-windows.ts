import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MAX_SAVED_WINDOWS, workspaceWindowIdSchema, workspaceWindowNameSchema, workspaceWindowSchema, type WorkspaceWindow } from '../shared/workspace-windows'

const recordsSchema = z.array(workspaceWindowSchema).max(MAX_SAVED_WINDOWS).refine(records =>
  records.some(record => record.id === 'primary') && new Set(records.map(record => record.id)).size === records.length)

/** Each record owns a separate store, credential namespace, file journal and database host. */
export class WorkspaceWindowsStore {
  private records: WorkspaceWindow[] = [{ id: 'primary', name: 'Primary' }]
  private pending: Promise<unknown> = Promise.resolve()
  private loadError: Error | undefined
  constructor(private root: string) {}
  async load() {
    const file = join(this.root, 'windows.json')
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
      let records: WorkspaceWindow[]
      try {
        const before = await handle.stat()
        if (!before.isFile()) throw new Error('Workspace window registry is not a regular file.')
        if (before.size > 32_768) throw new Error('Workspace window registry is too large.')
        // Bound descriptor reads even if another process grows the file after stat.
        const data = Buffer.alloc(32_769)
        let length = 0
        while (length < data.length) {
          const { bytesRead } = await handle.read(data, length, data.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        const after = await handle.stat()
        if (length > 32_768 || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
          throw new Error('Workspace window registry changed while reading.')
        }
        records = recordsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))))
      } finally { await handle.close() }
      this.records = records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadError = new Error('Cannot read the workspace window list. Your saved workspaces have been kept. Repair windows.json before creating or opening other windows.')
        throw this.loadError
      }
    }
  }
  list() { return this.records.map(record => ({ ...record })) }
  get(id: string) {
    workspaceWindowIdSchema.parse(id)
    const record = this.records.find(record => record.id === id)
    if (!record) throw new Error('Workspace window does not exist.')
    return { ...record }
  }
  directory(id: string) { this.get(id); return id === 'primary' ? this.root : join(this.root, 'windows', id) }
  create(name: string): Promise<WorkspaceWindow> {
    const validated = workspaceWindowNameSchema.parse(name)
    const operation = this.pending.catch(() => {}).then(async () => {
      if (this.loadError) throw this.loadError
      if (this.records.length >= MAX_SAVED_WINDOWS) throw new Error(`At most ${MAX_SAVED_WINDOWS} workspace windows can be saved.`)
      const record = { id: randomUUID(), name: validated }, records = [...this.records, record]
      const file = join(this.root, 'windows.json'), temporary = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(this.root, { recursive: true })
        await writeFile(temporary, JSON.stringify(records), { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
        this.records = records
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      return { ...record }
    })
    this.pending = operation; return operation
  }
}
