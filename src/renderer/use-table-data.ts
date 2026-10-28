import type * as Monaco from 'monaco-editor'
import type { RefObject } from 'react'
import { defaultColumns, withColumnView, type ColumnLayout } from '../shared/column-layout'
import type { DesktopApi, GridQueryOptions, GridSnapshot, GridTable, SessionInfo, Workspace, WorkspaceTab } from '../shared/contracts'
import { DEFAULT_LAYOUT, type WorkspaceLayout } from '../shared/layout'
import { tablePreviewSql } from '../shared/sql/common'
import { matchingTableLayout, saveTableLayout, tableColumns, tableColumnViewKey, tableLayoutKey } from '../shared/table-layouts'
import { workspaceSqlLimit } from '../shared/workspace-limits'
import type { SavedColumnControls } from './ColumnControls'
import { emptyTabState, tabOperationBusy, type QueryTabState } from './query-tabs'
import type { useWorkspaceTabs } from './use-workspace-tabs'
import { rendererError as message, type WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; workspace: Workspace; tab: WorkspaceTab; ready: boolean; readyRef: RefObject<boolean>
  editors: RefObject<Map<string, Monaco.editor.IStandaloneCodeEditor>>; sqlFiles: { busy: boolean }; closeId: string | null
  newTab: ReturnType<typeof useWorkspaceTabs>['newTab']
  changeLayout(update: (previous: WorkspaceLayout) => WorkspaceLayout): void
  focusEditor(id: string): void
}

/** Owns table snapshots, staged changes, navigation and saved column layouts. */
export function useTableData({ api, runtime, workspace, tab, ready, readyRef, editors, sqlFiles, closeId, newTab, changeLayout, focusEditor }: Options) {
  const { workspaceRef, statesRef, patchState, patchTab, changeWorkspace, persist, report } = runtime
  const { id: tabId, profile } = tab
  const state = statesRef.current[tabId] ?? emptyTabState(), session = state.session
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

  return { appendSelect, openGrid, browseTable, saveColumnView, savedTableColumns, inspectGrid, backGrid, applyGrid }
}
