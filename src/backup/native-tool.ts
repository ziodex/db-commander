import { isAbsolute, join } from 'node:path'
import type { DatabaseEngine } from '../shared/contracts'
import type { BackupRequest } from '../shared/backup'
import type { BackupContext } from './context'
import { runTool, type BackupOptions } from './tools'

export async function inspectNativeTool(engine: DatabaseEngine, request: BackupRequest, context: BackupContext, options: BackupOptions) {
  const postgres = engine === 'postgres', maria = engine === 'mariadb'
  const name = request.action === 'backup' ? postgres ? 'pg_dump' : maria ? 'mariadb-dump' : 'mysqldump' : postgres ? 'pg_restore' : maria ? 'mariadb' : 'mysql'
  if (request.toolDirectory && !isAbsolute(request.toolDirectory)) throw new Error('The native tools directory must be an absolute path.')
  const executable = request.toolDirectory ? join(request.toolDirectory, name + (process.platform === 'win32' ? '.exe' : '')) : name
  const version = await (options.runTool ?? runTool)({ executable, args: ['--version'] }, context)
  const major = Number((postgres ? version.match(/PostgreSQL\)\s+(\d+)/) : version.match(maria ? /(?:from|Distrib)\s+(\d+)\./ : /(?:Ver|Distrib)\s+(\d+)\./))?.[1])
  if (!major || (!postgres && /mariadb/i.test(version) !== maria)) throw new Error('The selected native tool does not match the database engine.')
  return { executable, version, major }
}
