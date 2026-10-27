import { access, mkdir, open, readFile, realpath, rename, unlink, link, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { normalizedSql, SQL_FILE_LIMIT, type SqlFileInfo, type SqlFilesState, type OpenedSqlFile, type PreparedSqlFileReload } from '../shared/sql-files'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const sqlHash = (sql: string) => hash(normalizedSql(sql))
const documentSchema = z.object({ tabId: z.string().uuid(), path: z.string().min(1).max(4096), savedHash: z.string().length(64), revision: z.string().length(64), bom: z.boolean(), eol: z.enum(['\n', '\r\n']) }).strict()
type Document = z.infer<typeof documentSchema>
const stateSchema = z.object({ version: z.literal(1), documents: z.array(documentSchema).max(20), recent: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096) }).strict()).max(20) }).strict()
type State = z.infer<typeof stateSchema>
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function inspect(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SQL files must be regular files, not symbolic links or directories.')
  if (stat.size > 4 * SQL_FILE_LIMIT) throw new Error('SQL files support up to 1,000,000 characters of UTF-8 text.')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('The SQL file changed while opening. Try again.')
    // Bounded read even when another process grows the file after stat.
    const bytes = Buffer.alloc(Math.min(before.size + 1, 4 * SQL_FILE_LIMIT + 1))
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    const after = await file.stat()
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('The SQL file changed while reading. Try again.')
    const data = bytes.subarray(0, bytesRead), bom = data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    let sql: string
    try { sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? data.subarray(3) : data) }
    catch { throw new Error('Open a UTF-8 SQL file. Convert other encodings before opening.') }
    if (sql.length > SQL_FILE_LIMIT || sql.includes('\0')) throw new Error('SQL files support at most 1,000,000 characters and cannot contain NUL bytes.')
    return { sql, bom, eol: (sql.includes('\r\n') ? '\r\n' : '\n') as '\n' | '\r\n', mode: after.mode, links: after.nlink,
      revision: hash(`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}:${hash(data)}`) }
  } finally { await file.close() }
}
async function maybeInspect(path: string) { try { return await inspect(path) } catch (error) { if (absent(error)) return null; throw error } }

/** Main-process capabilities: paths originate only in native dialogs or this
 * persisted registry. The renderer cannot submit an arbitrary path to read/write. */
