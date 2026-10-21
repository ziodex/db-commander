import type { DesktopApi, Workspace, DatabaseEvent } from './contracts'
import type { BackupJob } from './backup'
import type { TransferJob } from './transfer'
import type { MigrationPreview, SaveMigration } from './migrations'
import type { SnippetDocument, SnippetImportPreview } from './snippet-files'

type Method<Payload, Result> = { payload: Payload; result: Result }
type DesktopMethod<K extends keyof DesktopApi> = Method<
  Parameters<DesktopApi[K]> extends [] ? undefined : Parameters<DesktopApi[K]>[0],
  Awaited<ReturnType<DesktopApi[K]>>
>
type Forwarded =
  | 'connect' | 'disconnect' | 'databases' | 'switchDatabase' | 'tables' | 'schema'
  | 'run' | 'cancel' | 'editGrid' | 'explain' | 'cancelExplain'
  | 'sessionSafety' | 'lockSession' | 'prepareSchemaChange' | 'applySchemaChange' | 'cancelSchemaChange'
  | 'inspectImport' | 'startTransfer' | 'cancelTransfer' | 'startBackup' | 'cancelBackup'
  | 'compareData' | 'compareSchemas' | 'prepareMigration' | 'prepareQueryBuilder'
  | 'prepareActivityAction' | 'applyActivityAction' | 'inspectRollback' | 'inspectActivity'
  | 'diagram' | 'inspectObject' | 'saveWorkspace' | 'history' | 'clearHistory'
  | 'searchHistory' | 'historySettings' | 'saveHistorySettings' | 'deleteHistory'
  | 'snippets' | 'saveSnippet' | 'deleteSnippet' | 'applySnippetImport' | 'discardSnippetImport'

/** Internal host protocol. Native file choices and credential resolution stay in main. */
type HostContract = { [K in Forwarded]: DesktopMethod<K> } & {
  unlockSession: Method<{ sessionId: string; confirmation: string }, Awaited<ReturnType<DesktopApi['unlockSession']>>>
  loadWorkspace: Method<undefined, Workspace | null>
  loadWorkspaceRecovery: DesktopMethod<'loadWorkspace'>
  favoriteHistory: Method<{ id: string; favorite: boolean }, void>
  reviewedMigration: Method<SaveMigration, MigrationPreview>
  exportCsv: Method<{ queryId: string; index: number; path: string }, void>
  exportSnippets: Method<string[], SnippetDocument>
  reviewSnippetImport: Method<SnippetDocument, SnippetImportPreview>
}
export type HostMethod = keyof HostContract
type HostPayload<K extends HostMethod> = HostContract[K]['payload']
export type HostResult<K extends HostMethod> = HostContract[K]['result']
export type HostArgs<K extends HostMethod> = undefined extends HostPayload<K>
  ? [payload?: HostPayload<K>] : [payload: HostPayload<K>]
type HostRequest = { [K in HostMethod]: { id: string; method: K; payload: HostPayload<K> } }[HostMethod]
export type HostInput = HostRequest | { ack: string }
type HostReply = { id: string; ok: true; value: HostResult<HostMethod> } | { id: string; ok: false; error: string }
export type HostMessage = HostReply | { ready: true } | { startupError: string }
  | { event: DatabaseEvent; token?: string } | { backupJob: BackupJob } | { transferJob: TransferJob }
export type HostHandlers = { [K in HostMethod]: (payload: unknown) => HostResult<K> | Promise<HostResult<K>> }
