import { useState, type Dispatch, type SetStateAction } from 'react'
import type { CatalogObject } from '../shared/catalog'
import type { DesktopApi, HistoryEntry } from '../shared/contracts'
import type { ApplySchemaChange, SchemaChange } from '../shared/schema-changes'
import type { ObjectView } from './ObjectInspector'
import { canCloseTab } from './query-tabs'
import type { useWorkspaceSessions } from './use-workspace-sessions'
import { rendererError as message, type WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; tabId: string
  setHistory: Dispatch<SetStateAction<HistoryEntry[]>>
  sessions: Pick<ReturnType<typeof useWorkspaceSessions>, 'cleanupLostSession' | 'refreshTables'>
}

export function useSchemaTools({ api, runtime, tabId, setHistory, sessions }: Options) {
  const { statesRef, patchState, report } = runtime
  const { cleanupLostSession, refreshTables } = sessions
  const [objectView, setObjectView] = useState<ObjectView | null>(null)

  const [schemaEditor, setSchemaEditor] = useState<{ tabId: string; sessionId: string; target?: CatalogObject } | null>(null)

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

  return { objectView, setObjectView, schemaEditor, setSchemaEditor, inspectObject, schemaChangeBlocked, prepareSchemaChange, applySchemaChange }
}