export class SqlFiles {
  private state: State = { version: 1, documents: [], recent: [] }
  private notice?: string
  private writeError?: Error
  private pendingReload?: { id: string; previous: Document; next: Document; expiresAt: number }
  constructor(private readonly statePath: string) {}
  async load() {
    try {
      const info = await lstat(this.statePath)
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid SQL file registry.')
      const value = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (value && Number.isInteger(value.version) && value.version > 1) {
        this.writeError = new Error('SQL file associations were created by a newer Db Commander version and were kept intact. Recovered SQL buffers remain available; use that version for SQL file operations.')
        throw this.writeError
      }
      this.state = stateSchema.parse(value)
      this.writeError = undefined; this.notice = undefined
    } catch (error) {
      if (!absent(error)) { this.notice = this.writeError?.message ?? 'SQL file associations could not be restored. Recovered SQL buffers are intact; use Save As or reopen files.' }
    }
  }
  private async persist(next: State) {
    if (this.writeError) throw this.writeError
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(next)); await file.sync() } finally { await file.close() }
      await rename(temporary, this.statePath)
      // Failed writes must not advance associations or the saved-buffer hash.
      this.state = next
    } finally { await unlink(temporary).catch(() => {}) }
  }
  private touch(path: string, next = this.state): State {
    const previous = next.recent.find(item => samePath(item.path, path))
    return { ...next, recent: [{ id: previous?.id ?? randomUUID(), path }, ...next.recent.filter(item => !samePath(item.path, path))].slice(0, 20) }
  }
  async restore(tabIds: string[]) { await this.persist({ ...this.state, documents: this.state.documents.filter(item => tabIds.includes(item.tabId)) }); return this.check() }
  document(tabId: string) { return this.state.documents.find(item => item.tabId === tabId) }
  dirty(tabId: string, sql: string) { const doc = this.document(tabId); return doc ? sqlHash(sql) !== doc.savedHash : Boolean(sql.trim()) }
  recentPath(id: string) { const item = this.state.recent.find(item => item.id === id); if (!item) throw new Error('This recent file is no longer registered. Use Open SQL file.'); return item.path }
  private info(doc: Document, external: SqlFileInfo['external'] = 'unchanged'): SqlFileInfo { return { tabId: doc.tabId, path: doc.path, name: basename(doc.path), savedHash: doc.savedHash, external } }
  async check(): Promise<SqlFilesState> {
    const files: SqlFileInfo[] = []
    for (const doc of this.state.documents) {
      let external: SqlFileInfo['external']
      try { const disk = await maybeInspect(doc.path); external = !disk ? 'missing' : disk.revision === doc.revision ? 'unchanged' : 'changed' }
      catch { external = 'unavailable' }
      files.push(this.info(doc, external))
    }
    return { files, recent: this.state.recent.map(item => ({ ...item, name: basename(item.path) })), notice: this.notice }
  }
  async open(tabId: string, path: string): Promise<OpenedSqlFile> {
    const canonical = await realpath(path), disk = await inspect(canonical)
    const existing = this.state.documents.find(item => samePath(item.path, canonical))
    if (existing) { await this.persist(this.touch(canonical)); return { file: this.info(existing, disk.revision === existing.revision ? 'unchanged' : 'changed'), sql: disk.sql } }
    if (this.document(tabId) || this.state.documents.length >= 20) throw new Error('Open this file in a new available query tab.')
    const doc: Document = { tabId, path: canonical, savedHash: sqlHash(disk.sql), revision: disk.revision, bom: disk.bom, eol: disk.eol }
    await this.persist(this.touch(canonical, { ...this.state, documents: [...this.state.documents, doc] }))
    return { file: this.info(doc), sql: disk.sql }
  }
  async prepareReload(tabId: string): Promise<PreparedSqlFileReload> {
    if (this.writeError) throw this.writeError
    this.pendingReload = undefined
    const doc = this.document(tabId); if (!doc) throw new Error('This tab has no associated SQL file.')
    const disk = await inspect(doc.path)
    const next = { ...doc, savedHash: sqlHash(disk.sql), revision: disk.revision, bom: disk.bom, eol: disk.eol }
    const reloadId = randomUUID()
    // Retain metadata only. The renderer checks capacity and saves the accepted
    // SQL buffer before it can advance this file's conflict baseline.
    this.pendingReload = { id: reloadId, previous: doc, next, expiresAt: Date.now() + 300_000 }
    return { file: this.info(next), sql: disk.sql, reloadId }
  }
  async finishReload(reloadId: string, accept: boolean, savedTabs: readonly { id: string; sql: string }[] = []): Promise<SqlFileInfo | null> {
    const pending = this.pendingReload
    if (pending?.id !== reloadId) {
      if (!accept) return null
      throw new Error('This reload preview expired. Reload the file again.')
    }
    this.pendingReload = undefined
    if (!accept) return null
    if (Date.now() >= pending.expiresAt) throw new Error('This reload preview expired. Reload the file again.')
    if (this.document(pending.previous.tabId) !== pending.previous) throw new Error('The file association changed during reload. Reload the file again.')
    const saved = savedTabs.find(tab => tab.id === pending.next.tabId)
    if (!saved || sqlHash(saved.sql) !== pending.next.savedHash) throw new Error('The reloaded SQL buffer was not saved. Save the workspace and reload the file again.')
    await this.persist({ ...this.state, documents: this.state.documents.map(item => item === pending.previous ? pending.next : item) })
    return this.info(pending.next)
  }
  async forget(tabId: string) { await this.persist({ ...this.state, documents: this.state.documents.filter(item => item.tabId !== tabId) }) }
  async clearRecent() { await this.persist({ ...this.state, recent: [] }) }
  async save(tabId: string, sql: string, selectedPath?: string, approvedRevision?: string, track = true): Promise<{ file: SqlFileInfo } | { conflict: { path: string; revision: string } }> {
    if (this.writeError) throw this.writeError
    if (sql.length > SQL_FILE_LIMIT || sql.includes('\0')) throw new Error('SQL exceeds the supported text limit or contains NUL bytes.')
    const doc = this.document(tabId)
    if (!doc && !selectedPath) throw new Error('Choose a destination with Save As.')
    let path = selectedPath ? join(await realpath(dirname(resolve(selectedPath))), basename(selectedPath)) : doc!.path
    const disk = await maybeInspect(path)
    // Canonical spelling also detects an existing file selected with different
    // letter case on a case-insensitive filesystem. inspect rejects symlinks.
    if (disk) path = await realpath(path)
    if (this.state.documents.some(item => item.tabId !== tabId && samePath(item.path, path))) throw new Error('This file is already open in another tab. Save to a different file.')
    if (track && !doc && this.state.documents.length >= 20) throw new Error('Close a file tab before saving another file.')
    const same = doc && samePath(doc.path, path)
    if (!disk && !selectedPath) throw new Error('The SQL file was removed. Use Save As to recreate it or choose another file.')
    if (disk && (approvedRevision ? approvedRevision !== disk.revision : !same || disk.revision !== doc.revision)) return { conflict: { path, revision: disk.revision } }
    if (disk?.links && disk.links > 1) throw new Error('This file has multiple hard links. Use Save As to create an independent file.')
    if (disk) await access(path, constants.W_OK)
    const eol = same ? doc.eol : disk?.eol ?? '\n', bom = same ? doc.bom : disk?.bom ?? false
    const contents = (bom ? '\ufeff' : '') + normalizedSql(sql).replace(/\n/g, eol)
    const temporary = join(dirname(path), `.dbcommander-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', disk ? disk.mode & 0o777 : 0o600)
      try { await file.writeFile(contents, 'utf8'); if (disk) await file.chmod(disk.mode & 0o777); await file.sync() } finally { await file.close() }
      const latest = await maybeInspect(path)
      if ((latest?.revision ?? null) !== (disk?.revision ?? null)) throw new Error('The SQL file changed again before saving. Your buffer was kept; review the file and try again.')
      // Existing files are replaced atomically. New destinations use an exclusive
      // link so a file created after our check cannot be silently overwritten.
      if (disk) await rename(temporary, path)
      else {
        await link(temporary, path)
        // Removing the temporary link changes ctime. Capture the saved revision
        // only after that change, or a new file looks externally modified.
        await unlink(temporary)
      }
      const saved = await inspect(path)
      if (saved.sql !== contents.replace(/^\ufeff/, '')) throw new Error('The SQL file changed immediately after saving. Your buffer was kept; inspect the file before retrying.')
      const next: Document = { tabId, path, savedHash: sqlHash(sql), revision: saved.revision, bom, eol }
      if (track) {
        try { await this.persist(this.touch(path, { ...this.state, documents: [...this.state.documents.filter(item => item.tabId !== tabId), next] })) }
        catch (cause) {
          throw new Error('The SQL file was written, but its file association could not be saved. Your editor buffer and previous file association were kept. Check available disk space and folder permissions, then retry.', { cause })
        }
      }
      return { file: this.info(next) }
    } finally { await unlink(temporary).catch(() => {}) }
  }
}
