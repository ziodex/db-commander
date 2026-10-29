import type * as Monaco from 'monaco-editor'
import { useEffect, useEffectEvent, useState, type RefObject } from 'react'
import { changesSchema } from '../language/completion'
import { currentExecution } from '../language/execution'
import { engineNames, type DatabaseEvent, type DesktopApi, type HistoryEntry, type WorkspaceTab } from '../shared/contracts'
import type { ExecutionSource } from '../shared/execution'
import type { ExplainRequest } from '../shared/explain'
import { parameterNames, type QueryParameter } from '../shared/parameters'
import { applyDatabaseEvent, emptyTabState, tabOperationBusy } from './query-tabs'
import { sessionOwners } from './shared-sessions'
import type { useWorkspaceSessions } from './use-workspace-sessions'
import { rendererError as message, type WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; tab: WorkspaceTab
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  sessions: Pick<ReturnType<typeof useWorkspaceSessions>, 'handleSessionEvent' | 'cleanupLostSession' | 'refreshTables'>
}

/** Binds each execution and incoming event to its original tab/session/query identity. */
export function useQueryExecution({ api, runtime, tab, editorRef, sessions }: Options) {
  const { workspaceRef, statesRef, patchState, changeStates, changeWorkspace, report } = runtime
  const { handleSessionEvent, cleanupLostSession, refreshTables } = sessions
  const { id: tabId, sql } = tab
  const { session, queryId, activeResult } = statesRef.current[tabId] ?? emptyTabState()
  const activeSessionId = session?.id
  const setStatus = (status: string) => patchState(tabId, { status })
  const [explainText, setExplainText] = useState<string | null>(null)

  const [parameterRun,setParameterRun]=useState<{tabId:string;sessionId:string;sql:string;names:string[];source?:ExecutionSource}>()

  const [history, setHistory] = useState<HistoryEntry[]>([])

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

  function runCurrent() {
    const editor = editorRef.current, model = editor?.getModel(), position = editor?.getPosition()
    if (!model || !position || !session) return
    try {
      const selected = currentExecution(sql, model.getOffsetAt(position), session.engine, session.mysqlSqlMode)
      void run(selected.sql, undefined, { ...selected, document: sql, singleUnit: true })
    } catch (error) { report(error) }
  }

  function runScript() {
    const query = sql.trim(), start = sql.length - sql.trimStart().length
    void run(query, undefined, { document: sql, sql: query, start, end: start + query.length, prefixLength: 0 })
  }

  async function exportCsv() {
    if (tabOperationBusy(statesRef.current[tabId])) return
    try { const path = await api.exportCsv(queryId, activeResult); if (path && statesRef.current[tabId]?.queryId === queryId) setStatus('Fetched rows exported') }
    catch (error) { report(error) }
  }

  useEffect(() => { setExplainText(null) }, [tabId, activeSessionId])
  const receiveDatabaseEvent = useEffectEvent((event: DatabaseEvent) => {
      const owner = event.type === 'host-lost' ? undefined : Object.entries(statesRef.current).find(([, state]) => state.session?.id === event.sessionId && (event.type === 'session-lost' || state.queryId === event.queryId))?.[0]
      const previousDatabase = owner ? statesRef.current[owner]?.session?.database : undefined
      handleSessionEvent(event, Boolean(owner))
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
  const reportEffectError = useEffectEvent((error: unknown) => report(error, workspaceRef.current.activeTabId))
  useEffect(() => {
    let disposed = false
    void api.history().then(value => { if (!disposed) setHistory(value) }).catch(error => { if (!disposed) reportEffectError(error) })
    const off = api.onEvent(event => receiveDatabaseEvent(event))
    return () => { disposed = true; off() }
  }, [api])

  return { history, setHistory, explainText, setExplainText, parameterRun, setParameterRun,
    openExplain, explainQuery, run, runCurrent, runScript, exportCsv }
}
