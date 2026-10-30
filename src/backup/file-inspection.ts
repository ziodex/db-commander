import { access, lstat, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseEngine } from '../shared/contracts'
import type { BackupInspection, BackupRequest } from '../shared/backup'
import { absoluteFile, header } from './files'

export async function inspectNewBackupFile(file: string) {
  absoluteFile(file)
  try { await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = await stat(dirname(file))
    if (!parent.isDirectory()) throw new Error('Choose an existing destination folder.')
    await access(dirname(file), constants.W_OK)
    return
  }
  throw new Error('The destination already exists. Choose a new file; existing files are never replaced.')
}

export async function inspectBackupFile(engine: DatabaseEngine, request: BackupRequest): Promise<BackupInspection['metadata']> {
  const data = await header(request.artifact), info = await lstat(request.artifact)
  if (!info.size) throw new Error('The backup file is empty.')
  const metadata = [{ label: 'File size', value: `${info.size.toLocaleString('en-US')} bytes` }, { label: 'Last modified', value: info.mtime.toISOString() }]
  if (engine === 'sqlite' && !data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Choose a SQLite database snapshot.')
  if (engine === 'duckdb' && data.subarray(8, 12).toString() !== 'DUCK') throw new Error('Choose a DuckDB database snapshot.')
  if (engine === 'postgres' && data.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Choose a PostgreSQL custom-format archive.')
  if (engine === 'mysql' || engine === 'mariadb') {
    let source: { engine?: string; version?: string; content?: string }
    try { source = JSON.parse(data.toString().split('\n')[0].replace(/^-- (?:Db Commander|SQLCommander) /, '')) }
    catch { throw new Error('Choose a Db Commander SQL dump for this engine.') }
    if (source.engine !== engine || typeof source.version !== 'string' || !/^\d+\./.test(source.version)) throw new Error('The SQL dump engine or version is not compatible.')
    metadata.push({ label: 'Source server version', value: source.version.slice(0, 100) }, { label: 'Contents', value: source.content === 'schema' ? 'Schema only' : source.content === 'all' ? 'Schema and data' : 'Not reported' })
  }
  return metadata
}
