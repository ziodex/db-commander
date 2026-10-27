import { chmod, link, lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { BackupContext } from './context'
import { check } from './context'

export function absoluteFile(file: string) {
  if (!isAbsolute(file) || /[\u0000-\u001f]/.test(file)) throw new Error('Choose an absolute local file path without control characters.')
}
async function absent(file: string) {
  absoluteFile(file)
  try { await lstat(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw new Error('The destination already exists. Choose a new file; existing files are never replaced.')
}
export async function header(file: string, size = 4096) {
  absoluteFile(file)
  const info = await lstat(file)
  if (!info.isFile()) throw new Error('Choose a regular backup file, not a directory or symbolic link.')
  const handle = await open(file, 'r')
  try { const buffer = Buffer.alloc(size); const { bytesRead } = await handle.read(buffer, 0, size, 0); return buffer.subarray(0, bytesRead) }
  finally { await handle.close() }
}
/** Publish a completed, closed file atomically without replacing any existing inode. */
export async function publishFile(file: string, context: BackupContext, write: (temporary: string) => Promise<void>) {
  await absent(file); check(context)
  const directory = await mkdtemp(join(dirname(file), '.dbcommander-backup-'))
  try {
    const temporary = join(directory, 'backup')
    await write(temporary); check(context)
    await chmod(temporary, 0o600)
    const handle = await open(temporary, 'r+')
    try { await handle.sync(); check(context); await handle.close() }
    finally { await handle.close().catch(() => {}) }
    // Sync/close may take time. Cancellation still wins until publication starts;
    // once the atomic link is issued, a completed file is a successful outcome.
    check(context)
    await link(temporary, file)
  } finally {
    // Cleanup cannot undo publication or replace a write/query/cancellation error.
    // Brief file locks are retried; persistent failures leave private scratch
    // files for manual removal and are reported independently of the outcome.
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    catch {
      try { context.log(`Temporary backup/export files could not be removed from ${directory}. Remove this folder when it is no longer in use.`) } catch { /* Notification failure cannot change the file outcome. */ }
    }
  }
}
