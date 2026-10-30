import type { ConnectionConfig } from '../shared/contracts'
import { backupCapabilities, type BackupInspection, type BackupRequest } from '../shared/backup'
import type { BackupContext } from './context'
import { inspectBackupFile, inspectNewBackupFile } from './file-inspection'
import { inspectNativeTool } from './native-tool'
import { inspectBackupServer } from './server-inspection'
import { runTool, type BackupOptions } from './tools'

/** Advisory inspection. Execution retains every authoritative validation. */
export async function inspectBackup(config: ConnectionConfig, request: BackupRequest, context: BackupContext, options: BackupOptions = {}): Promise<BackupInspection> {
  const result: BackupInspection = { checkedAt: new Date().toISOString(), ready: false, checks: [], metadata: [] }
  const check = async (label: string, work: () => Promise<void>) => {
    try { context.signal.throwIfAborted(); await work(); context.signal.throwIfAborted(); result.checks.push({ label, status: 'passed', detail: 'Checked without creating or restoring a database.' }); return true }
    catch (error) { result.checks.push({ label, status: 'failed', detail: error instanceof Error ? error.message.slice(0, 2000) : 'The check could not finish.' }); return false }
  }
  const local = backupCapabilities[config.engine].location === 'local'
  let recognizedFile = false
  if (local) {
    if (request.action === 'backup') await check('New backup destination', () => inspectNewBackupFile(request.artifact))
    else {
      recognizedFile = await check('Backup file and format', async () => { result.metadata.push(...await inspectBackupFile(config.engine, request)) })
      if (['sqlite', 'duckdb'].includes(config.engine)) await check('New restore destination', () => inspectNewBackupFile(request.target!))
    }
  }
  let tool: Awaited<ReturnType<typeof inspectNativeTool>> | undefined
  const needsTool = ['postgres', 'mysql', 'mariadb'].includes(config.engine)
  if (needsTool) await check('Native client tool', async () => {
    tool = await inspectNativeTool(config.engine, request, context, options)
    result.metadata.push({ label: 'Client tool', value: tool.version.slice(0, 1000) })
  })
  if (config.engine === 'postgres' && request.action === 'restore' && tool && !result.checks.some(check => check.status === 'failed')) await check('Archive metadata', async () => {
    const listing = await (options.runTool ?? runTool)({ executable: tool!.executable, args: ['--list', request.artifact] }, context)
    const version = listing.match(/Dumped from database version:\s*(\d+)/)?.[1]
    if (!version || Number(version) > tool!.major) throw new Error('The archive requires a newer PostgreSQL server/tool version.')
    for (const [label, pattern] of [['Source database', /dbname:\s*([^\r\n]+)/], ['Source database version', /Dumped from database version:\s*([^\r\n]+)/]] as const) {
      const value = listing.match(pattern)?.[1]; if (value) result.metadata.push({ label, value: value.slice(0, 1000) })
    }
  })
  if (!['sqlite', 'duckdb'].includes(config.engine) && (!needsTool || tool) && !result.checks.some(check => check.status === 'failed')) await check('Server and restore target', () => inspectBackupServer(config, request, context, result, tool?.major))
  if (recognizedFile && ['sqlite', 'duckdb'].includes(config.engine) && request.action === 'restore') result.checks.push({ label: 'Restore validation', status: 'warning', detail: config.engine === 'sqlite' ? 'The file header matches. The restore job performs SQLite integrity validation before publishing the new file.' : 'The file header matches. The restore job opens the snapshot with extensions disabled and imports its native schema/data before publishing the new file.' })
  result.ready = !result.checks.some(check => check.status === 'failed')
  return result
}
