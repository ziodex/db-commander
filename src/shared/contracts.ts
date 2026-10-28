import { MAX_SQL_CHARACTERS, MAX_WORKSPACE_SQL_CHARACTERS } from './workspace-limits'
import { z } from 'zod'
import { parametersSchema } from './parameters'
import { layoutSchema, type LayoutCommand } from './layout'
import { editorSettingsSchema } from './editor-settings'
import { editorViewsSchema } from './editor-views'
import { tableLayoutsSchema } from './table-layouts'
import type { PasswordStatus } from './credentials'
import { profileOptions, sshSecretsSchema, type ConnectionSafety } from './connection-options'
import { engineSchema, type DatabaseEngine } from './database-engines'
export { engineSchema, engineNames, type DatabaseEngine } from './database-engines'

const connectionFields = z.object({
  ...profileOptions,
  sshSecrets: sshSecretsSchema.optional(),
  engine: engineSchema.default('postgres'),
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().max(255).default(''),
  user: z.string().max(255),
  password: z.string().max(4096),
  authentication: z.enum(['sql-password', 'entra-token', 'windows']).optional(),
  accessToken: z.string().max(65536).optional(),
  tls: z.enum(['verify-full', 'disable']),
  ca: z.string().max(65536).optional(),
  filePath: z.string().max(4096).optional(),
  sqliteMode: z.enum(['read-write', 'read-only', 'create', 'memory']).optional(),
  duckdbMode: z.enum(['read-write', 'read-only', 'create', 'memory']).optional()
}).strict()
const hasEndpoint = (config: { engine: DatabaseEngine; database: string; ssh?: unknown }) => (config.engine !== 'oracle' || Boolean(config.database.trim())) && !(config.ssh && ['sqlite', 'duckdb'].includes(config.engine))
const hasAuthentication = (config: { engine: DatabaseEngine; authentication?: string; user: string }) => config.authentication === 'windows'
  ? config.engine === 'sqlserver'
  : Boolean(config.user.length) && (config.authentication !== 'entra-token' || config.engine === 'azure-sql')
export const connectionSchema = connectionFields.refine(hasEndpoint, { message: 'Oracle requires a service name.', path: ['database'] })
  .refine(hasAuthentication, { message: 'Enter a user. Windows authentication is available only for SQL Server; Entra tokens only for Azure SQL.', path: ['authentication'] })
export type ConnectionConfig = z.infer<typeof connectionSchema>
export type ConnectionProfile = Omit<ConnectionConfig, 'password' | 'accessToken' | 'sshSecrets'>
export const profileSchema = connectionFields.omit({ password: true, accessToken: true, sshSecrets: true }).refine(hasEndpoint, { message: 'Oracle requires a service name. Embedded databases cannot use SSH.' })
  .refine(hasAuthentication, { message: 'Enter a user and choose an authentication method supported by this database.' })
export const DEFAULT_PROFILE: ConnectionProfile = { engine: 'postgres', name: 'Local PostgreSQL', host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', tls: 'verify-full', ca: '' }
export const MAX_TABS = 20
export const MAX_PROFILES = 100
export const idSchema = z.string().uuid()
export const switchDatabaseSchema = z.object({ sessionId: idSchema, database: z.string().min(1).max(255), retainSource: z.boolean().optional() }).strict()
export type SwitchDatabaseRequest = z.infer<typeof switchDatabaseSchema>
export interface DatabaseCatalog { databases: string[]; current: string; switchable: boolean; notice?: string }
const savedProfileSchema = z.object({ id: idSchema, config: profileSchema, credential: z.literal('os-store').optional() }).strict()
export type SavedConnectionProfile = z.infer<typeof savedProfileSchema>
const workspaceTabSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(255), sql: z.string().max(MAX_SQL_CHARACTERS), profile: profileSchema, profileId: idSchema.optional(), pinned: z.boolean().optional() }).strict()
export type WorkspaceTab = z.infer<typeof workspaceTabSchema>
export type TransactionState = 'idle' | 'transaction' | 'failed' | 'unknown'
export interface SessionInfo { id: string; engine: DatabaseEngine; name: string; database: string; user: string; host: string; port: number; tls: boolean; transaction: TransactionState; autocommit?: boolean; version: string; mysqlSqlMode?: { noBackslashEscapes: boolean; ansiQuotes: boolean }; safety?: ConnectionSafety }
export interface Column { name: string; typeId: number; typeName?: string }
export type Cell = string | null
export interface ResultSet { index: number; statement: string; columns: Column[]; rows: Cell[][]; rowCount: number | null; command: string; truncated: boolean }
type QueryStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type DatabaseEvent =
  | { type: 'result'; sessionId: string; queryId: string; result: Omit<ResultSet, 'rows'> }
  | { type: 'rows'; sessionId: string; queryId: string; index: number; rows: Cell[][] }
  | { type: 'notice'; sessionId: string; queryId: string; message: string }
  | { type: 'complete'; sessionId: string; queryId: string; status: Exclude<QueryStatus, 'running'>; durationMs: number; error?: string; code?: string; failure?: import('./execution').FailureSource; transaction: TransactionState; autocommit?: boolean; database?: string; mysqlSqlMode?: SessionInfo['mysqlSqlMode'] }
  | { type: 'session-lost'; sessionId: string; message: string }
  | { type: 'host-lost'; message: string }
