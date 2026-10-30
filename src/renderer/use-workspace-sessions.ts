import { useRef, useState, type RefObject } from 'react'
import { connectionProfile, sameConnectionProfile } from '../shared/connection-profiles'
import { MAX_PROFILES, type ConnectionConfig, type ConnectionProfile, type DatabaseEvent, type DesktopApi, type WorkspaceTab } from '../shared/contracts'
import { passwordEligible, type PasswordChoice } from '../shared/credentials'
import type { EditorSettings } from '../shared/editor-settings'
import { canCloseTab, canSwitchDatabase, emptyTabState } from './query-tabs'
import { sessionOwners } from './shared-sessions'
import { DUCKDB_INITIAL_SQL, INITIAL_PROFILE, INITIAL_SQL, MYSQL_INITIAL_SQL, ORACLE_INITIAL_SQL, SQLITE_INITIAL_SQL, SQLSERVER_INITIAL_SQL, starterSql } from './starter-sql'
import type { useSqlFiles } from './use-sql-files'
import { rendererError as message, type WorkspaceRuntime } from './workspace-runtime'

interface Options {
  api: DesktopApi; runtime: WorkspaceRuntime; tab: WorkspaceTab; readyRef: RefObject<boolean>
  sqlFiles: Pick<ReturnType<typeof useSqlFiles>, 'files'>; editorSettings: EditorSettings
}

/** Owns physical-session lifetimes, saved credentials and catalog/database changes. */
export function useWorkspaceSessions({ api, runtime, tab, readyRef, sqlFiles, editorSettings }: Options) {
  const { workspaceRef, statesRef, patchState, patchTab, changeWorkspace, persist, report } = runtime
  const { id: tabId, profile } = tab
  const lostSessions = useRef(new Set<string>())

  const generation = useRef(0)

  const [dialogInfo, setDialogInfo] = useState<{ tabId: string; profile: ConnectionProfile; profileId?: string; saveOnly?: boolean } | null>(null)

  const [dialogError, setDialogError] = useState('')

  const [connectionWarning, setConnectionWarning] = useState<{ tabId: string; profileId: string; name: string; error: string } | null>(null)

  const [profileBusy, setProfileBusy] = useState(false)

  const [switchTarget, setSwitchTarget] = useState<{ tabId: string; sessionId: string; database: string } | null>(null)

  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null)

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

  async function openIndependentConnection(id: string, sourceSession: string, restoreJobId?: string) {
    const epoch = generation.current
    patchState(id, { connecting: true, status: 'Connecting' })
    try {
      // Authentication stays in the main process. A clone opens a physical
      // connection; it never copies temporary objects, locks or transactions.
      const connected = restoreJobId ? await api.connectBackupTarget(restoreJobId) : await api.cloneSession(sourceSession)
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

  function handleSessionEvent(event: DatabaseEvent, owned: boolean) {
    if (event.type === 'host-lost') { generation.current++; lostSessions.current.clear() }
    if (event.type === 'session-lost' && owned) lostSessions.current.add(event.sessionId)
    // A final completion can release the lock after session loss.
    if (event.type !== 'host-lost' && ['session-lost', 'complete'].includes(event.type)) cleanupLostSession(event.sessionId)
  }

  return { dialogInfo, setDialogInfo, dialogError, setDialogError, connectionWarning, setConnectionWarning,
    profileBusy, deleteProfileId, setDeleteProfileId, switchTarget, setSwitchTarget, setDialog,
    connect, openIndependentConnection, saveProfile, deleteProfile, disconnect, disconnectTabs,
    requestSwitch, switchDatabase, refreshTables, refreshDatabases, cleanupLostSession, handleSessionEvent }
}
