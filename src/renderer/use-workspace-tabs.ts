import { useRef, useState } from 'react'
import { sameConnectionSettings } from '../shared/connection-profiles'
import { MAX_TABS, type DesktopApi, type SavedConnectionProfile, type SessionInfo, type WorkspaceTab } from '../shared/contracts'
import type { EditorSettings } from '../shared/editor-settings'
import { setTabPinned } from '../shared/tab-order'
import { canCloseTab, emptyTabState } from './query-tabs'
import { sessionOwners } from './shared-sessions'
import { INITIAL_PROFILE, starterSql } from './starter-sql'
import type { useSqlFiles } from './use-sql-files'
import type { useWorkspaceSessions } from './use-workspace-sessions'
import type { WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; ready: boolean; editorSettings: EditorSettings
  sqlFiles: Pick<ReturnType<typeof useSqlFiles>, 'busy' | 'forget'>
  sessions: Pick<ReturnType<typeof useWorkspaceSessions>, 'connect' | 'openIndependentConnection'>
}

/** Owns tab creation and sequential close/release; pinning never changes session ownership. */
export function useWorkspaceTabs({ api, runtime, ready, editorSettings, sqlFiles, sessions }: Options) {
  const { workspaceRef, statesRef, patchState, changeStates, changeWorkspace, persist, report } = runtime
  const { connect, openIndependentConnection } = sessions
  const [closeRequest, setCloseRequest] = useState<{ ids: string[]; confirm: boolean } | null>(null)

  const closeId = closeRequest?.ids[0] ?? null

  const [closingTabs, setClosingTabs] = useState(false), closeOperation = useRef(false)

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

  return { closeRequest, setCloseRequest, closeId, closingTabs, closeOperation, newTab, pinTab, requestClose, closeTabs }
}