export interface SchemaTable { catalog?: string; schema: string; name: string; kind: string }
interface SchemaColumn { name: string; type: string; nullable: boolean; ordinal: number }
export interface SchemaObject extends SchemaTable { columns: SchemaColumn[] }
export interface SchemaSnapshot { catalog?: import('./catalog').CatalogSnapshot; objects: SchemaObject[]; database: string; source: 'catalog-connection' | 'session'; fetchedAt: string; truncated: boolean }
export interface HistoryEntry { engine?: DatabaseEngine; database?: string; favorite?: boolean; parameters?: {name:string;type:string}[]; id: string; connection: string; sql: string; status: string; startedAt: string; durationMs: number }
// Version 1 is accepted only by the storage migration, never by new IPC writes.
export const legacyWorkspaceSchema = z.object({ sql: z.string().max(MAX_SQL_CHARACTERS), profile: profileSchema.optional() }).strict()
export const workspaceSchema = z.object({ version: z.literal(2), tabs: z.array(workspaceTabSchema).min(1).max(MAX_TABS), activeTabId: idSchema,
  profiles: z.array(savedProfileSchema).max(MAX_PROFILES), layout: layoutSchema.optional(), editorSettings: editorSettingsSchema.optional(), editorViews: editorViewsSchema.optional(), tableLayouts: tableLayoutsSchema.optional() }).strict().superRefine((workspace, context) => {
  const tabs = new Set(workspace.tabs.map(tab => tab.id)), profiles = new Set(workspace.profiles.map(profile => profile.id))
  if (tabs.size !== workspace.tabs.length || profiles.size !== workspace.profiles.length) context.addIssue({ code: 'custom', message: 'Tab and profile IDs must be unique.' })
  if (!tabs.has(workspace.activeTabId)) context.addIssue({ code: 'custom', message: 'The active tab must exist.' })
  if (workspace.editorViews && (!workspace.editorViews.tabIds.includes(workspace.activeTabId) || workspace.editorViews.tabIds.some(id => !tabs.has(id)))) context.addIssue({ code: 'custom', message: 'Editor views must reference existing tabs and include the active tab.' })
  if (workspace.tabs.some(tab => tab.profileId && !profiles.has(tab.profileId))) context.addIssue({ code: 'custom', message: 'A tab references a missing saved profile.' })
  if (workspace.tabs.reduce((length, tab) => length + tab.sql.length, 0) > MAX_WORKSPACE_SQL_CHARACTERS) context.addIssue({ code: 'custom', message: 'The workspace supports up to 5 MB of SQL text.' })
})
export type Workspace = z.infer<typeof workspaceSchema>
export const runSchema = z.object({ sessionId: idSchema, viewId: idSchema.optional(), queryId: idSchema.optional(), sql: z.string().trim().min(1).max(MAX_SQL_CHARACTERS), parameters: parametersSchema.optional(), singleUnit: z.boolean().optional(), maxRows: z.number().int().min(1).max(10000).default(1000) }).strict()
export type RunRequest = z.infer<typeof runSchema>
// Grid snapshots and original values are retained by the database host. The
// renderer submits only row ordinals and explicitly changed cells.
export const gridTableSchema = z.object({ catalog: z.string().min(1).max(255).optional(), schema: z.string().min(1).max(255), name: z.string().min(1).max(255) }).strict()
const gridValuesSchema = z.array(z.object({ column: z.number().int().min(0).max(99), value: z.string().max(16384).nullable() }).strict()).max(100)
export const gridFilterSchema = z.union([
  z.object({ column: z.string().min(1).max(255), operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts-with']), value: z.string().max(16384) }).strict(),
  z.object({ column: z.string().min(1).max(255), operator: z.enum(['is-null', 'not-null']) }).strict()
])
export const gridQuerySchema = z.object({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(200)]).default(200),
  filters: z.array(gridFilterSchema).max(8).default([]),
  sort: z.array(z.object({ column: z.string().min(1).max(255), direction: z.enum(['asc', 'desc']) }).strict()).max(3).default([])
}).strict()
export type GridQueryOptions = z.infer<typeof gridQuerySchema>
export type GridFilter = z.infer<typeof gridFilterSchema>
const gridChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert'), values: gridValuesSchema }).strict(),
  z.object({ kind: z.literal('update'), row: z.number().int().min(0).max(199), values: gridValuesSchema.min(1) }).strict(),
  z.object({ kind: z.literal('delete'), row: z.number().int().min(0).max(199) }).strict()
])
export const gridRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('release'), sessionId: idSchema, viewId: idSchema }).strict(),
  z.object({ action: z.literal('inspect-cell'), sessionId: idSchema, viewId: idSchema.optional(), snapshotId: idSchema, row: z.number().int().min(0).max(199), column: z.number().int().min(0).max(99) }).strict(),
  z.object({ action: z.literal('foreign-keys'), sessionId: idSchema, viewId: idSchema.optional(), snapshotId: idSchema }).strict(),
  z.object({ action: z.literal('follow-reference'), sessionId: idSchema, viewId: idSchema.optional(), snapshotId: idSchema, row: z.number().int().min(0).max(199), referenceId: z.string().length(64) }).strict(),
  z.object({ action: z.literal('open'), sessionId: idSchema, viewId: idSchema.optional(), table: gridTableSchema, query: gridQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('browse'), sessionId: idSchema, viewId: idSchema.optional(), table: gridTableSchema, query: gridQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('apply'), sessionId: idSchema, viewId: idSchema.optional(), snapshotId: idSchema, changes: z.array(gridChangeSchema).min(1).max(200) }).strict()
])
export type GridRequest = z.infer<typeof gridRequestSchema>
export type GridChange = z.infer<typeof gridChangeSchema>
export type GridTable = z.infer<typeof gridTableSchema>
export interface GridColumn { name: string; type: string; nullable: boolean; primaryKey: boolean; generated: boolean; hasDefault: boolean; filterable?: boolean; sortable?: boolean; textual?: boolean }
export interface GridSnapshot { id: string; table: GridTable; columns: GridColumn[]; rows: Cell[][]; truncated: boolean; query: GridQueryOptions; mode: 'browse' | 'edit'; notice?: string; cellMarks?: import('./inspection').CellMark[]; /** Equivalent SELECT without browser display casts, when no filter values need binding. */ statement?: string }
export interface GridResponse { session: SessionInfo; grid?: GridSnapshot; applied?: number; error?: string; imported?: number; importPreview?: import('./transfer').ImportPreview; inspection?: import('./inspection').CellInspection; references?: import('./inspection').ForeignKey[]; dataCapture?: import('./data-compare').DataCapture }
export interface DesktopApi {
  preferences(): Promise<import('./editor-settings').EditorSettings | null>
  savePreferences(settings: import('./editor-settings').EditorSettings): Promise<void>
  onPreferencesChanged(listener: (settings: import('./editor-settings').EditorSettings) => void): () => void
  applicationMenu(): Promise<import('./application-menu').ApplicationMenuItem[] | null>
  executeApplicationMenu(path: string): Promise<void>
  updateTitleBar(appearance: import('./application-menu').TitleBarAppearance): Promise<void>
  onApplicationMenuKey(listener: (index: number | null) => void): () => void
  onAbout(listener: (version: string) => void): () => void
  updateStatus(): Promise<import('./updates').UpdateStatus>
  checkForUpdates(): Promise<import('./updates').UpdateStatus>
  dismissUpdate(version?: string): Promise<void>
  openUpdatePage(): Promise<void>
  onUpdateStatus(listener: (status: import('./updates').UpdateStatus) => void): () => void
  workspaceWindows(): Promise<import('./workspace-windows').WorkspaceWindows>
  createWorkspaceWindow(name: string): Promise<void>
  openWorkspaceWindow(id: string): Promise<void>
  onWindowsCommand(listener: () => void): () => void
  prepareActivityAction(request:import('./activity-control').PrepareActivityAction):Promise<import('./activity-control').ActivityActionReview>
  applyActivityAction(request:import('./activity-control').ApplyActivityAction):Promise<import('./activity-control').ActivityActionResult>
  inspectRollback(request:import('./rollback').RollbackRequest):Promise<import('./rollback').RollbackSnapshot>
  inspectActivity(request:import('./activity').ActivityRequest):Promise<import('./activity').ActivitySnapshot>
  saveActivity(snapshot:import('./activity').ActivitySnapshot):Promise<string|null>
  prepareQueryBuilder(request: import('./query-builder').PrepareBuilder): Promise<import('./query-builder').BuilderPreview>
  prepareMigration(request: import('./migrations').PrepareMigration): Promise<import('./migrations').MigrationPreview>
  saveMigration(request: import('./migrations').SaveMigration): Promise<string | null>
  explain(request: import('./explain').ExplainRequest): Promise<import('./explain').ExplainResult>
  cancelExplain(sessionId: string): Promise<{ requested: boolean }>
  savePlan(value: { text: string; format: 'json' | 'xml' | 'text' | 'table' }): Promise<string | null>
  saveValue(value: { text: string; format: 'json' | 'xml' | 'text' }): Promise<string | null>

