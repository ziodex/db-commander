import { useJobFeed } from './use-job-feed'
import { useWorkspaceRecovery } from './use-workspace-recovery'
import { TitleBar } from './TitleBar'
import { UpdateBanner } from './UpdateBanner'
import { AboutDialog } from './AboutDialog'
import { ModalDialog } from './ModalDialog'
import { workspaceSqlLimit } from '../shared/workspace-limits'
import { useSqlFiles } from './use-sql-files'
import { currentExecution } from '../language/execution'
import { errorSource, type ExecutionSource } from '../shared/execution'
import { RecentSqlFiles } from './RecentSqlFiles'
import { ActionMenu } from './ActionMenu'
import { QueryTabStrip } from './QueryTabStrip'
import { moveTab, setTabPinned } from '../shared/tab-order'
import { CommandPalette } from './CommandPalette'
import { useAppearance } from './appearance'
import { DEFAULT_EDITOR_SHORTCUTS, shortcutLabel } from '../shared/editor-shortcuts'
import { WorkspaceWindowsDialog } from './WorkspaceWindowsDialog'
import { EditorSettingsDialog } from './EditorSettingsDialog'
import { useApplicationPreferences } from './use-application-preferences'
import { DEFAULT_EDITOR_SETTINGS } from '../shared/editor-settings'
import { ActivityDialog } from './ActivityDialog'
import { QueryBuilderDialog } from './QueryBuilderDialog'
import { DataCompareDialog } from './DataCompareDialog'
import { SchemaCompareDialog } from './SchemaCompareDialog'
import { DiagramDialog } from './DiagramDialog'
import { QueryLibrary } from './QueryLibrary'
import { ParameterDialog } from './ParameterDialog'
import { parameterNames, type QueryParameter } from '../shared/parameters'
import { ExplainDialog } from './ExplainDialog'
import type { SavedColumnControls } from './ColumnControls'
import { defaultColumns, withColumnView, type ColumnLayout } from '../shared/column-layout'
import { matchingTableLayout, saveTableLayout, tableColumns, tableColumnViewKey, tableLayoutKey } from '../shared/table-layouts'
import type { ExplainRequest } from '../shared/explain'
import { ObjectInspector, type ObjectView } from './ObjectInspector'
import { ConnectionDialog } from './ConnectionDialog'
import { ProfileList } from './ProfileList'
import { profileConnectionStates } from './profile-connections'
import { SessionSafetyBar } from './SessionSafetyBar'
import { SchemaChangeDialog } from './SchemaChangeDialog'
import type { SchemaChange, ApplySchemaChange } from '../shared/schema-changes'
import type { CatalogObject } from '../shared/catalog'
import { BackupDialog } from './BackupDialog'
import { TransferDialog } from './TransferDialog'
import { ResultTabs } from './ResultTabs'
import { resultCommand, resultCount } from './result-navigation'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { PanelLeft, PanelBottom, Maximize2, Minimize2, Search, Activity, ArrowDownToLine, Check, Database, FolderOpen, History, LockKeyhole, Play, Plus, Settings2, Square, Table2, Terminal, Unplug, X } from './WorkbenchIcons'
import type { ConnectionConfig, ConnectionProfile, HistoryEntry } from '../shared/contracts'
import { DEFAULT_PROFILE, MAX_PROFILES, MAX_TABS, engineNames, type DatabaseEngine, type Workspace, type WorkspaceTab, type SavedConnectionProfile } from '../shared/contracts'
import { tablePreviewSql } from '../shared/sql/common'
import { QueryEditorViews } from './QueryEditorViews'
import { equalViewWeights, MAX_EDITOR_VIEWS, reconcileEditorViews, resizeEditorViews, type EditorViews } from '../shared/editor-views'
import { flushSync } from 'react-dom'
import { formatEditor } from './language-service'
import { changesSchema } from '../language/completion'
import { DEFAULT_LAYOUT, applyLayoutCommand, clampSize, panelBounds, layoutCommands, type LayoutCommand, type WorkspaceLayout } from '../shared/layout'
import { passwordEligible, type PasswordChoice } from '../shared/credentials'
import { connectionProfile, hasConfiguredConnection, sameConnectionProfile, sameConnectionSettings } from '../shared/connection-profiles'
import { Splitter } from './Splitter'
import { useElementSize } from './use-element-size'
import { DatabaseExplorer } from './DatabaseExplorer'
import { TableData } from './TableData'
import type { DatabaseEvent, GridTable, GridQueryOptions, GridSnapshot, SessionInfo } from '../shared/contracts'
import { ResultWorkspace } from './ResultWorkspace'
import { applyDatabaseEvent, tabOperationBusy, canCloseTab, canSwitchDatabase, emptyTabState, type QueryTabState } from './query-tabs'
import { connectionGroups, patchSessionState, reconcileSessionBusy, sessionOwners } from './shared-sessions'
import { ConnectionSessionBar } from './ConnectionSessionBar'
import { ProfileImportDialog } from './ProfileImportDialog'
import { useProfileLibrary } from './use-profile-library'

const INITIAL_SQL = `SELECT\n  current_database() AS database,\n  current_user AS connected_as,\n  now() AS server_time;\n`
const INITIAL_PROFILE = DEFAULT_PROFILE
const MYSQL_INITIAL_SQL = `SELECT DATABASE() AS database_name, CURRENT_USER() AS connected_as, NOW(6) AS server_time;\n`
const SQLSERVER_INITIAL_SQL = `-- SQL Server / Azure SQL. GO separates batches.\nSELECT DB_NAME() AS database_name, SUSER_SNAME() AS connected_as, SYSDATETIMEOFFSET() AS server_time;\n`
const ORACLE_INITIAL_SQL = `-- Oracle: changes need COMMIT or ROLLBACK. DDL commits implicitly.\n-- End PL/SQL blocks with a slash on its own line.\nSELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS service_name, USER AS connected_as, SYSTIMESTAMP AS server_time FROM dual;\n`
const DUCKDB_INITIAL_SQL = `SELECT version() AS duckdb_version, 42 AS answer;\n`
const SQLITE_INITIAL_SQL = `SELECT sqlite_version() AS sqlite_version, datetime('now') AS utc_time;\n`
function starterSql(engine: DatabaseEngine) { return engine === 'duckdb' ? DUCKDB_INITIAL_SQL : engine === 'oracle' ? ORACLE_INITIAL_SQL : engine === 'sqlite' ? SQLITE_INITIAL_SQL : engine === 'postgres' ? INITIAL_SQL : ['mysql', 'mariadb'].includes(engine) ? MYSQL_INITIAL_SQL : SQLSERVER_INITIAL_SQL }
const shortcutKey = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'
const api = window.dbCommander

