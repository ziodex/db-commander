import { DatabaseHostClient } from './database-host-client'
import { SqlFiles } from '../files/sql-files'
import { openSqlFileSchema, saveSqlFileSchema, reloadSqlFileSchema, finishSqlFileReloadSchema, type SaveSqlFileRequest } from '../shared/sql-files'
import { rollbackRequestSchema } from '../shared/rollback'
import { prepareActivityActionSchema, applyActivityActionSchema } from '../shared/activity-control'
import { activityRequestSchema, activitySnapshotSchema } from '../shared/activity'
import { dataCompareSchema } from '../shared/data-compare'
import { prepareBuilderSchema } from '../shared/query-builder'
import { prepareMigrationSchema, saveMigrationSchema, type MigrationPreview } from '../shared/migrations'
import { writeMigrationFile } from './migration-file'
import { readSnippetFile, writeSnippetFile } from '../files/snippet-files'
import { readProfileFile, writeProfileFile } from './profile-files'
import { profileDocument } from '../shared/profile-files'
import { readEditorSettingsFile, writeEditorSettingsFile } from '../files/editor-settings-files'
import { editorSettingsSchema } from '../shared/editor-settings'
import { snippetExportSchema, snippetImportSchema, type SnippetDocument, type SnippetImportPreview } from '../shared/snippet-files'
import { compareSchemaSchema } from '../shared/schema-compare'
import { diagramRequestSchema, diagramExportSchema, diagramSvg } from '../shared/diagram'
import { historySearchSchema, historySettingsSchema, snippetSchema, snippetSearchSchema } from '../shared/query-library'
import { explainRequestSchema, PLAN_LIMIT } from '../shared/explain'
import { inspectObjectSchema } from '../shared/catalog'
import { sshSecretsSchema } from '../shared/connection-options'
import { prepareSchemaChangeSchema, applySchemaChangeSchema } from '../shared/schema-changes'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MenuItem, net, powerMonitor, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { UpdateChecker } from './update-checker'
import { DesktopSettings } from './desktop-settings'
import { SystemTray } from './system-tray'
import { applicationProfile } from './application-profile'
import { applicationMenu, executeApplicationMenu, installMenuKeys, updateTitleBar, windowsTitleBar } from './application-menu'
import { menuPathSchema, titleBarAppearanceSchema } from '../shared/application-menu'
import { join, basename } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'
import { rendererOrigin } from './renderer-origin'
import { writeGeneratedFile } from './generated-file'
import { createHash, randomUUID } from 'node:crypto'
import { WorkspaceWindowsStore } from './workspace-windows'
import { WindowIpc } from './window-ipc'
import { MAX_OPEN_WINDOWS, workspaceWindowIdSchema, workspaceWindowNameSchema, type WorkspaceWindow } from '../shared/workspace-windows'
import { z } from 'zod'
import { PasswordVault } from '../credentials/vault'
import { CredentialWorkspace } from '../credentials/workspace'
import { passwordEligible } from '../shared/credentials'
import { layoutCommands, layoutCommandForInput } from '../shared/layout-commands'
import { backupCapabilities, backupRequestSchema, type BackupJob } from '../shared/backup'
import { BackupJournal } from '../backup/journal'
import { BackupHistory } from '../backup/history'
import { dataFileSchema, importSourceSchema, transferRequestSchema, type TransferJob } from '../shared/transfer'
import { transferMappingSchema } from '../shared/transfer-mappings'
import { switchDatabaseSchema, gridRequestSchema, connectionSchema, profileSchema, idSchema, runSchema, workspaceSchema, type ConnectionConfig, type Workspace, type SavedConnectionProfile, type DesktopApi, type SessionInfo } from '../shared/contracts'

app.setName('Db Commander')
const profile = applicationProfile(app.getPath('appData'), process.env.SQLCOMMANDER_USER_DATA)
app.setPath('userData', profile.directory)
if (process.platform === 'win32') app.setAppUserModelId('org.dbcommander.desktop')
// Lock the physical profile before loading registries or starting any writers.
// Keep coordination outside the profile so a full profile volume can still
// open its recovery UI. Preserve configured storage/credential paths afterward.
const userData = app.getPath('userData')
mkdirSync(userData, { recursive: true, mode: 0o700 })
const profileKey = createHash('sha256').update(realpathSync.native(userData)).digest('hex')
const instanceDirectory = join(app.getPath('appData'), profile.lockFolder, profileKey)
mkdirSync(instanceDirectory, { recursive: true, mode: 0o700 })
app.setPath('userData', instanceDirectory)
let ownsProfile: boolean
try { ownsProfile = app.requestSingleInstanceLock() }
finally { app.setPath('userData', userData) }
if (!ownsProfile) app.exit(0)
const registry = new WorkspaceWindowsStore(app.getPath('userData'))
const desktopSettings = new DesktopSettings(app.getPath('userData'))
const updates = new UpdateChecker(userData, app.getVersion(), (url, options) => net.fetch(url, options), status => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sql:update-status', status)
  const item = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')
  if (item) { item.enabled = !status.checking; item.label = status.checking ? 'Checking for updates…' : 'Check for updates' }
})
const tray = new SystemTray(
  app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icons/1024x1024.png'),
  app.isPackaged ? join(process.resourcesPath, 'trayTemplate.png') : join(app.getAppPath(), 'build/icons/trayTemplate.png'))
