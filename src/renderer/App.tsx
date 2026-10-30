import { useJobFeed } from './use-job-feed'
import { useWorkspaceRecovery } from './use-workspace-recovery'
import { TitleBar } from './TitleBar'
import { UpdateBanner } from './UpdateBanner'
import { AboutDialog } from './AboutDialog'
import { ModalDialog } from './ModalDialog'
import { useSqlFiles } from './use-sql-files'
import { errorSource } from '../shared/execution'
import { RecentSqlFiles } from './RecentSqlFiles'
import { ActionMenu } from './ActionMenu'
import { QueryTabStrip } from './QueryTabStrip'
import { moveTab } from '../shared/tab-order'
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
import { ExplainDialog } from './ExplainDialog'
import { tableColumnViewKey } from '../shared/table-layouts'
import { ObjectInspector } from './ObjectInspector'
import { ConnectionDialog } from './ConnectionDialog'
import { ProfileList } from './ProfileList'
import { profileConnectionStates } from './profile-connections'
import { SessionSafetyBar } from './SessionSafetyBar'
import { SchemaChangeDialog } from './SchemaChangeDialog'
import { BackupDialog } from './BackupDialog'
import { TransferDialog } from './TransferDialog'
import { ResultTabs } from './ResultTabs'
import { resultCommand, resultCount } from './result-navigation'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { PanelLeft, PanelBottom, Maximize2, Minimize2, Search, Activity, ArrowDownToLine, Check, Database, FolderOpen, History, LockKeyhole, Play, Plus, Settings2, Square, Table2, Terminal, Unplug, X } from './WorkbenchIcons'
import { MAX_TABS, engineNames, type Workspace, type WorkspaceTab } from '../shared/contracts'
import { QueryEditorViews } from './QueryEditorViews'
import { equalViewWeights, MAX_EDITOR_VIEWS, reconcileEditorViews, resizeEditorViews, type EditorViews } from '../shared/editor-views'
import { flushSync } from 'react-dom'
import { formatEditor } from './language-service'
import { DEFAULT_LAYOUT, applyLayoutCommand, clampSize, panelBounds, layoutCommands, type LayoutCommand, type WorkspaceLayout } from '../shared/layout'
import { hasConfiguredConnection } from '../shared/connection-profiles'
import { Splitter } from './Splitter'
import { useElementSize } from './use-element-size'
import { DatabaseExplorer } from './DatabaseExplorer'
import { TableData } from './TableData'
import type { GridTable } from '../shared/contracts'
import { ResultWorkspace } from './ResultWorkspace'
import { tabOperationBusy, emptyTabState } from './query-tabs'
import { connectionGroups } from './shared-sessions'
import { ConnectionSessionBar } from './ConnectionSessionBar'
import { ProfileImportDialog } from './ProfileImportDialog'
import { useProfileLibrary } from './use-profile-library'
import { INITIAL_PROFILE, INITIAL_SQL } from './starter-sql'
import { useQueryExecution } from './use-query-execution'
import { useSchemaTools } from './use-schema-tools'
import { useTabRuntime } from './use-tab-runtime'
import { useTableData } from './use-table-data'
import { editableQueryTable } from './editable-query'
import { useWorkspaceSessions } from './use-workspace-sessions'
import { useWorkspaceTabs } from './use-workspace-tabs'
import type { WorkspaceRuntime } from './workspace-runtime'

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
  const { states, statesRef, changeStates, patchState, report } = useTabRuntime(workspaceRef)
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

  const [activityOpen,setActivityOpen]=useState<{tabId:string;sessionId:string}|null>(null)
  const [builderOpen,setBuilderOpen]=useState<{tabId:string;sessionId:string;table?:GridTable}|null>(null)
  const [dataCompareOpen,setDataCompareOpen]=useState<{tabId:string;sessionId:string;table?:GridTable}|null>(null)
  const [compareOpen,setCompareOpen]=useState<{tabId:string;sessionId:string}|null>(null)
  const [diagramOpen,setDiagramOpen]=useState<{tabId:string;sessionId:string}|null>(null)

  const [backupOpen, setBackupOpen] = useState(false)

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

  function openLibrary(){const editor=editorRef.current,selection=editor?.getSelection();setLibrarySql(selection&&!selection.isEmpty()?editor!.getModel()!.getValueInRange(selection):workspaceRef.current.tabs.find(t=>t.id===workspaceRef.current.activeTabId)!.sql)}
  const [historyView, setHistoryView] = useState(false)

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

  function patchTab(id: string, patch: Partial<WorkspaceTab>) {
    changeWorkspace(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab) }))
  }

  const setError = (error: string) => patchState(tabId, { error })
  const setStatus = (status: string) => patchState(tabId, { status })

  const setActiveResult = (activeResult: number) => patchState(tabId, { activeResult, resultSelectionChanged: true })
  const setShowMessages = (showMessages: boolean) => patchState(tabId, { showMessages, resultSelectionChanged: true })
  const setTableSearch = (tableSearch: string) => patchState(tabId, { tableSearch })

  const runtime: WorkspaceRuntime = { workspaceRef, statesRef, changeStates, patchState, changeWorkspace, patchTab, persist, report }
  const sqlFiles = useSqlFiles({ workspace, workspaceRef, ready, changeWorkspace, patchTab, persist, report })
  const sessions = useWorkspaceSessions({ api, runtime, tab, readyRef, sqlFiles, editorSettings })
  const { dialogInfo, setDialogInfo, dialogError, setDialogError, connectionWarning, setConnectionWarning,
    profileBusy, deleteProfileId, setDeleteProfileId, switchTarget, setSwitchTarget, setDialog,
    connect, saveProfile, deleteProfile, disconnect, disconnectTabs, requestSwitch, switchDatabase,
    refreshTables, refreshDatabases, cleanupLostSession } = sessions
  const { closeRequest, setCloseRequest, closeId, closingTabs, closeOperation, newTab, pinTab, requestClose, closeTabs } =
    useWorkspaceTabs({ api, runtime, ready, editorSettings, sqlFiles, sessions })
  const { history, setHistory, explainText, setExplainText, parameterRun, setParameterRun, openExplain, explainQuery,
    run, runCurrent, runScript, exportCsv } = useQueryExecution({ api, runtime, tab, editorRef, sessions })
  const { appendSelect, openGrid, browseTable, saveColumnView, savedTableColumns, inspectGrid, backGrid, applyGrid, previewGrid } =
    useTableData({ api, runtime, workspace, tab, ready, readyRef, editors, sqlFiles, closeId, newTab, changeLayout, focusEditor })
  const { objectView, setObjectView, schemaEditor, setSchemaEditor, inspectObject, schemaChangeBlocked, prepareSchemaChange, applySchemaChange } =
    useSchemaTools({ api, runtime, tabId, setHistory, sessions })
  const dialog = Boolean(dialogInfo)
  const profileLibrary = useProfileLibrary({ api, workspaceRef, changeWorkspace, persist, report, notice: setStatus,
    onDraft: profile => { setDialogError(''); setDialogInfo({ tabId: workspaceRef.current.activeTabId, profile, saveOnly: true }) } })

  const receiveLayoutCommand = useEffectEvent(layoutCommand)

  const saveRequested = useEffectEvent(async () => {
      // Edits remain possible while a save is pending. A close acknowledgment
      // must cover the latest buffer, including edits before autosave's debounce.
      let snapshot: Workspace
      do { snapshot = workspaceRef.current; await persist() } while (workspaceRef.current !== snapshot)
      if (Object.values(statesRef.current).some(state => state.gridChanges.length || state.gridBusy)) throw new Error('Staged table edits are not saved.')
  })
  useEffect(() => {
    const offLayout = api.onLayoutCommand(command => receiveLayoutCommand(command))
    const offSave = api.onSaveRequested(() => saveRequested())
    return () => { offSave(); offLayout() }
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

  runRef.current = () => { void run() }

  currentRunRef.current = runCurrent

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

  async function openSql() { await sqlFiles.open() }
  async function saveSql() { if (await sqlFiles.save()) setStatus('SQL file saved') }

  const resultViewKey=`result:${queryId}:${activeResult}`
  const tableViewKey=state.grid?tableColumnViewKey(session,state.grid):''

  const result = results[activeResult]
  const editableQuery = session && result && !state.schemaStale && !state.resultPartial ? editableQueryTable(result.statement, session, state.tables) : undefined
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
          {showMessages ? <div className="messages-panel"><div className="message-status" data-status={status}>{status}{duration !== null ? ` in ${duration} ms` : ''}</div>{messages.map((message, index) => <pre key={index}>{message}</pre>)}</div> : state.grid ? <TableData key={`${tabId}:${JSON.stringify(state.grid.table)}`} grid={state.grid} changes={state.gridChanges} disconnected={!session} busy={operationBusy} expired={state.gridExpired} transaction={inTransaction} onChange={gridChanges => patchState(tabId, { gridChanges })} onApply={() => void applyGrid()} onPreview={previewGrid} onLoad={(query, mode) => void openGrid(state.grid!.table, mode, query)} onClose={() => patchState(tabId, { grid: null, gridBack: [] })} view={state.columnViews?.[tableViewKey]} savedColumns={savedTableColumns()} onView={view=>saveColumnView(tableViewKey,view)} onBack={state.gridBack?.length?()=>void backGrid():undefined} actions={{load:async(row,column)=>(await inspectGrid('inspect-cell',row,column)).inspection!,references:async()=>(await inspectGrid('foreign-keys')).references!,follow:async(row,id)=>{await inspectGrid('follow-reference',row,0,id)}}} /> : null}
        <ResultWorkspace hidden={showMessages || Boolean(state.grid)} result={result} results={results} sourceKey={`${tabId}:${queryId ?? "none"}`} sourceLabel={state.resultSource ?? tab.title} partial={running || Boolean(state.resultPartial)} editSource={editableQuery ? { disabled: operationBusy || inTransaction || !ready, label: `${editableQuery.schema}.${editableQuery.name}`, open: () => void openGrid(editableQuery) } : undefined} view={state.columnViews?.[resultViewKey]} onView={view => saveColumnView(resultViewKey, view)} empty={<div className="results-empty"><h2>{running ? 'Running…' : 'No results'}</h2><p>{running ? 'Use Stop to cancel.' : session ? `Run SQL${editorKeys.run === 'none' ? '' : ` (${keyHint('run')})`} or browse a table.` : 'Connect to a database to run SQL.'}</p></div>}/>
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
    {objectView && objectView.tabId === tabId && objectView.sessionId === session?.id && <ObjectInspector view={objectView} session={session} blocked={schemaChangeBlocked()} onPrepare={prepareSchemaChange} onApply={applySchemaChange} onClose={() => setObjectView(null)} onRefresh={() => void inspectObject(objectView.object)} onOpen={(sql, title) => { if (workspace.tabs.length >= MAX_TABS || workspace.tabs.reduce((size, tab) => size + tab.sql.length, sql.length) > 5_000_000) { setObjectView({ ...objectView, error: 'Close a query tab or save and shorten a SQL buffer before opening this definition. The workspace supports 20 tabs and 5 MB of SQL.' }); return }; setObjectView(null); newTab(undefined, { sql, title }) }} />}
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