export function App() {
  const { workspace, workspaceRef, updateWorkspace, ready, readyRef, workspaceLoadError, saved, saveError, saveAnnouncement, persist } = useWorkspaceRecovery(
    api,
    () => {
      const id = crypto.randomUUID()
      return { version: 2, activeTabId: id, profiles: [], tabs: [{ id, title: 'Untitled.sql', sql: INITIAL_SQL, profile: INITIAL_PROFILE }] }
    },
    (value, notice) => {
      if (notice) changeStates(() => Object.fromEntries(value.tabs.map(tab => [tab.id, { ...emptyTabState(), error: notice }])))
    },
    error => report(error, workspaceRef.current.activeTabId)
  )
  const workspaceBodyRef = useRef<HTMLDivElement>(null), queryPanesRef = useRef<HTMLDivElement>(null)
  const bodySize = useElementSize(workspaceBodyRef), panesSize = useElementSize(queryPanesRef)
  const layout = workspace.layout ?? DEFAULT_LAYOUT
  const { settings: editorSettings, apply: applyPreferences } = useApplicationPreferences(api, workspace.editorSettings ?? DEFAULT_EDITOR_SETTINGS)
  const theme = useAppearance(editorSettings.appearance)
  const editorKeys = editorSettings.shortcuts ?? DEFAULT_EDITOR_SHORTCUTS
  const keyHint = (action: keyof typeof editorKeys) => shortcutLabel(editorKeys[action], shortcutKey === '⌘')
  const bounds = panelBounds(bodySize.width || window.innerWidth, panesSize.height || 700)
  const sidebarWidth = clampSize(layout.sidebarWidth, bounds.sidebarMin, bounds.sidebarMax)
  const resultsHeight = clampSize(layout.resultsHeight, bounds.resultsMin, bounds.resultsMax)
  const [states, setStates] = useState<Record<string, QueryTabState>>({})
  const statesRef = useRef(states)
  const lostSessions = useRef(new Set<string>())
  const generation = useRef(0)
  const [dialogInfo, setDialogInfo] = useState<{ tabId: string; profile: ConnectionProfile; profileId?: string; saveOnly?: boolean } | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [connectionWarning, setConnectionWarning] = useState<{ tabId: string; profileId: string; name: string; error: string } | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<{ tabId: string; sessionId: string; database: string } | null>(null)
  const [closeRequest, setCloseRequest] = useState<{ ids: string[]; confirm: boolean } | null>(null)
  const closeId = closeRequest?.ids[0] ?? null
  const [closingTabs, setClosingTabs] = useState(false), closeOperation = useRef(false)
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null)
  const [activityOpen,setActivityOpen]=useState<{tabId:string;sessionId:string}|null>(null)
  const [builderOpen,setBuilderOpen]=useState<{tabId:string;sessionId:string;table?:GridTable}|null>(null)
  const [dataCompareOpen,setDataCompareOpen]=useState<{tabId:string;sessionId:string;table?:GridTable}|null>(null)
  const [compareOpen,setCompareOpen]=useState<{tabId:string;sessionId:string}|null>(null)
  const [diagramOpen,setDiagramOpen]=useState<{tabId:string;sessionId:string}|null>(null)
  const [objectView, setObjectView] = useState<ObjectView | null>(null)
  const [schemaEditor, setSchemaEditor] = useState<{ tabId: string; sessionId: string; target?: CatalogObject } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [explainText, setExplainText] = useState<string | null>(null)
  const activeSessionId = states[workspace.activeTabId]?.session?.id
  useEffect(() => { setExplainText(null) }, [workspace.activeTabId, activeSessionId])
  const [transfer, setTransfer] = useState<{ tabId: string; sessionId?: string; sql: string; sourceLabel?: string } | null>(null)
  const transferJobs = useJobFeed(api.onTransferJob, api.transferJobs, job => {
    const owner = Object.keys(statesRef.current).find(id => statesRef.current[id]?.session?.id === job.sessionId)
    if (owner) patchState(owner, { transferBusy: job.status === 'running', gridExpired: true, ...(job.session ? { session: job.session } : {}) })
    if (job.status !== 'running') cleanupLostSession(job.sessionId)
  })
  const backupJobs = useJobFeed(api.onBackupJob, api.backupJobs, job => {
    const owner = Object.keys(statesRef.current).find(id => statesRef.current[id]?.session?.id === job.sessionId)
    if (owner) patchState(owner, { backupBusy: job.status === 'running' })
  })
  const [palette, setPalette] = useState(false)
  const [windowsOpen, setWindowsOpen] = useState(false)
  useEffect(() => api.onWindowsCommand(() => setWindowsOpen(true)), [])
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  const [librarySql,setLibrarySql]=useState<string>()
  const [parameterRun,setParameterRun]=useState<{tabId:string;sessionId:string;sql:string;names:string[];source?:ExecutionSource}>()
  function openLibrary(){const editor=editorRef.current,selection=editor?.getSelection();setLibrarySql(selection&&!selection.isEmpty()?editor!.getModel()!.getValueInRange(selection):workspaceRef.current.tabs.find(t=>t.id===workspaceRef.current.activeTabId)!.sql)}
  const [historyView, setHistoryView] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const editors = useRef(new Map<string, Monaco.editor.IStandaloneCodeEditor>())
  const pendingEditorFocus = useRef<string | null>(null)
  useLayoutEffect(() => { editorRef.current = editors.current.get(workspace.activeTabId) ?? null }, [workspace.activeTabId])
  const runRef = useRef<() => void>(() => {})
  const currentRunRef = useRef<() => void>(() => {})
  const tab = workspace.tabs.find(tab => tab.id === workspace.activeTabId)!
  const tabId = tab.id, sql = tab.sql, profile = tab.profile
  const state = states[tabId] ?? emptyTabState()
  const { session, results, activeResult, queryId, running, connecting, error, messages, showMessages, status, duration } = state
  const dialog = Boolean(dialogInfo)
  function changeWorkspace(update: (previous: Workspace) => Workspace) {
    const previous = workspaceRef.current, updated = update(previous)
    const views = reconcileEditorViews(updated.editorViews, updated.tabs.map(tab => tab.id), previous.activeTabId, updated.activeTabId)
    const next = views === updated.editorViews ? updated : { ...updated, editorViews: views }
    if (next.activeTabId !== previous.activeTabId) editorRef.current = editors.current.get(next.activeTabId) ?? null
    updateWorkspace(next)
  }
  function changeLayout(update: (previous: WorkspaceLayout) => WorkspaceLayout) {
    if (!readyRef.current) return
    const previous = workspaceRef.current.layout ?? DEFAULT_LAYOUT, next = update(previous)
    const focused = document.activeElement
    let focusTarget: string | undefined
    if (!next.sidebarVisible && (document.getElementById('workspace-sidebar')?.contains(focused) || focused?.getAttribute('aria-controls') === 'workspace-sidebar')) focusTarget = 'toggle-sidebar'
    if (!next.resultsVisible && (document.getElementById('execution-output')?.contains(focused) || focused?.getAttribute('aria-controls') === 'execution-output')) focusTarget = 'toggle-results'
    if (next.resultsMaximized && (document.getElementById('query-panel')?.contains(focused) || focused?.getAttribute('aria-controls') === 'execution-output')) focusTarget = 'execution-output'
    changeWorkspace(workspace => ({ ...workspace, layout: next }))
    if (focusTarget) requestAnimationFrame(() => document.getElementById(focusTarget)?.focus())
  }
  function layoutCommand(command: LayoutCommand) { changeLayout(layout => applyLayoutCommand(layout, command)) }
  function showSidebar(history: boolean) {
    setHistoryView(history); changeLayout(layout => ({ ...layout, sidebarVisible: true }))
  }
  function changeStates(update: (previous: Record<string, QueryTabState>) => Record<string, QueryTabState>) {
    const next = reconcileSessionBusy(update(statesRef.current)); statesRef.current = next; setStates(next)
  }
  function patchState(id: string, patch: Partial<QueryTabState>) {
    if (!workspaceRef.current.tabs.some(tab => tab.id === id)) return
    changeStates(previous => patchSessionState(previous, id, patch))
  }
  function patchTab(id: string, patch: Partial<WorkspaceTab>) {
    changeWorkspace(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab) }))
  }
  const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
  const report = (error: unknown, id = tabId) => patchState(id, { error: message(error), failure: undefined })
  function appendSelect(table: GridTable) {
    const current = workspaceRef.current.tabs.find(tab => tab.id === workspaceRef.current.activeTabId)!
    const generated = tablePreviewSql(table.schema, table.name, current.profile.engine, table.catalog)
    const text = `${current.sql ? '\n\n' : ''}${generated}`
    const sql = current.sql + text
    if (workspaceSqlLimit(workspaceRef.current.tabs.map(tab => tab.id === current.id ? { ...tab, sql } : tab))) {
      report(new Error('The generated SELECT would exceed the saved workspace SQL limit. Your SQL buffer was kept.'), current.id); return
    }
    const editor = editors.current.get(current.id), model = editor?.getModel()
    if (editor && model && model.getValue() === current.sql) {
      const end = model.getPositionAt(model.getValueLength())
      editor.pushUndoStop()
      editor.executeEdits('append-table-select', [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text }])
      editor.pushUndoStop()
      editor.setPosition(model.getPositionAt(sql.length)); editor.revealPosition(editor.getPosition()!); editor.focus()
    } else patchTab(current.id, { sql })
  }
  const setError = (error: string) => patchState(tabId, { error })
  const setStatus = (status: string) => patchState(tabId, { status })
  const profileLibrary = useProfileLibrary({ api, workspaceRef, changeWorkspace, persist, report, notice: setStatus,
    onDraft: profile => { setDialogError(''); setDialogInfo({ tabId: workspaceRef.current.activeTabId, profile, saveOnly: true }) } })
  const setActiveResult = (activeResult: number) => patchState(tabId, { activeResult, resultSelectionChanged: true })
  const setShowMessages = (showMessages: boolean) => patchState(tabId, { showMessages, resultSelectionChanged: true })
  const setTableSearch = (tableSearch: string) => patchState(tabId, { tableSearch })
  function setDialog(open: boolean, newConnection = false) {
    if (open && !readyRef.current) return
    setDialogError('')
    const current = workspaceRef.current.tabs.find(tab => tab.id === workspaceRef.current.activeTabId)!
    const saved = workspaceRef.current.profiles.find(profile => profile.id === current.profileId)
    setDialogInfo(open ? newConnection ? { tabId: current.id, profile: INITIAL_PROFILE } : { tabId: current.id, profile: saved?.config ?? current.profile, profileId: saved?.id } : null)
  }
  function cleanupLostSession(sessionId: string) {
    if (lostSessions.current.has(sessionId)) void api.disconnect(sessionId).then(() => lostSessions.current.delete(sessionId)).catch(() => {})
  }
  async function inspectObject(object: CatalogObject) {
    const current = statesRef.current[tabId], sessionId = current?.session?.id
    if (!sessionId || current.sharedSessionBusy || current.schemaLoading || current.running || current.gridBusy || current.backupBusy || current.transferBusy || current.switching || current.databasesLoading) return
    setObjectView({ tabId, sessionId, object, loading: true }); patchState(tabId, { schemaLoading: true })
    try {
      const detail = await api.inspectObject({ sessionId, object })
      if (statesRef.current[tabId]?.session?.id === sessionId) setObjectView(previous => previous?.sessionId === sessionId ? { ...previous, detail, loading: false } : previous)
    } catch (error) { setObjectView(previous => previous?.sessionId === sessionId ? { ...previous, error: message(error), loading: false } : previous) }
    finally { if (statesRef.current[tabId]?.session?.id === sessionId) patchState(tabId, { schemaLoading: false }); cleanupLostSession(sessionId) }
  }
  function openExplain() {
    const editor = editorRef.current, selection = editor?.getSelection()
    setExplainText(selection && !selection.isEmpty() ? editor!.getModel()!.getValueInRange(selection) : sql)
  }
  async function explainQuery(request: ExplainRequest) {
    const current = statesRef.current[tabId]
    if (!current?.session || current.session.id !== request.sessionId) throw new Error('This session is disconnected.')
    if (tabOperationBusy(current)) throw new Error('Wait for the current operation to finish.')
    if (current.gridChanges.length) throw new Error('Apply or discard staged table edits before explaining SQL.')
    patchState(tabId, { schemaLoading: true, status: 'Collecting query plan' })
    try {
      const result = await api.explain(request)
      if (statesRef.current[tabId]?.session?.id === request.sessionId) patchState(tabId, { session: result.session, plan: result, gridExpired: true, status: `Plan ${result.status}` })
      void api.history().then(setHistory).catch(() => {})
      return result
    } finally { if (statesRef.current[tabId]?.session?.id === request.sessionId) patchState(tabId, { schemaLoading: false }); cleanupLostSession(request.sessionId) }
  }
  function schemaChangeBlocked() {
    const current = statesRef.current[tabId]
    if (!current?.session) return 'Connect to a database first.'
    return canCloseTab(current) ?? (current.session.engine !== 'oracle' && current.session.autocommit === false ? 'Enable autocommit before reviewing schema changes.' : undefined)
  }
  async function prepareSchemaChange(change: SchemaChange) {
    const current = statesRef.current[tabId], sessionId = current.session!.id, reason = schemaChangeBlocked()
    if (reason) throw new Error(reason)
    patchState(tabId, { schemaLoading: true })
    try { return await api.prepareSchemaChange({ sessionId, change }) }
    catch (error) { throw new Error(message(error)) }
    finally { if (statesRef.current[tabId]?.session?.id === sessionId) patchState(tabId, { schemaLoading: false }); cleanupLostSession(sessionId) }
  }
  async function applySchemaChange(request: ApplySchemaChange) {
    const reason = schemaChangeBlocked()
    if (reason) throw new Error(reason)
    patchState(tabId, { schemaLoading: true, status: 'Applying schema change', error: '' })
    try {
      const result = await api.applySchemaChange(request)
      if (statesRef.current[tabId]?.session?.id === request.sessionId) patchState(tabId, { session: result.session, schemaStale: true, gridExpired: true, status: result.status === 'completed' ? 'Schema change applied' : `Schema change ${result.status}`, messages: [...statesRef.current[tabId].messages.slice(-99), result.message], error: result.status === 'completed' ? '' : result.message })
      void api.history().then(setHistory).catch(error => report(error, tabId))
      return result
    } catch (error) { report(error, tabId); throw new Error(message(error)) }
    finally {
      if (statesRef.current[tabId]?.session?.id === request.sessionId) {
        patchState(tabId, { schemaLoading: false })
        // Separate catalog connections can block on this tab's uncommitted DDL.
        if (statesRef.current[tabId].session?.transaction === 'idle') void refreshTables(tabId, request.sessionId)
      }
      cleanupLostSession(request.sessionId)
    }
  }
  async function refreshTables(id = tabId, sessionId = statesRef.current[id]?.session?.id) {
    const current = statesRef.current[id]
    if (!sessionId || current?.sharedSessionBusy || current?.schemaLoading || current?.running || current?.backupBusy || current?.transferBusy || current?.gridBusy || current?.switching || current?.databasesLoading) return
    patchState(id, { schemaLoading: true, schemaError: '' })
    try {
      const schema = await api.schema(sessionId)
      if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { schema, tables: schema.objects, schemaStale: false })
    } catch (error) {
      if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { schema: null, schemaStale: true, schemaError: message(error) })
    } finally { if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { schemaLoading: false }); cleanupLostSession(sessionId) }
  }
  async function refreshDatabases(id = tabId, sessionId = statesRef.current[id]?.session?.id) {
    const current = statesRef.current[id]
    if (!sessionId || current?.sharedSessionBusy || current?.databasesLoading || current?.schemaLoading || current?.running || current?.backupBusy || current?.transferBusy || current?.gridBusy || current?.switching) return
    patchState(id, { databasesLoading: true, databasesError: '' })
    try {
      const databases = await api.databases(sessionId)
      if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { databases })
    } catch (error) { if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { databasesError: message(error) }) }
    finally { if (statesRef.current[id]?.session?.id === sessionId) patchState(id, { databasesLoading: false }); cleanupLostSession(sessionId) }
  }
  function requestSwitch(database: string) {
    const current = statesRef.current[tabId]
    if (!current?.session) return
    const reason = canSwitchDatabase(current)
    if (reason) { report(new Error(reason)); return }
    const target = { tabId, sessionId: current.session.id, database }
    if (editorSettings.confirmDatabaseSwitch === false) void switchDatabase(target)
    else setSwitchTarget(target)
  }
  async function switchDatabase(target = switchTarget) {
    if (!target) return
    const clearConfirmation = () => setSwitchTarget(previous => previous?.tabId === target.tabId && previous.sessionId === target.sessionId ? null : previous)
    const current = statesRef.current[target.tabId]
    if (current?.session?.id !== target.sessionId) { clearConfirmation(); return }
    const reason = canSwitchDatabase(current)
    if (reason) { report(new Error(reason), target.tabId); clearConfirmation(); return }
    patchState(target.tabId, { switching: true, error: '', status: 'Switching database' })
    try {
      const connected = await api.switchDatabase({ sessionId: target.sessionId, database: target.database, retainSource: sessionOwners(statesRef.current, target.sessionId).length > 1 })
      if (statesRef.current[target.tabId]?.session?.id !== target.sessionId) { await api.disconnect(connected.id).catch(() => {}); return }
      if (connected.id !== target.sessionId && sessionOwners(statesRef.current, target.sessionId).length > 1) await api.editGrid({ action: 'release', sessionId: target.sessionId, viewId: target.tabId }).catch(() => {})
      const owner = workspaceRef.current.tabs.find(tab => tab.id === target.tabId)!
      patchTab(target.tabId, { profile: { ...owner.profile, database: connected.database } })
      patchState(target.tabId, { ...emptyTabState(), session: connected, connectionDatabase: connected.database, databases: current.databases ? { ...current.databases, current: connected.database } : null, status: 'Connected' })
      await refreshTables(target.tabId, connected.id)
    } catch (error) { report(error, target.tabId); patchState(target.tabId, { status: 'Switch failed' }) }
    finally { patchState(target.tabId, { switching: false }); clearConfirmation(); cleanupLostSession(target.sessionId) }
  }
  const sqlFiles = useSqlFiles({ workspace, workspaceRef, ready, changeWorkspace, patchTab, persist, report })
  const receiveDatabaseEvent = useEffectEvent((event: DatabaseEvent) => {
      const owner = event.type === 'host-lost' ? undefined : Object.entries(statesRef.current).find(([, state]) => state.session?.id === event.sessionId && (event.type === 'session-lost' || state.queryId === event.queryId))?.[0]
      const previousDatabase = owner ? statesRef.current[owner]?.session?.database : undefined
      if (event.type === 'host-lost') { generation.current++; lostSessions.current.clear() }
      if (event.type === 'session-lost' && owner) {
        lostSessions.current.add(event.sessionId)
      }
      // A lost connection can emit its final completion after the loss event.
      // Retry after completion or metadata/switch settlement releases its lock.
      if (event.type !== 'host-lost' && ['session-lost', 'complete'].includes(event.type)) cleanupLostSession(event.sessionId)
      changeStates(previous => Object.fromEntries(Object.entries(previous).map(([id, state]) => [id, applyDatabaseEvent(state, event)])))
      if (event.type === 'complete') {
        if (owner && statesRef.current[owner]?.session) patchState(owner, { session: statesRef.current[owner].session })
        void api.history().then(setHistory).catch(error => { if (owner) report(error, owner) })
        const owned = owner ? statesRef.current[owner] : undefined
        if (owner && owned?.session && event.database !== undefined && event.database !== previousDatabase) {
          const owners = sessionOwners(statesRef.current, event.sessionId)
          changeWorkspace(previous => ({ ...previous, tabs: previous.tabs.map(tab => owners.includes(tab.id) ? { ...tab, profile: { ...tab.profile, database: event.database! } } : tab) }))
        }
        if (owner && owned?.queryId === event.queryId && owned.session && (owned.schemaStale || event.database !== undefined && event.database !== previousDatabase)) {
          patchState(owner, { schema: null, tables: [] }); void refreshTables(owner, owned.session.id)
        }
      }
  })
  const receiveLayoutCommand = useEffectEvent(layoutCommand)
  const reportEffectError = useEffectEvent((error: unknown) => report(error, workspaceRef.current.activeTabId))
  const saveRequested = useEffectEvent(async () => {
      // Edits remain possible while a save is pending. A close acknowledgment
      // must cover the latest buffer, including edits before autosave's debounce.
      let snapshot: Workspace
      do { snapshot = workspaceRef.current; await persist() } while (workspaceRef.current !== snapshot)
      if (Object.values(statesRef.current).some(state => state.gridChanges.length || state.gridBusy)) throw new Error('Staged table edits are not saved.')
  })
  useEffect(() => {
    let disposed = false
    void api.history().then(value => { if (!disposed) setHistory(value) }).catch(error => { if (!disposed) reportEffectError(error) })
    const off = api.onEvent(event => receiveDatabaseEvent(event))
    const offLayout = api.onLayoutCommand(command => receiveLayoutCommand(command))
    const offSave = api.onSaveRequested(() => saveRequested())
    return () => { disposed = true; off(); offSave(); offLayout() }
  }, [])
  const receiveKeyboardEvent = useEffectEvent((event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [role="dialog"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(value => !value) }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') { event.preventDefault(); if (!dialog && !closeId && !deleteProfileId && ready) newTab() }
      if (event.key === 'F6' && !event.altKey && !event.metaKey && !event.ctrlKey && !document.querySelector('dialog[open], [role="dialog"]') && workspaceRef.current.editorViews) { event.preventDefault(); focusNextEditor(event.shiftKey ? -1 : 1) }
      if (event.key === 'Escape') { setPalette(false); setBackupOpen(false); if (!connecting && !profileBusy && !sqlFiles.busy && !closeOperation.current) { setDialog(false); setCloseRequest(null); setDeleteProfileId(null) } }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => receiveKeyboardEvent(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  async function run(text?: string, parameters?:QueryParameter[], source?: ExecutionSource) {
    const current = statesRef.current[tabId]
    if (!current?.session || tabOperationBusy(current)) return
    if (current.gridChanges.length) { report(new Error('Apply or discard staged table edits before running SQL.')); return }
    const editor = editorRef.current, selection = editor?.getSelection()
    if (text === undefined && editor?.getModel()?.uri.path !== `/query/${tabId}.sql`) return
    const selected = selection ? editor?.getModel()?.getValueInRange(selection) : ''
    // An explicit whitespace-only selection must not fall back to the script.
    const raw = text ?? (selection && !selection.isEmpty() ? selected ?? '' : sql), query = raw.trim()
    if (!query.trim()) return
    if (!source && text === undefined) {
      const offset = selected?.trim() && selection ? editor!.getModel()!.getOffsetAt(selection.getStartPosition()) : 0
      const start = offset + raw.length - raw.trimStart().length
      source = { document: sql, sql: query, start, end: start + query.length, prefixLength: 0 }
    }
    if (current.session.safety?.protected && current.session.safety.unlockedUntil <= Date.now() && !/^\s*(COMMIT|ROLLBACK)\s*;?\s*$/i.test(query)) { report(new Error('This protected connection is locked. Unlock the connection and its shared tabs before executing SQL.')); return }
    const names=parameterNames(query,current.session.engine,current.session.mysqlSqlMode?.noBackslashEscapes,current.session.mysqlSqlMode?.ansiQuotes)
    if(names.length>100){report(new Error('A query may use up to 100 distinct named parameters.'));return}
    if(!parameters&&names.length){setParameterRun({tabId,sessionId:current.session.id,sql:query,names,source});return}
    const id = crypto.randomUUID(), sessionId = current.session.id
    const retainedGrid = text && /^(COMMIT|ROLLBACK)$/.test(text) ? current.grid : null
    patchState(tabId, { execution: source, failure: undefined, grid: retainedGrid, gridChanges: [], gridExpired: Boolean(retainedGrid), error: '', running: true, queryId: id, resultPartial: true, resultSource: `${tab.title} · ${engineNames[current.session.engine]} · ${current.session.name} · started in ${current.session.database || "server context"}`, results: [], activeResult: 0, resultSelectionChanged: false, messages: [], duration: null, status: 'Running', showMessages: false, schemaStale: current.schemaStale || changesSchema(query, current.session.engine) })
    try { await api.run({ sessionId, viewId: tabId, queryId: id, sql: query, parameters, singleUnit: source?.singleUnit, maxRows: 1000 }) }
    catch (error) { if (statesRef.current[tabId]?.queryId === id) patchState(tabId, { running: false, status: 'Failed', error: message(error), failure: { start: 0, end: query.length, scope: 'script' } }) }
  }
  runRef.current = () => { void run() }
  function runCurrent() {
    const editor = editorRef.current, model = editor?.getModel(), position = editor?.getPosition()
    if (!model || !position || !session) return
    try {
      const selected = currentExecution(sql, model.getOffsetAt(position), session.engine, session.mysqlSqlMode)
      void run(selected.sql, undefined, { ...selected, document: sql, singleUnit: true })
    } catch (error) { report(error) }
  }
  currentRunRef.current = runCurrent
  function runScript() {
    const query = sql.trim(), start = sql.length - sql.trimStart().length
    void run(query, undefined, { document: sql, sql: query, start, end: start + query.length, prefixLength: 0 })
  }
  function showSqlError() {
    const range = errorSource(state.execution, state.failure, sql), editor = editorRef.current, model = editor?.getModel()
    if (!range || !editor || !model) return
    const start = model.getPositionAt(range.start), end = model.getPositionAt(range.end)
    changeLayout(layout => ({ ...layout, resultsMaximized: false }))
    editor.pushUndoStop()
    editor.setSelection({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column })
    editor.focus()
    requestAnimationFrame(() => { if (editorRef.current?.getModel() === model) { editor.revealPositionInCenter(start); editor.focus() } })
  }
  async function connect(config: ConnectionConfig, saveProfile = true, target: { tabId: string; profile: ConnectionProfile; profileId?: string; saveOnly?: boolean; preserveProfile?: boolean; savedConnection?: boolean } = dialogInfo ?? { tabId, profile }, choice?: PasswordChoice) {
    const id = target.tabId, previous = statesRef.current[id] ?? emptyTabState()
    const reason = canCloseTab(previous)
    if (reason) { setDialogError(reason); return }
    const clean = connectionProfile(config)
    if (clean.engine === 'duckdb' && clean.duckdbMode === 'create') clean.duckdbMode = 'read-write'
    if (clean.engine === 'sqlite' && clean.sqliteMode === 'create') clean.sqliteMode = 'read-write'
    const existing = workspaceRef.current.profiles.find(profile => profile.id === target.profileId)
    const reuseId = existing && (target.preserveProfile || sameConnectionProfile(existing.config, clean)) ? existing.id : undefined
    if (saveProfile && !reuseId && !target.preserveProfile && workspaceRef.current.profiles.length >= MAX_PROFILES) { setDialogError(`Up to ${MAX_PROFILES} profiles can be saved. Uncheck Save connection profile or delete an unused profile.`); return }
    const epoch = generation.current
    patchState(id, { connecting: true, error: '' }); setDialogError('')
    if (target.savedConnection) setConnectionWarning(null)
    try {
      if (previous.session) { if (sessionOwners(statesRef.current, previous.session.id).length === 1) await api.disconnect(previous.session.id); else await api.editGrid({ action: 'release', sessionId: previous.session.id, viewId: id }); patchState(id, { session: null, tables: [], schema: null, schemaLoading: false, schemaError: '', databases: null, databasesError: '', databasesLoading: false, results: [], queryId: '', status: 'Disconnected' }) }
      const useSaved = target.savedConnection && target.profileId && passwordEligible(config) ? (await api.passwordStatus(target.profileId)).saved : choice?.useSaved
      const connected = useSaved && target.profileId ? await api.connectSavedPassword(target.profileId, connectionProfile(config), config.sshSecrets) : await api.connect(config)
      if (generation.current !== epoch || !workspaceRef.current.tabs.some(tab => tab.id === id)) { await api.disconnect(connected.id).catch(() => {}); return }
      const savedId = saveProfile ? reuseId ? workspaceRef.current.profiles.some(profile => profile.id === reuseId) ? reuseId : undefined : target.preserveProfile ? undefined : crypto.randomUUID() : undefined
      changeWorkspace(previous => ({ ...previous,
        profiles: !savedId || target.preserveProfile ? previous.profiles : reuseId ? previous.profiles.map(profile => profile.id === savedId ? { ...profile, config: clean } : profile) : [...previous.profiles, { id: savedId, config: clean }],
        tabs: previous.tabs.map(tab => tab.id !== id ? tab : { ...tab, profile: clean, profileId: savedId,
          sql: !sqlFiles.files[tab.id] && [INITIAL_SQL, MYSQL_INITIAL_SQL, SQLSERVER_INITIAL_SQL, SQLITE_INITIAL_SQL, ORACLE_INITIAL_SQL, DUCKDB_INITIAL_SQL].includes(tab.sql) ? starterSql(config.engine) : tab.sql }) }))
      patchState(id, { ...emptyTabState(), connecting: true, session: connected, connectionDatabase: connected.database, status: 'Connected' })
      if (savedId && !target.preserveProfile) {
        try { await persist(); await savePasswordChoice(savedId, config, choice) }
        catch (error) { report(new Error(`Connected, but profile or password storage failed. ${message(error)}`), id) }
      }
      setDialogInfo(previous => previous?.tabId === id && !previous.saveOnly ? null : previous)
      await refreshDatabases(id, connected.id)
      await refreshTables(id, connected.id)
      return connected
    } catch (error) {
      report(error, id)
      if (target.savedConnection && target.profileId) setConnectionWarning({ tabId: id, profileId: target.profileId, name: config.name, error: message(error) })
      else setDialogError(message(error))
    }
    finally { patchState(id, { connecting: false }) }
  }
  function newTab(savedProfile?: SavedConnectionProfile, definition?: { sql: string; title: string }, mode: 'shared' | 'independent' = 'shared') {
    if (closeId || closeOperation.current || sqlFiles.busy) return
    if (!ready || workspaceRef.current.tabs.length >= MAX_TABS) { report(new Error(`Up to ${MAX_TABS} query tabs can be open.`)); return }
    if (workspaceRef.current.tabs.reduce((size, tab) => size + tab.sql.length, definition?.sql.length ?? 1000) > 5_000_000) { report(new Error('Save and shorten a SQL buffer before opening another tab. Workspace SQL is limited to 5 MB.')); return }
    const current = workspaceRef.current.tabs.find(tab => tab.id === workspaceRef.current.activeTabId)!
    const existing = savedProfile ? [current, ...workspaceRef.current.tabs.filter(tab => tab.id !== current.id)].find(tab => tab.profileId === savedProfile.id && sameConnectionSettings(tab.profile, savedProfile.config) && (statesRef.current[tab.id]?.session || statesRef.current[tab.id]?.connecting)) : current
    const original = existing ? statesRef.current[existing.id] : undefined
    if (original?.closing || original?.connecting || original?.switching) { report(new Error('Wait for this connection operation to finish before opening another tab.')); return }
    const id = crypto.randomUUID(), source = existing && original?.session ? existing.profile : savedProfile?.config ?? current.profile
    const next: WorkspaceTab = { id, title: definition?.title.slice(0, 255) ?? `Query ${workspaceRef.current.tabs.length + 1}.sql`, sql: definition?.sql ?? starterSql(source.engine), profile: source, profileId: savedProfile?.id ?? current.profileId }
    changeWorkspace(previous => ({ ...previous, tabs: [...previous.tabs, next], activeTabId: id }))
    patchState(id, emptyTabState())
    const target = { tabId: id, profile: source, profileId: next.profileId }
    let connected: Promise<SessionInfo | undefined> | undefined
    if (original?.session && mode === 'independent') {
      connected = openIndependentConnection(id, original.session.id)
    } else if (original?.session) {
      patchState(id, { session: original.session, connectionDatabase: original.connectionDatabase, schema: original.schema, tables: original.tables, databases: original.databases, status: 'Connected' })
      connected = Promise.resolve(original.session)
    } else if (savedProfile) {
      connected = connect({ ...source, password: '' }, true, { ...target, savedConnection: true })
    }
    return { id, connected }
  }
  async function openIndependentConnection(id: string, sourceSession: string) {
    const epoch = generation.current
    patchState(id, { connecting: true, status: 'Connecting' })
    try {
      // Authentication stays in the main process. A clone opens a physical
      // connection; it never copies temporary objects, locks or transactions.
      const connected = await api.cloneSession(sourceSession)
      if (generation.current !== epoch || !workspaceRef.current.tabs.some(tab => tab.id === id)) { await api.disconnect(connected.id).catch(() => {}); return }
      patchState(id, { ...emptyTabState(), connecting: true, session: connected, connectionDatabase: connected.database, status: 'Connected' })
      await refreshDatabases(id, connected.id); await refreshTables(id, connected.id)
      return connected
    } catch (error) { report(error, id); patchState(id, { status: 'Connection failed' }) }
    finally { patchState(id, { connecting: false }) }
  }
  async function savePasswordChoice(id: string, config: ConnectionConfig, choice?: PasswordChoice) {
    if (!choice) return
    if (choice.remember && passwordEligible(config)) {
      if (config.password) await api.saveProfilePassword(id, config.password)
    } else await api.removeProfilePassword(id)
  }
  async function saveProfile(config: ConnectionConfig, choice: PasswordChoice) {
    if (!dialogInfo) return
    if (!dialogInfo.profileId && workspaceRef.current.profiles.length >= MAX_PROFILES) { setDialogError(`Up to ${MAX_PROFILES} profiles can be saved.`); return }
    setProfileBusy(true)
    const id = dialogInfo.profileId ?? crypto.randomUUID(), clean = connectionProfile(config)
    setDialogInfo(previous => previous ? { ...previous, profileId: id, profile: clean } : null)
    changeWorkspace(previous => ({ ...previous, profiles: [...previous.profiles.filter(profile => profile.id !== id), { id, config: clean }] }))
    try { await persist(); await savePasswordChoice(id, config, choice); setDialogInfo(null) } catch (error) { setDialogError(message(error)) } finally { setProfileBusy(false) }
  }
  async function deleteProfile() {
    const id = deleteProfileId
    if (!id) return
    setProfileBusy(true); setDialogError('')
    try {
      changeWorkspace(previous => ({ ...previous, profiles: previous.profiles.filter(profile => profile.id !== id), tabs: previous.tabs.map(tab => tab.profileId === id ? { ...tab, profileId: undefined } : tab) }))
      await persist(); setDeleteProfileId(null)
    } catch (error) {
      if (message(error).includes('Workspace changes are saved')) { setDeleteProfileId(null); report(error) }
      else setDialogError(message(error))
    } finally { setProfileBusy(false) }
  }
  async function disconnect() {
    await disconnectTabs([tabId])
  }
  async function disconnectTabs(ids: string[]) {
    const targets = workspaceRef.current.tabs.filter(tab => ids.includes(tab.id)).map(tab => ({ tab, state: statesRef.current[tab.id] }))
    for (const { tab, state } of targets) {
      const reason = state && canCloseTab(state)
      if (reason) { report(new Error(`${tab.title}: ${reason}`)); return }
    }
    const connected = targets.filter(target => target.state?.session)
    for (const { tab } of connected) patchState(tab.id, { closing: true })
    const sessions = new Set(connected.map(({ state }) => state.session!.id))
    await Promise.all([...sessions].map(async sessionId => {
      const owners = connected.filter(({ state }) => state.session!.id === sessionId)
      try {
        if (sessionOwners(statesRef.current, sessionId).every(id => ids.includes(id))) await api.disconnect(sessionId)
        else for (const { tab } of owners) await api.editGrid({ action: 'release', sessionId, viewId: tab.id })
        for (const { tab } of owners) patchState(tab.id, { session: null, tables: [], schema: null, schemaLoading: false, schemaError: '', databases: null, databasesError: '', databasesLoading: false, results: [], queryId: '', status: 'Disconnected' })
      } catch (error) { report(new Error(`${owners[0].tab.title}: ${message(error)}`)) }
      finally { for (const { tab } of owners) patchState(tab.id, { closing: false }) }
    }))
  }
  function pinTab(id: string, pinned: boolean) {
    if (!ready || sqlFiles.busy || closeId) return
    const previousFocus = document.activeElement
    changeWorkspace(previous => ({ ...previous, tabs: setTabPinned(previous.tabs, id, pinned) }))
    requestAnimationFrame(() => {
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) return
      const button = document.getElementById(`tab-${id}`)
      button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  function checkCloseTabs(ids: string[]) {
    for (const tab of workspaceRef.current.tabs.filter(tab => ids.includes(tab.id))) {
      const reason = tab.pinned ? 'Unpin this tab before closing it.' : canCloseTab(statesRef.current[tab.id] ?? emptyTabState())
      if (reason) {
        changeWorkspace(previous => ({ ...previous, activeTabId: tab.id }))
        report(new Error(ids.length > 1 ? `${tab.title}: ${reason}` : reason), tab.id)
        return false
      }
    }
    return true
  }
  function requestClose(id: string, scope: 'tab' | 'others' | 'all' = 'tab') {
    if (sqlFiles.busy || closeId || closeOperation.current) return
    const ids = workspaceRef.current.tabs.filter(tab => scope === 'tab' ? tab.id === id : !tab.pinned && (scope === 'all' || tab.id !== id)).map(tab => tab.id)
    if (!ids.length || !checkCloseTabs(ids)) return
    if (editorSettings.confirmTabClose === false) void closeTabs(ids)
    else setCloseRequest({ ids, confirm: true })
  }
  async function closeTabs(ids = closeRequest?.ids) {
    if (!ids?.length || sqlFiles.busy || closeOperation.current) return
    if (!checkCloseTabs(ids)) { setCloseRequest(null); return }
    closeOperation.current = true; setClosingTabs(true)
    setCloseRequest(previous => previous ?? { ids, confirm: false })
    try {
      // Sequential releases keep a shared connection alive until its final tab closes.
      for (const id of ids) if (!await closeTab(id)) break
    } finally { closeOperation.current = false; setClosingTabs(false); setCloseRequest(null) }
  }
  async function closeTab(id: string): Promise<boolean> {
    const tab = workspaceRef.current.tabs.find(tab => tab.id === id)
    if (!tab) return true
    if (!checkCloseTabs([id])) return false
    const current = statesRef.current[id] ?? emptyTabState()
    patchState(id, { closing: true })
    try {
      if (current.session) {
        if (sessionOwners(statesRef.current, current.session.id).length === 1) await api.disconnect(current.session.id)
        else await api.editGrid({ action: 'release', sessionId: current.session.id, viewId: id })
      }
      changeWorkspace(previous => {
        const index = previous.tabs.findIndex(tab => tab.id === id), remaining = previous.tabs.filter(tab => tab.id !== id)
        if (!remaining.length) remaining.push({ id: crypto.randomUUID(), title: 'Untitled.sql', sql: '', profile: INITIAL_PROFILE })
        return { ...previous, tabs: remaining, activeTabId: previous.activeTabId === id ? remaining[Math.min(index, remaining.length - 1)].id : previous.activeTabId }
      })
      changeStates(previous => { const next = { ...previous }; delete next[id]; return next })
      await persist(); await sqlFiles.forget(id)
      return true
    } catch (error) {
      report(error, workspaceRef.current.tabs.some(tab => tab.id === id) ? id : workspaceRef.current.activeTabId)
      return false
    } finally { patchState(id, { closing: false }) }
  }
  async function openSql() { await sqlFiles.open() }
  async function saveSql() { if (await sqlFiles.save()) setStatus('SQL file saved') }
  async function exportCsv() {
    if (tabOperationBusy(statesRef.current[tabId])) return
    try { const path = await api.exportCsv(queryId, activeResult); if (path && statesRef.current[tabId]?.queryId === queryId) setStatus('Fetched rows exported') }
    catch (error) { report(error) }
  }
  async function openGrid(table: GridTable, mode: GridSnapshot['mode'] = 'edit', query?: GridQueryOptions, preserveBack=false, id = tabId) {
    const current = statesRef.current[id]
    if (!current?.session || tabOperationBusy(current)) return
    if (current.gridChanges.length) { report(new Error('Apply or discard staged table edits before opening another table.'), id); return }
    const sessionId = current.session.id
    patchState(id, { gridBusy: true, error: '', status: 'Loading table', showMessages: false })
    try {
      const response = await api.editGrid({ action: mode === 'browse' ? 'browse' : 'open', sessionId, viewId: id, query, table: { schema: table.schema, name: table.name, ...(table.catalog ? { catalog: table.catalog } : {}) } })
      if (statesRef.current[id]?.session?.id !== sessionId) return
      patchState(id, { session: response.session, grid: response.grid ?? current.grid, ...(response.grid ? { columnViews: loadedTableViews(id, response.session, response.grid) } : {}), gridChanges: [], gridExpired: Boolean(response.error), status: response.error ? 'Table load failed' : 'Table loaded', error: response.error ?? '' })
      if(response.grid&&!preserveBack&&JSON.stringify(current.grid?.table)!==JSON.stringify(response.grid.table))patchState(id,{gridBack:[]})
      if (response.grid) changeWorkspace(previous => ({ ...previous, layout: { ...(previous.layout ?? DEFAULT_LAYOUT), resultsVisible: true } }))
      return response.error ? undefined : response.grid
    } catch (error) { patchState(id, { gridExpired: true }); report(error, id) }
    finally { patchState(id, { gridBusy: false }) }
  }
  async function browseTable(table: GridTable) {
    const source = statesRef.current[tabId]
    if (!source?.session || tabOperationBusy(source) || source.session.transaction !== 'idle' || source.gridChanges.length || sqlFiles.busy || closeId) return
    const created = newTab(undefined, { sql: '', title: table.name.trim() || 'Table data' })
    if (!created) return
    changeLayout(layout => ({ ...layout, resultsVisible: true, resultsMaximized: false }))
    if (!await created.connected) return
    const grid = await openGrid(table, 'browse', undefined, false, created.id)
    const owner = workspaceRef.current.tabs.find(tab => tab.id === created.id)
    if (!grid?.statement || !owner || owner.sql) return
    const sql = `${grid.statement};`
    const limit = workspaceSqlLimit(workspaceRef.current.tabs.map(tab => tab.id === created.id ? { ...tab, sql } : tab))
    if (limit) { report(new Error(limit), created.id); return }
    patchTab(created.id, { sql })
    if (workspaceRef.current.activeTabId === created.id) focusEditor(created.id)
  }
  function saveColumnView(key:string, view:ColumnLayout) {
    const current=statesRef.current[tabId]
    if(!current)return // A captured pointer can be released while its tab unmounts.
    patchState(tabId,{columnViews:withColumnView(current.columnViews,key,view)})
  }
  function loadedTableViews(id: string, session: SessionInfo, grid: GridSnapshot) {
    const current = statesRef.current[id], owner = workspaceRef.current.tabs.find(tab => tab.id === id)!
    const viewKey = tableColumnViewKey(session, grid), views = current?.columnViews ?? {}
    if (views[viewKey]) return withColumnView(views, viewKey, views[viewKey])
    const key = tableLayoutKey(owner.profile, session, grid.table, current?.connectionDatabase)
    const entry = key ? workspaceRef.current.tableLayouts?.find(entry => entry.key === key) : undefined
    return withColumnView(views, viewKey, matchingTableLayout(entry, grid) ?? defaultColumns(grid.columns.length))
  }
  function savedTableColumns(): SavedColumnControls | undefined {
    const grid = state.grid
    if (!grid) return
    const key = session ? tableLayoutKey(profile, session, grid.table, state.connectionDatabase) : undefined
    const entry = key ? workspace.tableLayouts?.find(entry => entry.key === key) : undefined
    const layout = matchingTableLayout(entry, grid)
    const blocked = (current: QueryTabState) => current.gridExpired || tabOperationBusy(current)
    function validateTarget() {
      const current = statesRef.current[tabId], owner = workspaceRef.current.tabs.find(tab => tab.id === tabId)
      if (!readyRef.current || !key || !owner || !current?.session || current.session.id !== session?.id || current.grid?.id !== grid!.id || blocked(current) || tableLayoutKey(owner.profile, current.session, current.grid.table, current.connectionDatabase) !== key) throw new Error('Reload this table before saving or removing its layout.')
    }
    return {
      exists: Boolean(entry), layout, disabled: !ready || !key || blocked(state),
      notice: !key ? 'Save layouts for server tables or tables in the opened database file. In-memory and attached file databases are excluded.' : entry && !layout ? 'The saved columns no longer match this table. Update the saved layout to use the current columns.' : entry ? 'A layout is saved for this connection and table. Changes here stay in this tab until you update it.' : 'Save these columns for this connection and table. Future sessions restore the layout when column names and types match.',
      save: async view => {
        validateTarget()
        changeWorkspace(previous => ({ ...previous, tableLayouts: saveTableLayout(previous.tableLayouts, { key: key!, columns: tableColumns(grid), layout: view }) }))
        await persist()
      },
      remove: async () => {
        validateTarget()
        changeWorkspace(previous => ({ ...previous, tableLayouts: previous.tableLayouts?.filter(entry => entry.key !== key) ?? [] }))
        await persist()
      }
    }
  }
  const resultViewKey=`result:${queryId}:${activeResult}`
  const tableViewKey=state.grid?tableColumnViewKey(session,state.grid):''
  async function inspectGrid(action:'inspect-cell'|'foreign-keys'|'follow-reference',row=0,column=0,referenceId='') {
    const current=statesRef.current[tabId], session=current?.session, grid=current?.grid
    if(!session||!grid||current.gridExpired)throw new Error('Reload the table before inspecting or navigating.')
    if(tabOperationBusy(current)||current.gridChanges.length)throw new Error('Finish the current operation and apply or discard staged edits first.')
    patchState(tabId,{gridBusy:true})
    try {
      const base={sessionId:session.id,viewId:tabId,snapshotId:grid.id}
      const response=await api.editGrid(action==='inspect-cell'?{...base,action,row,column}:action==='foreign-keys'?{...base,action}:{...base,action,row,referenceId})
      if(statesRef.current[tabId]?.session?.id!==session.id)throw new Error('This session changed.')
      patchState(tabId,{session:response.session})
      if(response.error){if(action==='follow-reference')patchState(tabId,{gridExpired:true});throw new Error(response.error)}
      if(response.grid)patchState(tabId,{grid:response.grid,columnViews:loadedTableViews(tabId,response.session,response.grid),gridExpired:false,gridBack:[...(current.gridBack??[]),{table:grid.table,query:grid.query}].slice(-20),status:'Referenced table loaded'})
      return response
    }finally{if(statesRef.current[tabId]?.session?.id===session.id)patchState(tabId,{gridBusy:false})}
  }
  async function backGrid() {
    const current=statesRef.current[tabId], previous=current.gridBack?.at(-1)
    if(!previous||current.gridChanges.length||current.gridBusy)return
    await openGrid(previous.table,'browse',previous.query,true)
    if(statesRef.current[tabId]?.grid?.table.name===previous.table.name&&!statesRef.current[tabId].gridExpired)patchState(tabId,{gridBack:current.gridBack!.slice(0,-1)})
  }
  async function applyGrid() {
    const current = statesRef.current[tabId]
    if (!current?.session || !current.grid || tabOperationBusy(current) || current.gridExpired || !current.gridChanges.length || current.switching || current.databasesLoading) return
    const sessionId = current.session.id
    patchState(tabId, { gridBusy: true, error: '', status: 'Applying edits' })
    try {
      const response = await api.editGrid({ action: 'apply', sessionId, viewId: tabId, snapshotId: current.grid.id, changes: current.gridChanges })
      if (statesRef.current[tabId]?.session?.id !== sessionId) return
      patchState(tabId, { session: response.session, gridExpired: true, gridChanges: response.applied === undefined ? current.gridChanges : [],
        status: response.applied === undefined ? 'Edits not applied' : `${response.applied} row edits applied · Commit or Rollback`, error: response.error ?? '' })
    } catch (error) { patchState(tabId, { gridExpired: true, error: message(error), status: 'Edit outcome unknown' }) }
    finally { patchState(tabId, { gridBusy: false }) }
  }
  const result = results[activeResult]
  function registerEditor(id: string, editor: Monaco.editor.IStandaloneCodeEditor | null) {
    if (editor) editors.current.set(id, editor); else editors.current.delete(id)
    if (workspaceRef.current.activeTabId === id) editorRef.current = editor
    if (editor && pendingEditorFocus.current === id) focusEditor(id)
  }
  function activateEditor(id: string) {
    if (!readyRef.current || sqlFiles.busy || closeId || !workspaceRef.current.tabs.some(tab => tab.id === id)) return
    editorRef.current = editors.current.get(id) ?? null
    if (workspaceRef.current.activeTabId !== id) changeWorkspace(previous => ({ ...previous, activeTabId: id }))
  }
  function focusEditor(id: string) {
    pendingEditorFocus.current = id
    requestAnimationFrame(() => {
      const editor = editors.current.get(id)
      if (editor && pendingEditorFocus.current === id && workspaceRef.current.activeTabId === id) { pendingEditorFocus.current = null; editor.focus() }
    })
  }
  function runEditor(id: string, current: boolean) {
    if (!readyRef.current || sqlFiles.busy || closeId || !workspaceRef.current.tabs.some(tab => tab.id === id)) return
    // Monaco actions can arrive before React has committed a focus change.
    // Commit the owner first so selection, dialect and session always agree.
    flushSync(() => changeWorkspace(previous => ({ ...previous, activeTabId: id })))
    editorRef.current = editors.current.get(id) ?? null
    if (current) currentRunRef.current(); else runRef.current()
  }
  function splitEditors(id = workspaceRef.current.activeTabId, orientation: EditorViews['orientation'] = 'vertical') {
    if (!readyRef.current || sqlFiles.busy || closeId) return
    const current = workspaceRef.current, visible = current.editorViews?.tabIds ?? [current.activeTabId]
    if (visible.length >= MAX_EDITOR_VIEWS) return
    let target = current.tabs.find(tab => tab.id === id && !visible.includes(id)) ?? current.tabs.find(tab => !visible.includes(tab.id))
    if (!target) {
      if (current.tabs.length >= MAX_TABS) return
      const source = current.tabs.find(tab => tab.id === current.activeTabId)!
      // Splitting never opens a connection or clones transaction/session state.
      target = { id: crypto.randomUUID(), title: `Query ${current.tabs.length + 1}.sql`, sql: '', profile: source.profile, profileId: source.profileId }
    }
    const selected = target, tabIds = [...visible, selected.id]
    changeWorkspace(previous => ({ ...previous, tabs: previous.tabs.some(tab => tab.id === selected.id) ? previous.tabs : [...previous.tabs, selected],
      activeTabId: selected.id, editorViews: { orientation, tabIds, weights: equalViewWeights(tabIds.length) },
      layout: { ...(previous.layout ?? DEFAULT_LAYOUT), resultsMaximized: false } }))
    focusEditor(selected.id)
  }
  function selectEditorView(owner: string, next: string) {
    if (!readyRef.current || sqlFiles.busy || closeId) return
    changeWorkspace(previous => ({ ...previous, activeTabId: next, editorViews: previous.editorViews && !previous.editorViews.tabIds.includes(next)
      ? { ...previous.editorViews, tabIds: previous.editorViews.tabIds.map(id => id === owner ? next : id) } : previous.editorViews }))
    focusEditor(next)
  }
  function hideEditorView(id: string) {
    if (!readyRef.current || sqlFiles.busy || closeId) return
    changeWorkspace(previous => {
      const views = previous.editorViews
      if (!views || !views.tabIds.includes(id)) return previous
      const remaining = views.tabIds.filter(item => item !== id)
      return { ...previous, activeTabId: previous.activeTabId === id ? remaining[0] : previous.activeTabId,
        editorViews: remaining.length > 1 ? { ...views, tabIds: remaining, weights: equalViewWeights(remaining.length) } : undefined }
    })
    focusEditor(workspaceRef.current.activeTabId)
  }
  function focusNextEditor(direction = 1) {
    const current = workspaceRef.current, views = current.editorViews
    if (!views) return
    const next = views.tabIds[(views.tabIds.indexOf(current.activeTabId) + direction + views.tabIds.length) % views.tabIds.length]
    activateEditor(next); focusEditor(next)
  }
  const viewBlocked = !ready || sqlFiles.busy || Boolean(closeId)
  const editorViewTools = [
    { label: 'Split editor side by side', action: () => splitEditors(tabId, 'vertical'), disabled: viewBlocked || (workspace.editorViews?.tabIds.length ?? 1) >= MAX_EDITOR_VIEWS },
    { label: 'Split editor stacked', action: () => splitEditors(tabId, 'horizontal'), disabled: viewBlocked || (workspace.editorViews?.tabIds.length ?? 1) >= MAX_EDITOR_VIEWS },
    { label: 'Arrange editors side by side', action: () => changeWorkspace(previous => ({ ...previous, editorViews: previous.editorViews && { ...previous.editorViews, orientation: 'vertical' } })), disabled: viewBlocked || !workspace.editorViews || workspace.editorViews.orientation === 'vertical' },
    { label: 'Arrange editors stacked', action: () => changeWorkspace(previous => ({ ...previous, editorViews: previous.editorViews && { ...previous.editorViews, orientation: 'horizontal' } })), disabled: viewBlocked || !workspace.editorViews || workspace.editorViews.orientation === 'horizontal' },
    { label: 'Focus next editor view (F6)', action: () => focusNextEditor(), disabled: viewBlocked || !workspace.editorViews },
    { label: 'Single editor view', action: () => { changeWorkspace(previous => ({ ...previous, editorViews: undefined })); focusEditor(tabId) }, disabled: viewBlocked || !workspace.editorViews }
  ]
  const inTransaction = Boolean(session && session.transaction !== 'idle')
  const operationBusy = !ready || tabOperationBusy(state)
  const connectionBlocked = operationBusy || Boolean(state.gridChanges.length) || inTransaction
  function openTransfer() {
    const editor = editorRef.current, selection = editor?.getSelection()
    setTransfer({ tabId, sessionId: session?.id, sql: selection && !selection.isEmpty() ? editor!.getModel()!.getValueInRange(selection) : sql })
  }
  function exportAllRows() {
    if (!session || operationBusy || !result?.columns.length) return
    setTransfer({ tabId, sessionId: session.id, sql: result.statement.trim(), sourceLabel: `Result ${result.index + 1} · ${resultCommand(result)} · ${resultCount(result)}` })
  }
  const queryTools = [
    { group: 'Run', label: session && ['sqlserver', 'azure-sql'].includes(session.engine) ? 'Run current batch' : 'Run current statement', action: runCurrent, disabled: !session || operationBusy },
    { group: 'Run', label: 'Run entire script', action: runScript, disabled: !session || operationBusy },
    { group: 'Compose and analyze', label: 'Explain selected SQL', action: openExplain, disabled: !session || operationBusy || Boolean(state.gridChanges.length) },
    { group: 'Compose and analyze', label: 'Visual query builder', action: () => session && setBuilderOpen({ tabId, sessionId: session.id }), disabled: !session || operationBusy },
    { group: 'Data and library', label: 'Data import and export', action: openTransfer },
    { group: 'Data and library', label: 'Query library', action: openLibrary }
  ]
  const workspaceTools = [
    { label: 'Workspace windows', action: () => setWindowsOpen(true), disabled: !ready },
    { label: 'Preferences', action: () => setEditorSettingsOpen(true), disabled: !ready }
  ]
  const profileConnections = profileConnectionStates(workspace.profiles, workspace.tabs, states, tabId)
  const connectionTabTools = [
    { label: 'New shared query tab', title: 'Shares this connection, transaction and temporary objects.', disabled: !ready || !session || workspace.tabs.length >= MAX_TABS || sqlFiles.busy || Boolean(closeId), action: () => newTab() },
    { label: 'New independent connection', title: 'Starts a separate transaction and temporary-object scope. In-memory databases start empty.', disabled: !ready || !session || workspace.tabs.length >= MAX_TABS || sqlFiles.busy || Boolean(closeId), action: () => newTab(undefined, undefined, 'independent') }
  ]

  return <div className="app-shell">
    <TitleBar api={api} appearance={theme}><ActionMenu label="Workspace" items={workspaceTools}/><div className="panel-controls" role="group" aria-label="Panel layout"><button id="toggle-sidebar" aria-label="Toggle sidebar" aria-pressed={layout.sidebarVisible} title={`${layout.sidebarVisible ? 'Hide' : 'Show'} sidebar (Cmd/Ctrl+B)`} disabled={!ready} onClick={() => layoutCommand('toggle-sidebar')}><PanelLeft size={16} /></button><button id="toggle-results" aria-label="Toggle results" aria-pressed={layout.resultsVisible} title={`${layout.resultsVisible ? 'Hide' : 'Show'} results (Cmd/Ctrl+J)`} disabled={!ready} onClick={() => layoutCommand('toggle-results')}><PanelBottom size={16} /></button></div><button className="command-button" aria-label="Commands" title="Search commands (Cmd/Ctrl+K)" onClick={() => setPalette(true)}><Search size={13} />Commands<kbd>{shortcutKey} K</kbd></button></TitleBar>
    <UpdateBanner api={api} />
    <AboutDialog api={api} />
    <div className="workspace-body" ref={workspaceBodyRef}>
      <nav className="activity-bar" aria-label="Workspace navigation"><button className={!historyView ? 'active' : ''} aria-label="Database explorer" title="Database explorer" onClick={() => showSidebar(false)}><Database size={20} /></button><button className={historyView ? 'active' : ''} aria-label="Query history" title="Query history" onClick={() => showSidebar(true)}><History size={20} /></button><button aria-label="Open SQL file" title="Open SQL file (Cmd/Ctrl+O)" disabled={sqlFiles.busy} onClick={openSql}><FolderOpen size={20} /></button><div className="activity-spacer" /><button aria-label="Application preferences" title="Application preferences" disabled={!ready} onClick={() => setEditorSettingsOpen(true)}><Settings2 size={20} /></button></nav>
      <aside id="workspace-sidebar" aria-label="Sidebar" className="sidebar" hidden={!layout.sidebarVisible} style={{ width: sidebarWidth }}>
        <div className="sidebar-title">{historyView ? 'History' : 'Connections'}<button aria-label={historyView ? 'History library settings' : 'New connection'} disabled={connectionBlocked} onClick={() => historyView ? openLibrary() : setDialog(true, true)}>{historyView ? <Settings2 size={15} /> : <Plus size={16} />}</button></div>
        {historyView ? <><button onClick={openLibrary}>Search history &amp; snippets</button><div className="history-list">{history.length ? history.map(item => <button key={item.id} onClick={() => newTab(undefined, { sql: item.sql, title: 'History.sql' })}><span className={`history-dot ${item.status}`} /><span><code>{item.sql.replace(/\s+/g, ' ').slice(0, 70)}</code><small>{item.connection} · <time dateTime={item.startedAt} title={new Date(item.startedAt).toLocaleString()}>{new Date(item.startedAt).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></small></span></button>) : <p className="sidebar-description">No query history.</p>}</div></> : <>
          <ProfileList profiles={workspace.profiles} connections={profileConnections} activeProfileId={tab.profileId} full={workspace.tabs.length >= MAX_TABS} ready={ready && !sqlFiles.busy && !closeId && !profileLibrary.busy && !profileBusy} onNew={() => { setDialogError(''); setDialogInfo({ tabId, profile: INITIAL_PROFILE, saveOnly: true }) }} onOpen={(profile, independent) => newTab(profile, undefined, independent ? 'independent' : 'shared')}
            onSwitch={profile => { const ids = profileConnections.get(profile.id)?.tabIds; if (ids?.length) activateEditor(ids.includes(tabId) ? tabId : ids[0]) }}
            onDuplicate={profileLibrary.duplicate} onImport={() => void profileLibrary.importProfiles()} onExport={profile => void profileLibrary.exportProfiles(profile)}
            onDisconnect={savedProfile => void disconnectTabs(workspaceRef.current.tabs.filter(tab => tab.profileId === savedProfile.id).map(tab => tab.id))}
            onEdit={savedProfile => { setDialogError(''); setDialogInfo({ tabId, profile: savedProfile.config, profileId: savedProfile.id, saveOnly: true }) }}
            onDelete={savedProfile => { setDialogError(''); setDeleteProfileId(savedProfile.id) }}
            onFavorite={(id, favorite) => changeWorkspace(previous => ({ ...previous, profiles: previous.profiles.map(profile => profile.id === id ? { ...profile, config: { ...profile.config, favorite } } : profile) }))}/>
          {session ? <DatabaseExplorer browseDisabled={!ready || sqlFiles.busy || Boolean(closeId) || workspace.tabs.length >= MAX_TABS} onActivity={()=>setActivityOpen({tabId,sessionId:session.id})} onBuilder={table=>setBuilderOpen({tabId,sessionId:session.id,table})} onCompareData={table=>session&&setDataCompareOpen({tabId,sessionId:session.id,table})} key={tabId} state={state} onBackup={()=>setBackupOpen(true)} onCompare={()=>setCompareOpen({tabId,sessionId:session.id})} onDiagram={() => setDiagramOpen({tabId,sessionId:session.id})} onSchemaChange={target => setSchemaEditor({ tabId, sessionId: session.id, target })} onInspect={object => void inspectObject(object)} onRefreshDatabases={() => void refreshDatabases()} onRefreshSchema={() => void refreshTables()} onSwitch={requestSwitch} onFilter={setTableSearch} onAppendSelect={appendSelect} onEdit={table => void openGrid(table)} onBrowse={table => void browseTable(table)} /> : <p className="sidebar-description">Connect to load databases.</p>}
        </>}
      </aside>
      {layout.sidebarVisible && <Splitter orientation="vertical" label="Resize sidebar" controls="workspace-sidebar" value={sidebarWidth} preferredValue={layout.sidebarWidth} min={bounds.sidebarMin} max={bounds.sidebarMax} disabled={!ready}
        onChange={sidebarWidth => changeLayout(layout => ({ ...layout, sidebarWidth }))} onToggle={() => layoutCommand('toggle-sidebar')} onReset={() => changeLayout(layout => ({ ...layout, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth }))} />}
      <main className="main-workspace">
        {session && <SessionSafetyBar key={session.id} session={session} onChange={safety => { const current = statesRef.current[tabId]; if (current.session?.id === session.id) patchState(tabId, { session: { ...current.session, safety } }) }}/>}
        <div className="editor-tabs"><QueryTabStrip tabs={workspace.tabs} activeId={tabId} states={states} disabled={!ready || sqlFiles.busy || Boolean(closeId)} closeDisabled={sqlFiles.busy}
          dirty={sqlFiles.dirty} path={id => sqlFiles.files[id]?.path} onSelect={activateEditor} onClose={requestClose} onSplit={splitEditors} splitDisabled={(workspace.editorViews?.tabIds.length ?? 1) >= MAX_EDITOR_VIEWS}
          onPin={pinTab}
          onMove={(id, index) => changeWorkspace(previous => ({ ...previous, tabs: moveTab(previous.tabs, id, index) }))}/>
        <button aria-label="New query tab" title="New query tab (Cmd/Ctrl+T) · Shares the current connection" disabled={!ready || sqlFiles.busy || Boolean(closeId) || workspace.tabs.length >= MAX_TABS} onClick={() => newTab()}><Plus size={16} /></button><ActionMenu label="Connection tabs" items={connectionTabTools}/><ActionMenu label="Editor views" items={editorViewTools}/></div>
        <ConnectionSessionBar tabs={workspace.tabs} states={states} activeId={tabId} onSwitch={activateEditor}/>
        <div className="query-toolbar"><button className="run-button" title={`Run selected SQL, or the entire script when nothing is selected (${keyHint('run')})`} disabled={!session || operationBusy} onClick={() => void run()}><Play size={13} fill="currentColor" />Run SQL{editorKeys.run !== 'none' && <kbd>{keyHint('run')}</kbd>}</button><button className="stop-button" disabled={!running} onClick={() => { if (session) { setStatus('Cancellation requested'); void api.cancel(session.id).catch(report) } }}><Square size={12} />Stop</button><button aria-label="Format SQL" title={`Format selection or document (${keyHint('format')})`} onClick={() => void formatEditor(editorRef.current)}>Format SQL</button><ActionMenu key={tabId} label="Query tools" items={queryTools}/><span className="toolbar-separator" /><span className="target-label" title={session?.database || 'No database selected'}><Database size={13} /><span>{session ? session.database || 'Server connection' : 'No connection'}</span></span><div className="tabs-spacer" />{session ? <div className="transaction-controls"><span role="status" aria-label="Transaction status" className={`transaction-badge ${session.transaction}`}>{session.transaction === 'idle' ? (session.autocommit === false ? 'Manual commit mode' : 'Autocommit') : session.transaction === 'failed' ? 'Transaction failed' : session.transaction === 'transaction' ? 'In transaction' : 'State unknown'}</span>{inTransaction ? <><button disabled={operationBusy || session.transaction === 'failed' || session.transaction === 'unknown'} onClick={() => void run('COMMIT')}>Commit</button><button disabled={operationBusy} onClick={() => void run('ROLLBACK')}>Rollback</button></> : <button disabled={operationBusy} onClick={() => void run(session.engine === 'oracle' ? 'SAVEPOINT DBCOMMANDER_BEGIN' : ['sqlserver', 'azure-sql'].includes(session.engine) ? 'BEGIN TRANSACTION' : 'BEGIN')}>Begin</button>}<button title="Disconnect" aria-label="Disconnect" disabled={connectionBlocked} onClick={disconnect}><Unplug size={14} /></button></div> : <button className="connect-button" onClick={() => setDialog(true)}><Plus size={13} />Connect database</button>}</div>
        {error && <div className="error-banner" role="alert" aria-label="Application error"><span>{error}</span>{state.execution && state.failure && <button className="sql-error-link" disabled={!errorSource(state.execution, state.failure, sql)} title={state.execution.document !== sql ? 'SQL changed since this execution. Run again to locate the error.' : 'Select the submitted SQL that failed; no SQL will be executed.'} onClick={showSqlError}>{state.execution.document !== sql ? 'SQL changed since execution' : state.failure.scope === 'statement' ? 'Go to failed statement' : state.failure.scope === 'batch' ? 'Go to failed batch' : 'Go to executed SQL'}</button>}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
        {sqlFiles.notice && <div className="sql-file-notice" role="status">{sqlFiles.notice}</div>}
        {sqlFiles.files[tabId] && <div className="sql-file-bar" aria-label="SQL file status"><span title={sqlFiles.files[tabId].path}>{sqlFiles.files[tabId].path}</span><strong>{sqlFiles.dirty(tab) ? 'Unsaved changes' : 'Saved to file'}</strong></div>}
        {sqlFiles.files[tabId] && sqlFiles.files[tabId].external !== 'unchanged' && <div className="sql-file-notice" role="status"><span>{sqlFiles.files[tabId].external === 'missing' ? 'File removed from disk.' : sqlFiles.files[tabId].external === 'changed' ? 'File changed on disk.' : 'File cannot be read.'} Your editor buffer has been kept.</span><button disabled={sqlFiles.busy || sqlFiles.files[tabId].external === 'missing'} onClick={() => void sqlFiles.reload()}>Reload from disk</button><button disabled={sqlFiles.busy} onClick={() => void sqlFiles.save(tabId, true)}>Save As…</button></div>}
        <div className="query-panes" ref={queryPanesRef}>
        <section hidden={layout.resultsMaximized} id="query-panel" role="tabpanel" aria-labelledby={`tab-${tabId}`} className="editor-region" aria-label="SQL workspace"><QueryEditorViews theme={theme} tabs={workspace.tabs} activeId={tabId} views={workspace.editorViews} states={states} settings={editorSettings}
          ready={ready} blocked={sqlFiles.busy || Boolean(closeId)} dirty={sqlFiles.dirty} path={id => sqlFiles.files[id]?.path}
          onActivate={activateEditor} onSelect={selectEditorView} onHide={hideEditorView} onReady={registerEditor} onRun={runEditor}
          onResize={(index, weight) => changeWorkspace(previous => ({ ...previous, editorViews: previous.editorViews ? resizeEditorViews(previous.editorViews, index, weight) : undefined }))}
          onError={(id, error) => patchState(id, { error, failure: undefined })} onChange={(id, sql) => patchTab(id, { sql })} /></section>
        {layout.resultsVisible && !layout.resultsMaximized && <Splitter orientation="horizontal" label="Resize results" controls="execution-output" value={resultsHeight} preferredValue={layout.resultsHeight} min={bounds.resultsMin} max={bounds.resultsMax} disabled={!ready}
          onChange={resultsHeight => changeLayout(layout => ({ ...layout, resultsHeight }))} onToggle={() => layoutCommand('toggle-results')} onReset={() => changeLayout(layout => ({ ...layout, resultsHeight: DEFAULT_LAYOUT.resultsHeight }))} />}
        <section id="execution-output" tabIndex={-1} hidden={!layout.resultsVisible} className={`results-region ${layout.resultsMaximized ? 'maximized' : ''}`} style={layout.resultsMaximized ? undefined : { height: resultsHeight }} aria-label="Execution output"><div className="results-toolbar"><button aria-pressed={!showMessages} className={!showMessages ? 'selected' : ''} onClick={() => setShowMessages(false)}><Table2 size={14} />Results{(state.grid || result) && <span className="count">{state.grid?.rows.length ?? result?.rows.length}</span>}</button><button aria-pressed={showMessages} className={showMessages ? 'selected' : ''} onClick={() => setShowMessages(true)}><Terminal size={14} />Messages{messages.length > 0 && <span className="count">{messages.length}</span>}</button><div className="tabs-spacer" />{duration !== null && <span className="execution-time"><Activity size={12} />{duration} ms</span>}{!state.grid && !showMessages && <><button disabled={operationBusy || !result?.columns.length || !queryId} title="Export every fetched preview row to CSV without running SQL again; local filters, sorting and comparison panes do not change this cached export" onClick={() => void exportCsv()}><ArrowDownToLine size={14} />Export preview</button><button disabled={operationBusy || !session || !result?.columns.length} title="Review a single query before running it again to export all rows" onClick={exportAllRows}>Export all rows</button></>}<button aria-label={layout.resultsMaximized ? 'Restore editor and results' : 'Maximize results'} title="Maximize / restore results (Cmd/Ctrl+Shift+J)" disabled={!ready} onClick={() => layoutCommand('maximize-results')}>{layout.resultsMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button><button aria-label="Hide results" title="Hide results (Cmd/Ctrl+J)" disabled={!ready} onClick={() => layoutCommand('toggle-results')}><X size={14} /></button></div>
          {!state.grid && !showMessages && <ResultTabs results={results} selected={activeResult} onSelect={setActiveResult} />}
          {showMessages ? <div className="messages-panel"><div className="message-status" data-status={status}>{status}{duration !== null ? ` in ${duration} ms` : ''}</div>{messages.map((message, index) => <pre key={index}>{message}</pre>)}</div> : state.grid ? <TableData key={`${tabId}:${JSON.stringify(state.grid.table)}`} grid={state.grid} changes={state.gridChanges} disconnected={!session} busy={operationBusy} expired={state.gridExpired} transaction={inTransaction} onChange={gridChanges => patchState(tabId, { gridChanges })} onApply={() => void applyGrid()} onLoad={(query, mode) => void openGrid(state.grid!.table, mode, query)} onClose={() => patchState(tabId, { grid: null, gridBack: [] })} view={state.columnViews?.[tableViewKey]} savedColumns={savedTableColumns()} onView={view=>saveColumnView(tableViewKey,view)} onBack={state.gridBack?.length?()=>void backGrid():undefined} actions={{load:async(row,column)=>(await inspectGrid('inspect-cell',row,column)).inspection!,references:async()=>(await inspectGrid('foreign-keys')).references!,follow:async(row,id)=>{await inspectGrid('follow-reference',row,0,id)}}} /> : null}
        <ResultWorkspace hidden={showMessages || Boolean(state.grid)} result={result} results={results} sourceKey={`${tabId}:${queryId ?? "none"}`} sourceLabel={state.resultSource ?? tab.title} partial={running || Boolean(state.resultPartial)} view={state.columnViews?.[resultViewKey]} onView={view => saveColumnView(resultViewKey, view)} empty={<div className="results-empty"><h2>{running ? 'Running…' : 'No results'}</h2><p>{running ? 'Use Stop to cancel.' : session ? `Run SQL${editorKeys.run === 'none' ? '' : ` (${keyHint('run')})`} or browse a table.` : 'Connect to a database to run SQL.'}</p></div>}/>
        </section>
        </div>
      </main>
    </div>
    <footer className="statusbar">
      {session && !['sqlite', 'duckdb'].includes(session.engine) && <span>{session.tls ? <><LockKeyhole size={11} />TLS verified</> : 'TLS disabled'}</span>}
      <span className={`status-text${status === 'Connected' ? ' sr-only' : ''}`} role="status" aria-label="Execution status">{status}</span>
      <div className="tabs-spacer" />
      <span title={workspaceLoadError || saveError || undefined}>{!ready ? workspaceLoadError ? 'Workspace not loaded' : 'Loading workspace…' : saveError ? 'Workspace not saved' : saved ? <><Check size={11} />Saved locally</> : 'Saving workspace…'}</span>
      <span className="sr-only" role="status" aria-label="Workspace save">{saveAnnouncement}</span>
      {saveError && <button onClick={() => void persist().catch(error => report(error, workspaceRef.current.activeTabId))}>Retry workspace save</button>}
      <span className="dialect-label" title={session ? `${session.name} / ${session.database || 'Server connection'}` : 'Not connected'}>{hasConfiguredConnection(tab, session) ? engineNames[session?.engine ?? profile.engine] : 'SQL'}</span>
    </footer>
    {explainText !== null && session && <ExplainDialog key={session.id} session={session} sql={explainText} previous={state.plan} onRun={explainQuery} onClose={() => setExplainText(null)} />}
    {transfer?.tabId === tabId && transfer.sessionId === session?.id && <TransferDialog key={`${tabId}:${transfer.sourceLabel ?? 'editor'}`} session={session} tables={state.tables.filter(table => table.kind === 'table')} sql={transfer.sql} sourceLabel={transfer.sourceLabel} jobs={transferJobs} blocked={!session || tabOperationBusy(state) || Boolean(state.gridChanges.length) || inTransaction || session.engine !== 'oracle' && session.autocommit === false} onClose={() => setTransfer(null)} />}
    {schemaEditor?.tabId === tabId && schemaEditor.sessionId === session?.id && session && <SchemaChangeDialog key={`${tabId}:${session.id}`} session={session} snapshot={state.schema} initialTarget={schemaEditor.target} blocked={schemaChangeBlocked()} onClose={() => setSchemaEditor(null)} onPrepare={prepareSchemaChange} onApply={applySchemaChange} />}
    {activityOpen?.tabId===tabId && activityOpen.sessionId===session?.id && <ActivityDialog key={session.id} session={session} onClose={()=>setActivityOpen(null)}/>}
    {builderOpen?.tabId===tabId && builderOpen.sessionId===session?.id && <QueryBuilderDialog key={session.id} session={session} snapshot={state.schema} initialTable={builderOpen.table} blocked={schemaChangeBlocked() ?? (!session.database ? 'Select a database before reviewing builder SQL.' : undefined)} onClose={()=>setBuilderOpen(null)} onRefresh={async()=>{await refreshTables(tabId,session.id);const error=statesRef.current[tabId]?.schemaError;if(error)throw new Error(error)}} onReview={async query=>{
      const id=session.id;patchState(tabId,{schemaLoading:true})
      try{return await api.prepareQueryBuilder({sessionId:id,query})}finally{if(statesRef.current[tabId]?.session?.id===id)patchState(tabId,{schemaLoading:false});cleanupLostSession(id)}
    }} onOpen={sql=>{if(workspaceRef.current.tabs.length>=MAX_TABS||workspaceRef.current.tabs.reduce((size,tab)=>size+tab.sql.length,sql.length)>5_000_000)throw new Error('Close a query tab or shorten SQL buffers before opening builder SQL.');newTab(undefined,{sql,title:'visual-query.sql'});setBuilderOpen(null)}}/>}
    {dataCompareOpen?.tabId===tabId && dataCompareOpen.sessionId===session?.id && <DataCompareDialog key={session.id} target={session} initialTable={dataCompareOpen.table} tabs={workspace.tabs.map(tab=>({id:tab.id,title:tab.title,state:states[tab.id]})).filter(tab=>tab.state)} onClose={()=>setDataCompareOpen(null)} load={async request=>{
      const owners=Object.entries(statesRef.current).filter(([,s])=>s.session&&[request.source.sessionId,request.target.sessionId].includes(s.session.id))
      for(const [id] of owners)patchState(id,{schemaLoading:true})
      try{return await api.compareData(request)}finally{for(const [id,previous] of owners){if(statesRef.current[id]?.session?.id===previous.session?.id)patchState(id,{schemaLoading:false})}}
    }}/>}
    {compareOpen?.tabId===tabId && compareOpen.sessionId===session?.id && <SchemaCompareDialog key={session.id} target={session} tabs={workspace.tabs.map(tab=>({id:tab.id,title:tab.title,state:states[tab.id]})).filter(tab=>tab.state)} onClose={()=>setCompareOpen(null)} load={async request=>{
      const owners=Object.entries(statesRef.current).filter(([,s])=>s.session&&[request.source.sessionId,request.target.sessionId].includes(s.session.id))
      for(const [id] of owners)patchState(id,{schemaLoading:true})
      try{return await api.compareSchemas(request)}finally{for(const [id,previous] of owners){if(statesRef.current[id]?.session?.id===previous.session?.id)patchState(id,{schemaLoading:false});cleanupLostSession(previous.session!.id)}}
    }} onOpen={sql=>{if(workspace.tabs.length>=MAX_TABS||workspace.tabs.reduce((size,tab)=>size+tab.sql.length,sql.length)>5_000_000){report(new Error('Close a tab or shorten SQL buffers before opening comparison SQL.'));return};setCompareOpen(null);newTab(undefined,{sql,title:'schema-comparison.sql'})}}/>}
    {diagramOpen?.tabId===tabId && diagramOpen.sessionId===session?.id && <DiagramDialog key={session.id} initialTables={state.schema?.catalog?.objects??[]} title={`${session.name} · ${session.database}`} onClose={()=>setDiagramOpen(null)} load={async scope=>{const id=session.id;patchState(tabId,{schemaLoading:true});try{return await api.diagram({sessionId:id,...scope})}finally{if(statesRef.current[tabId]?.session?.id===id)patchState(tabId,{schemaLoading:false});cleanupLostSession(id)}}}/>}
    {objectView && objectView.tabId === tabId && objectView.sessionId === session?.id && <ObjectInspector view={objectView} onClose={() => setObjectView(null)} onRefresh={() => void inspectObject(objectView.object)} onOpen={(sql, title) => { if (workspace.tabs.length >= MAX_TABS || workspace.tabs.reduce((size, tab) => size + tab.sql.length, sql.length) > 5_000_000) { setObjectView({ ...objectView, error: 'Close a query tab or save and shorten a SQL buffer before opening this definition. The workspace supports 20 tabs and 5 MB of SQL.' }); return }; setObjectView(null); newTab(undefined, { sql, title }) }} />}
    {backupOpen && <BackupDialog key={session?.id ?? 'disconnected'} session={session} jobs={backupJobs} blocked={!session || tabOperationBusy(state) || Boolean(state.gridChanges.length) || inTransaction || session.engine !== 'oracle' && session.autocommit === false} onClose={() => setBackupOpen(false)} />}
    {dialogInfo && <ConnectionDialog key={`${dialogInfo.tabId}:${dialogInfo.saveOnly}`} profile={dialogInfo.profile} profileId={dialogInfo.profileId} saveOnly={dialogInfo.saveOnly} busy={Boolean(states[dialogInfo.tabId]?.connecting) || profileBusy} error={dialogError} onClose={() => setDialog(false)} onConnect={async (config, save, choice) => { await connect(config, save, undefined, choice) }} onSave={saveProfile} />}
    {profileLibrary.preview && <ProfileImportDialog preview={profileLibrary.preview} existing={workspace.profiles} busy={profileLibrary.busy} onImport={profileLibrary.apply} onClose={profileLibrary.close}/>}
    {connectionWarning && <ModalDialog className="confirmation-dialog" aria-label="Connection failed" onDismiss={() => setConnectionWarning(null)}>
      <h2>Could not connect to {connectionWarning.name}</h2><p role="alert">{connectionWarning.error}</p>
      <p>Check the saved connection details and credentials, then try again.</p>
      <div className="dialog-actions"><button autoFocus onClick={() => setConnectionWarning(null)}>OK</button><button onClick={() => {
        const saved = workspaceRef.current.profiles.find(profile => profile.id === connectionWarning.profileId)
        if (saved) { setDialogError(''); setDialogInfo({ tabId: workspaceRef.current.tabs.some(tab => tab.id === connectionWarning.tabId) ? connectionWarning.tabId : workspaceRef.current.activeTabId, profile: saved.config, profileId: saved.id, saveOnly: true }) }
        setConnectionWarning(null)
      }}>Edit connection</button></div>
    </ModalDialog>}
    {switchTarget && <ModalDialog className="confirmation-dialog" aria-label="Switch database" onDismiss={() => { if (!states[switchTarget.tabId]?.switching) setSwitchTarget(null) }}><h2>Switch to {switchTarget.database}?</h2><p>This opens a fresh connection for this tab. Temporary tables and session settings will be lost. Your SQL buffer and other tabs are preserved. If the target connection fails, this tab keeps its current session.</p><div className="dialog-actions"><button autoFocus disabled={states[switchTarget.tabId]?.switching} onClick={() => setSwitchTarget(null)}>Keep current database</button><button className="primary-button" disabled={states[switchTarget.tabId]?.switching} onClick={() => void switchDatabase()}>{states[switchTarget.tabId]?.switching ? 'Switching…' : 'Switch database'}</button></div></ModalDialog>}
    {sqlFiles.recentOpen && <RecentSqlFiles error={sqlFiles.error} files={sqlFiles.recent} busy={sqlFiles.busy} onOpen={id => void sqlFiles.open(id)} onClear={() => void sqlFiles.clearRecent()} onClose={() => sqlFiles.setRecentOpen(false)}/>}
    {closeRequest?.confirm && <ModalDialog className="confirmation-dialog" aria-label={closeRequest.ids.length === 1 ? 'Close query tab' : 'Close query tabs'} onDismiss={() => { if (!sqlFiles.busy && !closeOperation.current) setCloseRequest(null) }}>
      <h2>{closeRequest.ids.length === 1 ? 'Close query tab?' : `Close ${closeRequest.ids.length} query tabs?`}</h2>{sqlFiles.error && <p role="alert">{sqlFiles.error}</p>}
      <p>{closeRequest.ids.length === 1 ? 'Close tab discards this tab’s SQL buffer and results from workspace recovery. Unsaved file edits will be lost. Choose Save and close to keep the SQL in a file.' : 'Closing these tabs discards their SQL buffers and results from workspace recovery. Unsaved file edits will be lost. Save any SQL you want to keep before closing. Pinned tabs stay open.'}</p>
      <div className="dialog-actions"><button autoFocus disabled={sqlFiles.busy || closingTabs} onClick={() => setCloseRequest(null)}>{closeRequest.ids.length === 1 ? 'Keep tab' : 'Keep tabs'}</button>
        {closeRequest.ids.length === 1 && <button disabled={sqlFiles.busy || closingTabs} onClick={() => { const id = closeRequest.ids[0]; void sqlFiles.save(id).then(saved => { if (saved) void closeTabs([id]) }) }}>Save and close</button>}
        <button className="primary-button" disabled={sqlFiles.busy || closingTabs} onClick={() => void closeTabs()}>{closeRequest.ids.length === 1 ? 'Close tab' : 'Close tabs'}</button></div>
    </ModalDialog>}
    {deleteProfileId && <ModalDialog className="confirmation-dialog" aria-label="Delete saved profile" onDismiss={() => { if (!profileBusy) setDeleteProfileId(null) }}><h2>Delete saved profile?</h2><p>Open tabs keep their current connections and transactions. Their connection details remain available in tab recovery. Any saved password is removed from the operating system credential store.</p>{dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}<div className="dialog-actions"><button autoFocus disabled={profileBusy} onClick={() => setDeleteProfileId(null)}>Keep profile</button><button className="primary-button" disabled={profileBusy} onClick={() => void deleteProfile()}>Delete profile</button></div></ModalDialog>}
    {librarySql!==undefined&&<QueryLibrary sql={librarySql} engine={session?.engine??profile.engine} onClose={()=>setLibrarySql(undefined)} onChanged={()=>void api.history().then(setHistory).catch(report)} onOpen={(sql,title)=>{if(workspace.tabs.length>=MAX_TABS||workspace.tabs.reduce((size,tab)=>size+tab.sql.length,sql.length)>5_000_000)throw new Error('Close a query tab or save and shorten a SQL buffer. The workspace supports 20 tabs and 5 MB of SQL.');newTab(undefined,{sql,title});setLibrarySql(undefined)}}/>}
    {parameterRun&&<ParameterDialog engine={statesRef.current[parameterRun.tabId]?.session?.engine} sql={parameterRun.sql} names={parameterRun.names} onClose={()=>setParameterRun(undefined)} onRun={async values=>{if(tabId!==parameterRun.tabId||statesRef.current[tabId]?.session?.id!==parameterRun.sessionId)throw new Error('The target session changed. Close this dialog and run again.');await run(parameterRun.sql,values,parameterRun.source);setParameterRun(undefined)}}/>}
    {windowsOpen && <WorkspaceWindowsDialog onClose={() => setWindowsOpen(false)}/>}
    {editorSettingsOpen && <EditorSettingsDialog settings={editorSettings} onClose={() => setEditorSettingsOpen(false)} onApply={async settings => { await applyPreferences(settings); changeWorkspace(previous => ({ ...previous, editorSettings: settings })) }}/>}
    {palette && <CommandPalette onClose={() => setPalette(false)} commands={[
      { label: 'New query tab', action: () => newTab(), disabled: !ready || workspace.tabs.length >= MAX_TABS },
      ...connectionTabTools,
      ...connectionGroups(workspace.tabs, states).flatMap(group => group.tabs.map((tab, index) => ({ label: `Switch to ${group.session.name} · Connection ${group.number} · ${index + 1}. ${tab.title}`, keywords: `${group.session.host} ${group.session.database} ${group.session.user}`, action: () => activateEditor(tab.id) }))),
      { label: 'Import connections', action: () => void profileLibrary.importProfiles(), disabled: !ready || profileLibrary.busy },
      { label: 'Export connections without credentials', action: () => void profileLibrary.exportProfiles(), disabled: !ready || profileLibrary.busy || !workspace.profiles.length },
      { label: tab.pinned ? 'Unpin query tab' : 'Pin query tab', keywords: 'keep protect close', action: () => pinTab(tabId, !workspaceRef.current.tabs.find(tab => tab.id === tabId)?.pinned), disabled: !ready || sqlFiles.busy || Boolean(closeId) },
      { label: 'Connect to a database', action: () => setDialog(true), disabled: connectionBlocked },
      { label: 'Run selection or script', action: () => void run(), disabled: !session || operationBusy },
      { label: 'Format SQL', action: () => void formatEditor(editorRef.current) },
      { label: 'Open SQL file', action: () => void openSql() },
      { label: 'Save SQL file', action: () => void saveSql() },
      { label: 'Save SQL file as', action: () => void sqlFiles.save(tabId, true) },
      { label: 'Recent SQL files', action: () => sqlFiles.setRecentOpen(true) },
      ...editorViewTools,
      ...[...queryTools, ...workspaceTools].map(command => ({ ...command, ...(command.label === 'Query library' ? { keywords: 'history snippets favorites retention' } : command.label === 'Preferences' ? { keywords: 'preferences font size wrap line numbers minimap suggestions completion indentation tabs spaces formatting database engine style defaults import export theme dark light appearance keyboard shortcuts' } : {}) })),
      { label: 'Database backup and restore', action: () => setBackupOpen(true) },
      { label: 'Sessions and locks', action: () => session && setActivityOpen({tabId,sessionId:session.id}), disabled: !session || state.closing || state.switching },
      { label: 'Compare table data', action: () => session && setDataCompareOpen({tabId,sessionId:session.id}), disabled: !session || operationBusy },
      { label: 'Compare schemas', action: () => session && setCompareOpen({tabId,sessionId:session.id}), disabled: !session || operationBusy },
      { label: 'Schema changes', action: () => session && setSchemaEditor({tabId,sessionId:session.id}), disabled: !session || operationBusy },
      { label: 'ER diagram', action: () => session && setDiagramOpen({tabId,sessionId:session.id}), disabled: !session || operationBusy },
      { label: 'Show query history', action: () => showSidebar(true) },
      ...layoutCommands.map(command => ({ label: `${command.label} (${command.hint})`, action: () => layoutCommand(command.id), disabled: !ready }))
    ]}/>}
  </div>
}