  prepareSchemaChange(request: import('./schema-changes').PrepareSchemaChange): Promise<import('./schema-changes').SchemaChangePlan>
  applySchemaChange(request: import('./schema-changes').ApplySchemaChange): Promise<import('./schema-changes').SchemaChangeResult>
  cancelSchemaChange(sessionId: string): Promise<{ requested: boolean }>
  inspectImport(source: import('./transfer').ImportSource): Promise<import('./transfer').ImportPreview>
  startTransfer(request: import('./transfer').TransferRequest): Promise<import('./transfer').TransferJob>
  transferJobs(): Promise<import('./transfer').TransferJob[]>
  cancelTransfer(jobId: string): Promise<{ requested: boolean }>
  chooseTransferFile(input: { save: boolean; format: import('./transfer').ExportFormat }): Promise<string | null>
  onTransferJob(listener: (job: import('./transfer').TransferJob) => void): () => void
  startBackup(request: import('./backup').BackupRequest): Promise<import('./backup').BackupJob>
  backupJobs(): Promise<import('./backup').BackupJob[]>
  retryBackupHistory(): Promise<void>
  cancelBackup(jobId: string): Promise<{ requested: boolean }>
  chooseBackupFile(input: { sessionId: string; save: boolean }): Promise<string | null>
  onBackupJob(listener: (job: import('./backup').BackupJob) => void): () => void
  onLayoutCommand(listener: (command: LayoutCommand) => void): () => void
  connect(config: ConnectionConfig): Promise<SessionInfo>
  connectSavedPassword(profileId: string, config: ConnectionProfile, sshSecrets?: ConnectionConfig['sshSecrets']): Promise<SessionInfo>
  sessionSafety(sessionId: string): Promise<ConnectionSafety>
  unlockSession(sessionId: string, confirmation: string): Promise<ConnectionSafety>
  lockSession(sessionId: string): Promise<ConnectionSafety>
  chooseSshKey(): Promise<string | null>
  cloneSession(sessionId: string): Promise<SessionInfo>
  exportConnectionProfiles(ids?: string[]): Promise<string | null>
  importConnectionProfiles(): Promise<import('./profile-files').ProfileImport | null>
  passwordStatus(profileId?: string): Promise<PasswordStatus>
  saveProfilePassword(profileId: string, password: string): Promise<void>
  removeProfilePassword(profileId: string): Promise<void>
  disconnect(sessionId: string): Promise<void>
  databases(sessionId: string): Promise<DatabaseCatalog>
  switchDatabase(request: SwitchDatabaseRequest): Promise<SessionInfo>
  run(request: RunRequest): Promise<{ queryId: string }>
  cancel(sessionId: string): Promise<{ requested: boolean }>
  tables(sessionId: string): Promise<SchemaTable[]>
  schema(sessionId: string): Promise<SchemaSnapshot>
  copyDefinition(sql: string): Promise<void>
  compareSchemas(request: import('./schema-compare').CompareSchemaRequest): Promise<import('./schema-compare').SchemaComparison>
  compareData(request: import('./data-compare').DataCompareRequest): Promise<import('./data-compare').DataComparison>
  diagram(request: import('./diagram').DiagramRequest): Promise<import('./diagram').DiagramSnapshot>
  saveDiagram(request: import('./diagram').DiagramExport): Promise<string|null>
  inspectObject(request: import('./catalog').InspectObjectRequest): Promise<import('./catalog').ObjectDetail>
  editGrid(request: GridRequest): Promise<GridResponse>
  loadWorkspace(): Promise<(Workspace & { recoveryNotice?: string }) | null>
  saveWorkspace(workspace: Workspace): Promise<void>
  exportEditorSettings(settings: import('./editor-settings').EditorSettings): Promise<string | null>
  importEditorSettings(): Promise<import('./editor-settings-files').ImportedEditorSettings | null>
  searchHistory(search: import('./query-library').HistorySearch): Promise<{entries:HistoryEntry[];total:number}>
  historySettings(): Promise<import('./query-library').HistorySettings>
  saveHistorySettings(settings: import('./query-library').HistorySettings): Promise<void>
  favoriteHistory(id:string,favorite:boolean): Promise<void>
  deleteHistory(id:string): Promise<void>
  snippets(search?:{text?:string;engine?:DatabaseEngine;favorites?:boolean}): Promise<import('./query-library').Snippet[]>
  saveSnippet(snippet:import('./query-library').SnippetInput): Promise<import('./query-library').Snippet>
  deleteSnippet(id:string): Promise<void>
  exportSnippets(ids: string[]): Promise<string | null>
  reviewSnippetImport(): Promise<import('./snippet-files').SnippetImportPreview | null>
  applySnippetImport(request: import('./snippet-files').SnippetImportRequest): Promise<import('./snippet-files').SnippetImportResult>
  discardSnippetImport(id: string): Promise<void>
  history(): Promise<HistoryEntry[]>
  clearHistory(includeFavorites?:boolean): Promise<void>
  exportCsv(queryId: string, index: number): Promise<string | null>
  saveSql(sql: string): Promise<string | null>
  saveSqlFile(request: import('./sql-files').SaveSqlFileRequest): Promise<import('./sql-files').SqlFileInfo | null>
  restoreSqlFiles(): Promise<import('./sql-files').SqlFilesState>
  checkSqlFiles(): Promise<import('./sql-files').SqlFilesState>
  reloadSqlFile(request: { tabId: string; sql: string }): Promise<import('./sql-files').PreparedSqlFileReload | null>
  finishSqlFileReload(request: { reloadId: string; accept: boolean }): Promise<import('./sql-files').SqlFileInfo | null>
  forgetSqlFile(tabId: string): Promise<void>
  clearRecentSqlFiles(): Promise<void>
  onFileCommand(listener: (command: import('./sql-files').SqlFileCommand) => void): () => void
  chooseSqliteFile(create: boolean): Promise<string | null>
  chooseDuckdbFile(create: boolean): Promise<string | null>
  openSql(request: { tabId: string; recentId?: string }): Promise<import('./sql-files').OpenedSqlFile | null>
  onEvent(listener: (event: DatabaseEvent) => void): () => void
  onSaveRequested(listener: () => Promise<void>): () => void
}
declare global { interface Window { dbCommander: DesktopApi } }