const router = new WindowIpc()
const windows = new Map<string, { focus(): void; stop(): void; recovering(): boolean }>()
const opening = new Map<string, Promise<void>>()
let activeWorkspaceId = 'primary'
// Native menus supply their owning window; OS focus can change while a menu is
// open. Use that identity before consulting current focus.
function menuWindow(target?: { id: number }) { return target ? BrowserWindow.fromId(target.id) : BrowserWindow.getFocusedWindow() }
let registryError: string | undefined
let creation: Promise<unknown> = Promise.resolve()
async function openWorkspaceWindow(id: string): Promise<void> {
  if (registryError && id !== 'primary') throw new Error(registryError)
  const existing = windows.get(id)
  if (existing) { existing.focus(); return }
  if (opening.has(id)) return opening.get(id)
  if (new Set([...windows.keys(), ...opening.keys()]).size >= MAX_OPEN_WINDOWS) throw new Error(`Close a window first. At most ${MAX_OPEN_WINDOWS} windows can be open.`)
  const record = registry.get(id)
  const operation = startWorkspaceWindow(record, registry.directory(id)).finally(() => opening.delete(id))
  opening.set(id, operation); return operation
}
function createWorkspaceWindow(name: string): Promise<void> {
  const operation = creation.catch(() => {}).then(async () => {
    if (registryError) throw new Error(registryError)
    if (new Set([...windows.keys(), ...opening.keys()]).size >= MAX_OPEN_WINDOWS) throw new Error('Close a window before creating another.')
    const record = await registry.create(name); await openWorkspaceWindow(record.id)
  })
  creation = operation; return operation
}
async function startWorkspaceWindow(record: WorkspaceWindow, directory: string): Promise<void> {
const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>()
const vault = new PasswordVault(directory)
const sqlFiles = new SqlFiles(join(directory, 'sql-files.json'))
let fileSequence: Promise<unknown> = Promise.resolve()
function fileOperation<T>(action: () => Promise<T>): Promise<T> {
  const pending = fileSequence.catch(() => {}).then(action); fileSequence = pending; return pending
}
async function saveSqlFile(request: SaveSqlFileRequest, track = true): Promise<import('../shared/sql-files').SqlFileInfo | null> {
  const doc = sqlFiles.document(request.tabId)
  let target: string | undefined
  if (request.saveAs || !doc) {
    const chosen = await dialog.showSaveDialog(window!, { title: 'Save SQL file as', defaultPath: doc?.path ?? 'query.sql', filters: [{ name: 'SQL', extensions: ['sql'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    target = chosen.filePath
  }
  const result = await sqlFiles.save(request.tabId, request.sql, target, undefined, track)
  if ('file' in result) return result.file
  const answer = await dialog.showMessageBox(window!, { type: 'warning', title: 'SQL file changed', message: 'Replace the file on disk?', detail: `${result.conflict.path}\nThe file differs from this tab’s saved version, or Save As selected an existing file. Your editor buffer will replace its contents.`, buttons: ['Cancel', 'Save As…', 'Replace file'], defaultId: 0, cancelId: 0 })
  if (answer.response === 0) return null
  if (answer.response === 1) return saveSqlFile({ ...request, saveAs: true }, track)
  const confirmed = await sqlFiles.save(request.tabId, request.sql, target, result.conflict.revision, track)
  if ('conflict' in confirmed) throw new Error('The SQL file changed again. Review the latest file before replacing it.')
  return confirmed.file
}
let credentialSequence: Promise<unknown> = Promise.resolve()
function credentialOperation<T>(action: () => Promise<T>): Promise<T> {
  const pending = credentialSequence.catch(() => {}).then(action)
  credentialSequence = pending
  return pending
}
const sessionCredentials = new Map<string, ConnectionConfig>()
async function savedProfile(id: string): Promise<{ workspace: Workspace; profile: SavedConnectionProfile }> {
  const workspace: Workspace | null = await rpc('loadWorkspace')
  const profile = workspace?.profiles.find(profile => profile.id === id)
  if (!workspace || !profile) throw new Error('Saved profile no longer exists.')
  return { workspace, profile }
}
async function openSession(config: ConnectionConfig): Promise<SessionInfo> {
  let session: SessionInfo
  try { session = await rpc('connect', config) }
  catch (error) {
    let message = error instanceof Error ? error.message : 'Connection failed.'
    for (const secret of [config.password, config.accessToken, config.sshSecrets?.password, config.sshSecrets?.passphrase]) if (secret) message = message.split(secret).join('[redacted]')
    throw new Error(message)
  }
  const retained = { ...config }
  if (retained.sqliteMode === 'create') retained.sqliteMode = 'read-write'
  if (retained.duckdbMode === 'create') retained.duckdbMode = 'read-write'
  // Follow actual context for cloning, including SQL-driven USE changes.
  retained.database = ['sqlite', 'duckdb'].includes(config.engine) ? config.database : session.database
  sessionCredentials.set(session.id, retained)
  sessions.set(session.id, session); recoveryNotice = undefined
  return session
}
let window: BrowserWindow | null = null
let closing = false
let recovering = false
let recoveryNotice: string | undefined
let checkingClose = false
const saveRequests = new Map<string, (saved: boolean) => void>()
const sessions = new Map<string, SessionInfo>()
const backupJobs = new BackupHistory(new BackupJournal(join(directory, 'backup-jobs.json')), job => window?.webContents.send('sql:backup-job', job))
function publishBackup(job: BackupJob) { backupJobs.publish(job) }
const running = new Map<string, string>()
const transferJobs = new Map<string, TransferJob>()
function publishTransfer(job: TransferJob) {
  transferJobs.set(job.id, job)
  for (const [id, previous] of transferJobs) if (transferJobs.size > 40 && previous.status !== 'running') transferJobs.delete(id)
  if (job.reviewOnly) { window?.webContents.send('sql:transfer-job', job); return }
  for (const id of job.relatedSessionIds ?? [job.sessionId]) {
    if (job.status === 'running') running.set(id, `transfer:${job.id}`)
    else if (running.get(id) === `transfer:${job.id}`) running.delete(id)
  }
  for (const info of job.relatedSessions ?? (job.session ? [job.session] : [])) if (sessions.has(info.id)) sessions.set(info.id, info)
  window?.webContents.send('sql:transfer-job', job)
}
const rendererPath = join(__dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const renderer = rendererOrigin(rendererPath, devUrl)

function assertSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.')
  const url = event.senderFrame?.url
  if (!renderer.accepts(url)) throw new Error('Untrusted application origin.')
}
const host = new DatabaseHostClient(
  () => {
    const created = process.getCreationTime()
    if (process.platform === 'win32' && created === null) throw new Error('Cannot establish the owning Windows application identity.')
    return utilityProcess.fork(join(__dirname, 'database-host.cjs'), [directory, String(process.pid), String(created === null ? 0 : Math.floor(created))], { serviceName: 'Db Commander database host' })
  },
  {
    event(event, token) {
      if (event.type === 'complete' && running.get(event.sessionId) === event.queryId) {
        running.delete(event.sessionId)
        const session = sessions.get(event.sessionId)
        if (session) {
          session.transaction = event.transaction; session.autocommit = event.autocommit; session.mysqlSqlMode = event.mysqlSqlMode
          if (event.database !== undefined) {
            session.database = event.database
            const config = sessionCredentials.get(event.sessionId)
            if (config && !['sqlite', 'duckdb'].includes(config.engine)) config.database = event.database
          }
        }
      }
      if (event.type === 'session-lost') { running.delete(event.sessionId); sessions.delete(event.sessionId); sessionCredentials.delete(event.sessionId) }
      window?.webContents.send('sql:event', event, token)
    },
    backup: publishBackup,
    transfer: publishTransfer,
    exited(startupFailure) {
      for (const job of transferJobs.values()) if (job.status === 'running') publishTransfer({ ...job, status: 'unknown', phase: 'Database host stopped. Reconnect and inspect transaction state and the destination before retrying. Nothing was replayed.' })
      for (const job of backupJobs.values()) if (job.status === 'running') publishBackup({ ...job, status: 'unknown', finishedAt: new Date().toISOString(), phase: 'Database host stopped. The backup or restore outcome is unknown. Inspect the artifact and target before retrying.' })
      sessions.clear(); sessionCredentials.clear(); running.clear()
      if (!closing) window?.webContents.send('sql:event', { type: 'host-lost', message: startupFailure ?? 'Database host stopped. The editor is preserved; reconnect explicitly. In-flight outcomes may be unknown.' })
    }
  }
)
const rpc = host.call.bind(host)
const credentialWorkspace = new CredentialWorkspace(vault, {
  load: () => rpc('loadWorkspace'),
  save: (workspace, removals) => rpc('saveWorkspaceCredentials', { workspace, removals }),
  pendingRemovals: () => rpc('credentialRemovals'),
  completeRemoval: id => rpc('completeCredentialRemoval', id)
})
function registerIpc(): void {
  const handle = <K extends keyof DesktopApi>(method: K, action: (payload: unknown) => Promise<Awaited<ReturnType<DesktopApi[K]>>>) => {
    router.register(method); handlers.set(method, async (event, payload) => { assertSender(event); return action(payload) })
  }
  handle('applicationMenu', async value => { z.undefined().parse(value); return applicationMenu() })
  handle('preferences', async () => desktopSettings.preferences ?? null)
  handle('savePreferences', async value => {
    await desktopSettings.setPreferences(editorSettingsSchema.parse(value))
    for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('sql:preferences-changed', desktopSettings.preferences)
  })
  handle('executeApplicationMenu', async value => executeApplicationMenu(window!, menuPathSchema.parse(value)))
  handle('updateTitleBar', async value => updateTitleBar(window!, titleBarAppearanceSchema.parse(value)))
  handle('updateStatus', async value => { z.undefined().parse(value); return updates.status })
  handle('checkForUpdates', async value => { z.undefined().parse(value); return updates.check(true) })
  handle('dismissUpdate', async value => updates.dismiss(z.string().max(96).optional().parse(value)))
  handle('openUpdatePage', async value => { z.undefined().parse(value); await shell.openExternal(updates.releasePage()) })
  handle('workspaceWindows', async () => { if (registryError) throw new Error(registryError); return { currentId: record.id, windows: registry.list().map(item => ({ ...item, open: windows.has(item.id) })) } })
  handle('createWorkspaceWindow', async value => createWorkspaceWindow(workspaceWindowNameSchema.parse(value)))
  handle('openWorkspaceWindow', async value => { await openWorkspaceWindow(workspaceWindowIdSchema.parse(value)); return undefined })
  handle('cancelExplain', async value => rpc('cancelExplain', idSchema.parse(value)))
  handle('explain', async value => {
    const request = explainRequestSchema.parse(value)
    if (running.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    running.set(request.sessionId, 'explain')
    try {
      const result = await rpc('explain', request)
      if (sessions.has(request.sessionId)) sessions.set(request.sessionId, result.session)
      return result
    } finally { running.delete(request.sessionId) }
  })
  handle('savePlan', async value => {
    const request = z.object({ text: z.string().max(PLAN_LIMIT), format: z.enum(['json','xml','text','table']) }).strict().parse(value)
    const extension = request.format === 'table' ? 'tsv' : request.format === 'text' ? 'txt' : request.format
    const result = await dialog.showSaveDialog(window!, { title: 'Save query plan', defaultPath: `query-plan.${extension}`, filters: [{ name: 'Query plan', extensions: [extension] }] })
    if (result.canceled || !result.filePath) return null
    await writeGeneratedFile(result.filePath, request.text, { replace: true }); return result.filePath
  })
  handle('saveValue', async value => {
    const request=z.object({text:z.string().max(1_000_000),format:z.enum(['json','xml','text'])}).strict().parse(value)
    const extension=request.format==='text'?'txt':request.format
    const result=await dialog.showSaveDialog(window!,{title:'Save displayed value',defaultPath:`value.${extension}`,filters:[{name:'Displayed value',extensions:[extension]}]})
    if(result.canceled||!result.filePath)return null
    await writeGeneratedFile(result.filePath,request.text,{replace:true});return result.filePath
  })
  handle('sessionSafety', async value => rpc('sessionSafety', idSchema.parse(value)))
  handle('lockSession', async value => rpc('lockSession', idSchema.parse(value)))
  handle('unlockSession', async value => rpc('unlockSession', z.object({ sessionId: idSchema, confirmation: z.string().max(100) }).strict().parse(value)))
  handle('chooseSshKey', async () => { const result = await dialog.showOpenDialog(window!, { title: 'Choose SSH private key', properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0] ?? null })
  handle('prepareSchemaChange', async value => rpc('prepareSchemaChange', prepareSchemaChangeSchema.parse(value)))
  handle('prepareActivityAction', async value => rpc('prepareActivityAction',prepareActivityActionSchema.parse(value)))
  handle('applyActivityAction', async value => rpc('applyActivityAction',applyActivityActionSchema.parse(value)))
  handle('inspectRollback', async value => rpc('inspectRollback',rollbackRequestSchema.parse(value)))
  handle('inspectActivity', async value => rpc('inspectActivity',activityRequestSchema.parse(value)))
  handle('saveActivity', async value => {
    const snapshot=activitySnapshotSchema.parse(value)
    const result=await dialog.showSaveDialog(window!,{title:'Save session and lock report',defaultPath:'dbcommander-activity.json',filters:[{name:'JSON report',extensions:['json']}]})
    if(result.canceled||!result.filePath)return null
    await writeGeneratedFile(result.filePath,JSON.stringify(snapshot,null,2)+'\n');return result.filePath
  })
  handle('prepareQueryBuilder', async value => rpc('prepareQueryBuilder', prepareBuilderSchema.parse(value)))
  handle('prepareMigration', async value => rpc('prepareMigration', prepareMigrationSchema.parse(value)))
  handle('saveMigration', async value => {
    const request = saveMigrationSchema.parse(value)
    const preview: MigrationPreview = await rpc('reviewedMigration', request)
    const result = await dialog.showSaveDialog(window!, { title: 'Export reviewed migration to a new file', defaultPath: preview.filename, filters: [{ name: 'SQL migration', extensions: ['sql'] }] })
    if (result.canceled || !result.filePath) return null
    // The native chooser can remain open past expiry or disconnect. Validate again before writing.
    const current: MigrationPreview = await rpc('reviewedMigration', request)
    await writeMigrationFile(result.filePath, current.sql)
    return result.filePath
  })
  handle('cancelSchemaChange', async value => rpc('cancelSchemaChange', idSchema.parse(value)))
  handle('applySchemaChange', async value => {
    const request = applySchemaChangeSchema.parse(value)
    if (running.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    running.set(request.sessionId, `schema:${request.planId}`)
    try {
      const result = await rpc('applySchemaChange', request)
      if (sessions.has(request.sessionId)) sessions.set(request.sessionId, result.session)
      return result
    } finally { running.delete(request.sessionId) }
  })
  handle('copyDefinition', async value => { await clipboard.writeText(z.string().max(1_000_000).parse(value)) })
  handle('compareData', async value => rpc('compareData', dataCompareSchema.parse(value)))
  handle('compareSchemas', async value => rpc('compareSchemas',compareSchemaSchema.parse(value)))
  handle('diagram', async value => rpc('diagram',diagramRequestSchema.parse(value)))
  handle('saveDiagram', async value => {
    const svg=diagramSvg(diagramExportSchema.parse(value))
    const result=await dialog.showSaveDialog(window!,{title:'Save ER diagram',defaultPath:'er-diagram.svg',filters:[{name:'SVG diagram',extensions:['svg']}]})
    if(result.canceled||!result.filePath)return null
    await writeGeneratedFile(result.filePath,svg,{replace:true});return result.filePath
  })
  handle('inspectObject', async value => rpc('inspectObject', inspectObjectSchema.parse(value)))
  handle('inspectImport', async value => {
    const request = importSourceSchema.parse(value)
    if (running.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    running.set(request.sessionId, 'inspect-import')
    try { return await rpc('inspectImport', request) } finally { running.delete(request.sessionId) }
  })
  handle('inspectDataFile', async value => rpc('inspectDataFile', dataFileSchema.parse(value)))
  handle('transferMappings', async () => rpc('transferMappings'))
  handle('saveTransferMapping', async value => rpc('saveTransferMapping', transferMappingSchema.parse(value)))
  handle('removeTransferMapping', async value => rpc('removeTransferMapping', idSchema.parse(value)))
  handle('discardTransferCapture', async value => rpc('discardTransferCapture', idSchema.parse(value)))
  handle('startTransfer', async value => {
    const request = transferRequestSchema.parse(value)
    const ids = request.action === 'capture' ? [request.sessionId, request.targetSessionId] : [request.sessionId]
    if (ids.some(id => running.has(id))) throw new Error('A transfer connection already has a running operation.')
    for (const id of ids) running.set(id, 'start-transfer')
    try { return await rpc('startTransfer', request) }
    catch (error) { for (const id of ids) if (running.get(id) === 'start-transfer') running.delete(id); throw error }
  })
  handle('transferJobs', async () => [...transferJobs.values()])
  handle('cancelTransfer', async value => rpc('cancelTransfer', idSchema.parse(value)))
  handle('chooseTransferFile', async value => {
    const request = z.object({ save: z.boolean(), format: z.enum(['csv', 'tsv', 'json', 'jsonl', 'sql']) }).strict().parse(value)
    if (!request.save && request.format === 'sql') throw new Error('Open SQL scripts through the File menu; data import accepts CSV, TSV or JSON.')
    const filters = [{ name: request.format.toUpperCase(), extensions: [request.format] }]
    if (request.save) { const result = await dialog.showSaveDialog(window!, { title: 'Export full result to a new file', defaultPath: `result.${request.format}`, filters }); return result.canceled ? null : result.filePath ?? null }
    const result = await dialog.showOpenDialog(window!, { title: 'Import UTF-8 data file', properties: ['openFile'], filters })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('startBackup', async value => rpc('startBackup', backupRequestSchema.parse(value)))
  handle('backupJobs', async () => backupJobs.list())
  handle('retryBackupHistory', async () => backupJobs.retry())
  handle('cancelBackup', async value => rpc('cancelBackup', idSchema.parse(value)))
  handle('chooseBackupFile', async value => {
    const request = z.object({ sessionId: idSchema, save: z.boolean() }).strict().parse(value)
    const session = sessions.get(request.sessionId)
    if (!session) throw new Error('Connect a database first.')
    const capability = backupCapabilities[session.engine]
    if (capability.location !== 'local') throw new Error('This engine uses server-side backup locations.')
    const filters = [{ name: capability.format, extensions: [capability.extension] }]
    if (request.save) { const result = await dialog.showSaveDialog(window!, { title: 'Choose a new backup or restore file', defaultPath: `database.${capability.extension}`, filters }); return result.canceled ? null : result.filePath ?? null }
    const result = await dialog.showOpenDialog(window!, { title: 'Open backup file', properties: ['openFile'], filters })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('connect', async value => openSession(connectionSchema.parse(value)))
  handle('cloneSession', async value => {
    const id = idSchema.parse(value), config = sessionCredentials.get(id)
    if (!config || !sessions.has(id)) throw new Error('Source session is no longer connected.')
    return openSession({ ...config })
  })
  handle('exportConnectionProfiles', value => fileOperation(async () => {
    const ids = z.array(idSchema).min(1).max(100).optional().parse(value)
    const workspace: Workspace | null = await rpc('loadWorkspace')
    const profiles = (workspace?.profiles ?? []).filter(profile => !ids || ids.includes(profile.id))
    if (ids && profiles.length !== new Set(ids).size) throw new Error('A selected profile no longer exists. Choose it again.')
    const document = profileDocument(profiles)
    const chosen = await dialog.showSaveDialog(window!, { title: 'Export connections without credentials to a new file', defaultPath: 'dbcommander-connections.json', filters: [{ name: 'Db Commander connections', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    await writeProfileFile(chosen.filePath, document)
    return chosen.filePath
  }))
  handle('importConnectionProfiles', () => fileOperation(async () => {
    const chosen = await dialog.showOpenDialog(window!, { title: 'Import Db Commander connections', properties: ['openFile'], filters: [{ name: 'Db Commander connections', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return { sourceName: basename(chosen.filePaths[0]), document: await readProfileFile(chosen.filePaths[0]) }
  }))
  handle('connectSavedPassword', async value => {
    const request = z.object({ profileId: idSchema, config: profileSchema, sshSecrets: sshSecretsSchema.optional() }).strict().parse(value)
    const config = await credentialOperation(async () => {
      const { profile } = await savedProfile(request.profileId)
      return { ...request.config, sshSecrets: request.sshSecrets, password: await vault.resolve(profile, request.config) }
    })
    return openSession(config)
  })
  handle('passwordStatus', async value => credentialOperation(async () => {
    const id = idSchema.optional().parse(value)
    const workspace: Workspace | null = id ? await rpc('loadWorkspace') : null
    return vault.status(workspace?.profiles.find(profile => profile.id === id))
  }))
  handle('saveProfilePassword', async value => {
    // Never let validation diagnostics echo submitted secret values.
    const parsed = z.object({ profileId: idSchema, password: z.string().min(1).max(4096) }).strict().safeParse(value)
    if (!parsed.success) throw new Error('Invalid saved password request.')
    return credentialOperation(async () => {
      // Never replace an entry while an earlier deletion of its ID is pending.
      await credentialWorkspace.cleanup()
      const { workspace, profile } = await savedProfile(parsed.data.profileId)
      if (!passwordEligible(profile.config)) throw new Error('This profile does not support saved passwords. Access tokens remain session-only.')
      // Persist the reference before writing the vault so interruption cannot
      // leave an untracked credential. A failed/partial write can be retried or removed.
      profile.credential = 'os-store'
      await rpc('saveWorkspace', workspace)
      await vault.save(profile, parsed.data.password)
    })
  })
  handle('removeProfilePassword', async value => credentialOperation(() => credentialWorkspace.removePassword(idSchema.parse(value))))
  handle('disconnect', async value => { const id = idSchema.parse(value); await rpc('disconnect', id); sessions.delete(id); sessionCredentials.delete(id) })
  handle('switchDatabase', async value => {
    const request = switchDatabaseSchema.parse(value)
    if (running.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    running.set(request.sessionId, `switch:${randomUUID()}`)
    try {
      const session: SessionInfo = await rpc('switchDatabase', request)
      const config = sessionCredentials.get(request.sessionId)
      if (config) sessionCredentials.set(session.id, { ...config, database: session.database })
      if (!request.retainSource && session.id !== request.sessionId) { sessionCredentials.delete(request.sessionId); sessions.delete(request.sessionId) }
      sessions.set(session.id, session)
      return session
    } finally { running.delete(request.sessionId) }
  })
  handle('editGrid', async value => {
    const request = gridRequestSchema.parse(value)
    if (running.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    running.set(request.sessionId, `grid:${randomUUID()}`)
    try {
      const response = await rpc('editGrid', request)
      if (sessions.has(request.sessionId)) sessions.set(request.sessionId, response.session)
      return response
    } finally { running.delete(request.sessionId) }
  })
  handle('run', async value => { const parsed = runSchema.parse(value); const request = { ...parsed, queryId: parsed.queryId ?? randomUUID() }; if (running.has(request.sessionId)) throw new Error('This tab already has a running query.'); running.set(request.sessionId, request.queryId); try { return await rpc('run', request) } catch (error) { running.delete(request.sessionId); throw error } })
  for (const method of ['cancel', 'tables', 'schema', 'databases'] as const) handle(method, async value => rpc(method, idSchema.parse(value)))
  handle('loadWorkspace', async () => credentialOperation(async () => {
    let credentialNotice = ''
    try { await credentialWorkspace.cleanup() } catch (error) { credentialNotice = (error as Error).message }
    const workspace = await rpc('loadWorkspaceRecovery')
    return workspace ? { ...workspace, recoveryNotice: [recoveryNotice, workspace.recoveryNotice, credentialNotice].filter(Boolean).join(' ') || undefined } : null
  }))
  handle('history',async()=>rpc('history'))
  handle('clearHistory',async value=>rpc('clearHistory',z.boolean().optional().parse(value)))
  handle('searchHistory',async value=>rpc('searchHistory',historySearchSchema.parse(value)))
  handle('historySettings',async()=>rpc('historySettings'))
  handle('saveHistorySettings',async value=>rpc('saveHistorySettings',historySettingsSchema.parse(value)))
  handle('favoriteHistory',async value=>rpc('favoriteHistory',z.object({id:idSchema,favorite:z.boolean()}).strict().parse(value)))
  handle('deleteHistory',async value=>rpc('deleteHistory',idSchema.parse(value)))
  handle('snippets',async value=>rpc('snippets',snippetSearchSchema.parse(value??{})))
  handle('saveSnippet',async value=>rpc('saveSnippet',snippetSchema.parse(value)))
  handle('deleteSnippet',async value=>rpc('deleteSnippet',idSchema.parse(value)))
  handle('exportSnippets', value => fileOperation(async () => {
    const document: SnippetDocument = await rpc('exportSnippets', snippetExportSchema.parse(value))
    const chosen = await dialog.showSaveDialog(window!, { title: 'Export saved snippets to a new file', defaultPath: 'dbcommander-snippets.json', filters: [{ name: 'Db Commander snippets', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    await writeSnippetFile(chosen.filePath, document); return chosen.filePath
  }))
  handle('reviewSnippetImport', () => fileOperation(async () => {
    const chosen = await dialog.showOpenDialog(window!, { title: 'Import Db Commander snippets', properties: ['openFile'], filters: [{ name: 'Db Commander snippets', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const preview: SnippetImportPreview = await rpc('reviewSnippetImport', await readSnippetFile(chosen.filePaths[0]))
    return { ...preview, sourceName: basename(chosen.filePaths[0]) }
  }))
  handle('applySnippetImport', value => rpc('applySnippetImport', snippetImportSchema.parse(value)))
  handle('discardSnippetImport', value => rpc('discardSnippetImport', idSchema.parse(value)))
  handle('exportEditorSettings', value => fileOperation(async () => {
    const settings = editorSettingsSchema.parse(value)
    const chosen = await dialog.showSaveDialog(window!, { title: 'Export editor settings to a new file', defaultPath: 'dbcommander-editor-settings.json', filters: [{ name: 'Db Commander editor settings', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    await writeEditorSettingsFile(chosen.filePath, { format: 'dbcommander-editor-settings', version: 1, settings })
    return chosen.filePath
  }))
  handle('importEditorSettings', () => fileOperation(async () => {
    const chosen = await dialog.showOpenDialog(window!, { title: 'Import Db Commander editor settings', properties: ['openFile'], filters: [{ name: 'Db Commander editor settings', extensions: ['json'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const document = await readEditorSettingsFile(chosen.filePaths[0])
    return { sourceName: basename(chosen.filePaths[0]), settings: document.settings }
  }))
  handle('saveWorkspace', async value => {
    const workspace = workspaceSchema.parse(value)
    return credentialOperation(() => credentialWorkspace.save(workspace))
  })
  handle('exportCsv', async value => {
    const input = z.object({ queryId: idSchema, index: z.number().int().min(0).max(199) }).strict().parse(value)
    const result = await dialog.showSaveDialog(window!, { title: 'Export fetched rows to a new CSV file', defaultPath: 'results.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (result.canceled || !result.filePath) return null
    await rpc('exportCsv', { ...input, path: result.filePath }); return result.filePath
  })
  handle('saveSqlFile', value => fileOperation(() => saveSqlFile(saveSqlFileSchema.parse(value))))
  handle('saveSql', value => fileOperation(async () => (await saveSqlFile({ tabId: randomUUID(), sql: z.string().max(1_000_000).parse(value), saveAs: true }, false))?.path ?? null))
  handle('restoreSqlFiles', () => fileOperation(async () => sqlFiles.restore((await rpc('loadWorkspace'))?.tabs.map(tab => tab.id) ?? [])))
  handle('checkSqlFiles', () => fileOperation(() => sqlFiles.check()))
  handle('forgetSqlFile', value => fileOperation(() => sqlFiles.forget(idSchema.parse(value))))
  handle('clearRecentSqlFiles', () => fileOperation(() => sqlFiles.clearRecent()))
  handle('reloadSqlFile', value => fileOperation(async () => {
    const request = reloadSqlFileSchema.parse(value)
    if (sqlFiles.dirty(request.tabId, request.sql)) {
      const answer = await dialog.showMessageBox(window!, { type: 'warning', title: 'Reload SQL file', message: 'Discard this tab’s edits and reload the file?', buttons: ['Keep edits', 'Reload file'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return null
    }
    return sqlFiles.prepareReload(request.tabId)
  }))
  handle('finishSqlFileReload', value => fileOperation(async () => {
    const request = finishSqlFileReloadSchema.parse(value)
    const workspace: Workspace | null = request.accept ? await rpc('loadWorkspace') : null
    return sqlFiles.finishReload(request.reloadId, request.accept, workspace?.tabs)
  }))
  for (const engine of ['Sqlite', 'Duckdb'] as const) handle(`choose${engine}File`, async value => {
    const create = z.boolean().parse(value)
    const name = engine === 'Sqlite' ? 'SQLite' : 'DuckDB'
    const filters = [{ name: `${name} databases`, extensions: engine === 'Sqlite' ? ['sqlite', 'sqlite3', 'db'] : ['duckdb', 'ddb', 'db'] }, { name: 'All files', extensions: ['*'] }]
    if (create) {
      const result = await dialog.showSaveDialog(window!, { title: `Create a new ${name} database`, defaultPath: engine === 'Sqlite' ? 'database.sqlite' : 'database.duckdb', filters })
      return result.canceled ? null : result.filePath ?? null
    }
    const result = await dialog.showOpenDialog(window!, { title: `Open ${name} database`, properties: ['openFile'], filters })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('openSql', value => fileOperation(async () => {
    const request = openSqlFileSchema.parse(value)
    let path: string
    if (request.recentId) path = sqlFiles.recentPath(request.recentId)
    else {
      const chosen = await dialog.showOpenDialog(window!, { title: 'Open SQL file', properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] })
      if (chosen.canceled || !chosen.filePaths[0]) return null
      path = chosen.filePaths[0]
    }
    return sqlFiles.open(request.tabId, path)
  }))
  ipcMain.on('sql:ack', acknowledge)
  ipcMain.on('sql:workspace-flushed', flushed)
}
const acknowledge = (event: IpcMainEvent, token: unknown) => { try { assertSender(event) } catch { return }; if (typeof token === 'string') host.acknowledge(token) }
const flushed = (event: IpcMainEvent, token: unknown, saved: unknown) => { try { assertSender(event) } catch { return }; if (typeof token === 'string') saveRequests.get(token)?.(saved === true) }
async function saveBeforeQuit(): Promise<boolean> {
  return new Promise(resolve => {
    const token = randomUUID()
    const finish = (saved: boolean) => { clearTimeout(timer); saveRequests.delete(token); resolve(saved) }
    const timer = setTimeout(() => finish(false), 5000)
    saveRequests.set(token, finish); window?.webContents.send('sql:save-request', token)
  })
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1024, minHeight: 700, title: `Db Commander — ${record.name}`, backgroundColor: '#121314',
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icons/1024x1024.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    ...(process.platform === 'win32' ? windowsTitleBar : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  const createdWindow = window, contentsId = createdWindow.webContents.id
  installMenuKeys(window)
  if (process.platform === 'win32') window.setMenuBarVisibility(false)
  tray.attach(window, record.name)
  router.attach(contentsId, handlers)
  window.on('page-title-updated', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => {
    if ((process.platform === 'darwin' ? input.meta : input.control) && !input.alt && ['o', 's'].includes(input.key.toLowerCase())) {
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) window?.webContents.send('sql:file-command', input.key.toLowerCase() === 'o' ? 'open' : input.shift ? 'save-as' : 'save')
      return
    }
    const command = layoutCommandForInput(input, process.platform)
    if (!command) return
    // Prevent both editor bindings and the native menu accelerator from also
    // handling this keystroke, so a focused Monaco editor toggles exactly once.
    event.preventDefault()
    if (input.type === 'keyDown' && !input.isAutoRepeat) window?.webContents.send('sql:layout-command', command)
  })
  window.webContents.on('render-process-gone', () => {
    if (closing || recovering || window !== createdWindow) return
    recovering = true
    recoveryNotice = 'Your editor was recovered after a renderer crash. Database connections were ended; any in-flight operation may have an unknown outcome. Reconnect explicitly. No SQL was replayed.'
    // The lost renderer owned these sessions. End them and recover only saved
    // editor state; never reconnect or replay SQL after a crash.
    const stopped = host.stop()
    // Detach before destruction: native close notifications can arrive later
    // than the host exit, or even after the replacement has been created.
    window = null
    createdWindow.destroy()
    void stopped.then(createWindow).finally(() => { recovering = false })
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  window.on('focus', () => { activeWorkspaceId = record.id })
  window.on('close', event => {
    if (closing) return
    event.preventDefault()
    if (checkingClose) return
    checkingClose = true
    // Native close/quit prompts must remain reachable for tray-hidden workspaces.
    if (!window!.isVisible() || window!.isMinimized()) tray.restore(window!)
    void (async () => {
      try {
        if ([...backupJobs.values()].some(job => job.status === 'running')) {
          const result = await dialog.showMessageBox(window!, { type: 'warning', title: 'Backup or restore is running', message: 'A database backup or restore has not finished.', detail: 'Closing this window interrupts its local work. Server-side jobs may continue and restore targets may contain partial changes. Keep working to monitor or cancel the job.', buttons: ['Keep working', 'Close with unknown outcome'], defaultId: 0, cancelId: 0 })
          if (result.response !== 1) return
        }
        if ([...sessions.values()].some(session => session.transaction !== 'idle') || running.size) {
          const result = await dialog.showMessageBox(window!, { type: 'warning', title: 'Close database sessions?', message: 'Queries or transactions are still open in one or more tabs.', detail: 'Closing ends this window’s tab connections. Other windows stay open. Uncommitted transactional changes are normally rolled back. DDL and nontransactional changes may already be committed; in-flight outcomes may be unknown.', buttons: ['Keep working', 'Close connections and window'], defaultId: 0, cancelId: 0 })
          if (result.response !== 1) return
        }
        await credentialSequence.catch(() => {})
        await backupJobs.flush().catch(() => {})
        if (!await saveBeforeQuit()) {
          const result = await dialog.showMessageBox(window!, { type: 'warning', title: 'Workspace not saved', message: 'The workspace has unsaved changes or staged table edits.', detail: 'The latest workspace changes could not be confirmed on disk. Keep working to retry saving or copy your SQL to a file. Staged table edits are kept only in memory; apply or discard them before closing. Closing without saving can lose these changes.', buttons: ['Keep working', 'Close without saving'], defaultId: 0, cancelId: 0 })
          if (result.response !== 1) return
          // A failed flush cannot supply authoritative editor text for Save all.
          // This explicit discard choice must never write an older buffer to disk.
          closing = true; window?.close(); return
        }
        await fileSequence.catch(() => {})
        const workspace: Workspace | null = await rpc('loadWorkspace')
        const dirtyFiles = workspace?.tabs.filter(tab => sqlFiles.document(tab.id) && sqlFiles.dirty(tab.id, tab.sql)) ?? []
        if (dirtyFiles.length) {
          const answer = await dialog.showMessageBox(window!, { type: 'warning', title: 'Unsaved SQL files', message: `${dirtyFiles.length} SQL file(s) have unsaved edits.`, detail: 'Close and keep buffers retains your edits in workspace recovery without changing the files on disk.', buttons: ['Keep working', 'Close and keep buffers', 'Save files and close'], defaultId: 0, cancelId: 0 })
          if (answer.response === 0) return
          if (answer.response === 2) {
            try { for (const tab of dirtyFiles) if (!await fileOperation(() => saveSqlFile({ tabId: tab.id, sql: tab.sql }))) return }
            catch (error) { await dialog.showMessageBox(window!, { type: 'error', message: 'SQL files were not all saved. The application will stay open.', detail: (error as Error).message }); return }
          }
          if (!await saveBeforeQuit()) return
          if (answer.response === 2) {
            const latest: Workspace | null = await rpc('loadWorkspace')
            if (latest?.tabs.some(tab => sqlFiles.document(tab.id) && sqlFiles.dirty(tab.id, tab.sql))) {
              await dialog.showMessageBox(window!, { type: 'warning', message: 'SQL changed while saving. Review the remaining edits before closing this window.' })
              return
            }
          }
        }
        closing = true; window?.close()
      } catch (error) {
        await dialog.showMessageBox(window!, { type: 'error', message: 'Unable to finish saving. The application will stay open.', detail: (error as Error).message })
      } finally { checkingClose = false }
    })()
  })
  window.on('closed', () => {
    router.detach(contentsId)
    if (window !== createdWindow) return
    window = null
    if (!recovering) {
      closing = true; host.kill(); windows.delete(record.id)
      ipcMain.removeListener('sql:ack', acknowledge); ipcMain.removeListener('sql:workspace-flushed', flushed)
    }
  })
  await window.loadURL(devUrl || renderer.url)
}
  await backupJobs.load()
  await sqlFiles.load()
  registerIpc()
  const controller = { focus: () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() }, stop: () => { closing = true; host.kill() }, recovering: () => recovering }
  windows.set(record.id, controller)
  try { await createWindow() } catch (error) { closing = true; const failed = window as BrowserWindow | null; failed?.destroy(); windows.delete(record.id); throw error }
}
const startup = app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icons/1024x1024.png'))
  try { await registry.load() } catch (error) { registryError = (error as Error).message }
  try { await desktopSettings.load(); tray.setEnabled(desktopSettings.minimizeToTray) }
  catch (error) { console.error('Unable to enable minimize to system tray:', error) }
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'Workspace windows…', click: (_item, target) => menuWindow(target)?.webContents.send('sql:windows-command') },
      { label: 'Open SQL file…', accelerator: 'CmdOrCtrl+O', click: (_item, target) => menuWindow(target)?.webContents.send('sql:file-command', 'open') },
      { label: 'Recent SQL files…', click: (_item, target) => menuWindow(target)?.webContents.send('sql:file-command', 'recent') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (_item, target) => menuWindow(target)?.webContents.send('sql:file-command', 'save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: (_item, target) => menuWindow(target)?.webContents.send('sql:file-command', 'save-as') },
      { label: 'Reload from disk', click: (_item, target) => menuWindow(target)?.webContents.send('sql:file-command', 'reload') }
    ] },
    { role: 'editMenu' }, { label: 'View', submenu: [
      ...layoutCommands.map(command => ({ id: command.id, label: command.label, accelerator: command.accelerator,
        click: (_item: Electron.MenuItem, target: Electron.BaseWindow | undefined) => menuWindow(target)?.webContents.send('sql:layout-command', command.id) })),
      { type: 'separator' as const }, { role: 'reload' as const }, { role: 'forceReload' as const }, { role: 'toggleDevTools' as const },
      { type: 'separator' as const }, { role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const },
      { type: 'separator' as const }, { role: 'togglefullscreen' as const }
    ] }, { id: 'workspace-window-menu', role: 'windowMenu' },
    { role: 'help', submenu: [
      { id: 'check-for-updates', label: 'Check for updates', click: () => { tray.restoreActive(); void updates.check(true) } },
      { type: 'separator' },
      { id: 'about-db-commander', label: 'About Db Commander', click: (_item, target) => menuWindow(target)?.webContents.send('sql:about', app.getVersion()) }
    ] }
  ])
  const windowMenu = menu.getMenuItemById('workspace-window-menu')!.submenu!
  windowMenu.append(new MenuItem({ type: 'separator' }))
  windowMenu.append(new MenuItem({ id: 'minimize-to-tray', label: 'Minimize to system tray', type: 'checkbox', checked: tray.enabled,
    click: async item => {
      const enabled = item.checked, previous = tray.enabled
      item.checked = previous; item.enabled = false
      try {
        if (enabled) tray.setEnabled(true)
        await desktopSettings.setMinimizeToTray(enabled)
        tray.setEnabled(enabled); item.checked = enabled
      } catch (error) {
        tray.setEnabled(previous)
        await dialog.showMessageBox({ type: 'error', message: 'The system tray setting was not changed.', detail: (error as Error).message })
      } finally { item.enabled = true }
    } }))
  Menu.setApplicationMenu(menu)
  await openWorkspaceWindow('primary')
  updates.start()
  powerMonitor.on('resume', () => { void updates.checkIfDue() })
  app.on('activate', () => { if (!windows.size) void openWorkspaceWindow('primary'); else tray.restoreActive() })
})
app.on('second-instance', () => {
  // Wait for registry loading and initial window creation on simultaneous starts.
  // Launch arguments never reconnect a profile or execute recovered SQL.
  void startup.then(() => openWorkspaceWindow(windows.has(activeWorkspaceId) ? activeWorkspaceId : windows.keys().next().value ?? 'primary'))
    .catch(error => console.error('Unable to activate the workspace window:', error))
})
app.on('window-all-closed', () => { if (![...windows.values()].some(window => window.recovering())) app.quit() })
app.on('will-quit', () => { updates.stop(); tray.destroy(); for (const window of windows.values()) window.stop() })
