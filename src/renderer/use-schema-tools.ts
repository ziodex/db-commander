import { useState, type Dispatch, type SetStateAction } from 'react'
import { objectKey, type CatalogObject } from '../shared/catalog'
import type { DesktopApi, GridTable, HistoryEntry, SessionInfo } from '../shared/contracts'
import type { ApplySchemaChange, SchemaChange } from '../shared/schema-changes'
import type { AdministrationChange, AdministrationTarget, ApplyAdministration } from '../shared/database-administration'
import { diagramLayoutsSchema, diagramLayoutScope, type SavedDiagramLayout } from '../shared/diagram-layouts'
import { tableLayoutKey } from '../shared/table-layouts'
import type { DiagramLayoutControls } from './DiagramDialog'
import type { ObjectView } from './ObjectInspector'
import { canCloseTab } from './query-tabs'
import type { useWorkspaceSessions } from './use-workspace-sessions'
import { rendererError as message, type WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; tabId: string
  setHistory: Dispatch<SetStateAction<HistoryEntry[]>>
  sessions: Pick<ReturnType<typeof useWorkspaceSessions>, 'cleanupLostSession' | 'refreshTables' | 'refreshDatabases'>
}

export function useSchemaTools({ api, runtime, tabId, setHistory, sessions }: Options) {
  const { statesRef, workspaceRef, changeWorkspace, persist, patchState, report } = runtime
  const { cleanupLostSession, refreshTables, refreshDatabases } = sessions
  const [objectView, setObjectView] = useState<ObjectView | null>(null)

  const [schemaEditor, setSchemaEditor] = useState<{ tabId: string; sessionId: string; target?: CatalogObject } | null>(null)
  const [administration, setAdministration] = useState<{ tabId: string; session: SessionInfo; target: AdministrationTarget; fallback: HTMLElement | null } | null>(null)

  async function inspectObject(object: CatalogObject, owner = tabId) {
    const current = statesRef.current[owner], sessionId = current?.session?.id
    if (!sessionId || current.sharedSessionBusy || current.schemaLoading || current.catalogLoading || current.running || current.gridBusy || current.backupBusy || current.transferBusy || current.switching || current.databasesLoading) return
    const isView = (view: ObjectView | null) => view?.sessionId === sessionId && view.tabId === owner && objectKey(view.object) === objectKey(object)
    setObjectView(previous => previous && isView(previous) ? { ...previous, loading: true, error: undefined } : { tabId: owner, sessionId, object, loading: true })
    patchState(owner, { schemaLoading: true })
    try {
      const detail = await api.inspectObject({ sessionId, object })
      if (statesRef.current[owner]?.session?.id === sessionId) setObjectView(previous => previous && isView(previous) ? { ...previous, detail, loading: false } : previous)
    } catch (error) { setObjectView(previous => previous && isView(previous) ? { ...previous, error: message(error), loading: false } : previous) }
    finally { if (statesRef.current[owner]?.session?.id === sessionId) patchState(owner, { schemaLoading: false }); cleanupLostSession(sessionId) }
  }

  function savedDiagramLayouts(): DiagramLayoutControls | undefined {
    const current = statesRef.current[tabId], session = current?.session
    const owner = workspaceRef.current.tabs.find(tab => tab.id === tabId)
    if (!session || !owner) return
    const scope = diagramLayoutScope(owner.profile, session, current.connectionDatabase)
    if (!scope) return
    function verify() {
      const next = statesRef.current[tabId], tab = workspaceRef.current.tabs.find(item => item.id === tabId)
      if (!tab || !next?.session || next.session.id !== session!.id ||
          diagramLayoutScope(tab.profile, next.session, next.connectionDatabase) !== scope) {
        throw new Error('The connection changed. Reopen the diagram before editing its layouts.')
      }
    }
    async function change(name: string, layout?: SavedDiagramLayout) {
      verify()
      const previous = workspaceRef.current.diagramLayouts
      const entries = (previous ?? []).filter(entry => entry.scope !== scope || entry.name !== name)
      const next = diagramLayoutsSchema.parse(layout ? [...entries, layout] : entries)
      changeWorkspace(workspace => ({ ...workspace, diagramLayouts: next }))
      try { await persist() }
      catch (error) {
        changeWorkspace(workspace => workspace.diagramLayouts === next ? { ...workspace, diagramLayouts: previous } : workspace)
        throw error
      }
    }
    const canSave = (tables: GridTable[]) => tables.every(table => Boolean(tableLayoutKey(owner.profile, session, table, current.connectionDatabase)))
    return {
      layouts: workspaceRef.current.diagramLayouts?.filter(layout => layout.scope === scope) ?? [],
      canSave,
      save: async layout => {
        if (!canSave(layout.tables.map(({ table }) => table))) throw new Error('Select tables from the opened database before saving this layout.')
        await change(layout.name, { ...layout, scope })
      },
      remove: name => change(name)
    }
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

  async function administrationOperation<T>(sessionId: string, work: () => Promise<T>) {
    const reason = schemaChangeBlocked()
    if (reason) throw new Error(reason)
    if (statesRef.current[tabId]?.session?.id !== sessionId) throw new Error('The connection changed. Open a new review.')
    patchState(tabId, { schemaLoading: true })
    try { return await work() }
    finally {
      if (statesRef.current[tabId]?.session?.id === sessionId) patchState(tabId, { schemaLoading: false })
      cleanupLostSession(sessionId)
    }
  }

  function prepareAdministration(change: AdministrationChange) {
    if (!administration) throw new Error('Open database administration to prepare a review.')
    const { id: sessionId } = administration.session
    return administrationOperation(sessionId, () => api.prepareAdministration({ sessionId, change }))
  }

  async function applyAdministration(request: ApplyAdministration, change: AdministrationChange) {
    const result = await administrationOperation(request.sessionId, () => api.applyAdministration(request))
    if ('database' in change && result.status !== 'rejected' && result.status !== 'unknown' &&
        statesRef.current[tabId]?.session?.id === request.sessionId) await refreshDatabases(tabId, request.sessionId)
    return result
  }

  return { objectView, setObjectView, schemaEditor, setSchemaEditor, inspectObject, savedDiagramLayouts, schemaChangeBlocked, prepareSchemaChange, applySchemaChange,
    administration, setAdministration, prepareAdministration, applyAdministration }
}
