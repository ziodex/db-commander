import { emptyTabState, type QueryTabState } from './query-tabs'
import type { WorkspaceTab } from '../shared/contracts'

/** Runtime insertion order keeps connection labels consistent when tabs move. */
export function connectionGroups(tabs: WorkspaceTab[], states: Record<string, QueryTabState>) {
  const seen = new Set<string>()
  return Object.keys(states).flatMap(id => {
    const session = states[id]?.session
    if (!session || seen.has(session.id) || !tabs.some(tab => tab.id === id)) return []
    seen.add(session.id)
    return [{ session, tabs: tabs.filter(tab => states[tab.id]?.session?.id === session.id), number: seen.size }]
  })
}

export function sessionOwners(states: Record<string, QueryTabState>, sessionId: string) {
  return Object.keys(states).filter(id => states[id].session?.id === sessionId)
}

/** Keep operation locks on the connection, while SQL and result views belong to tabs. */
export function reconcileSessionBusy(states: Record<string, QueryTabState>) {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => {
    const sharedSessionBusy = Boolean(state.session && Object.entries(states).some(([other, peer]) => other !== id && peer.session?.id === state.session!.id && (
      peer.running || peer.connecting || peer.closing || peer.schemaLoading || peer.backupBusy || peer.transferBusy || peer.gridBusy || peer.switching || peer.databasesLoading || peer.gridChanges.length
    )))
    return [id, Boolean(state.sharedSessionBusy) === sharedSessionBusy ? state : { ...state, sharedSessionBusy }]
  }))
}

export function patchSessionState(states: Record<string, QueryTabState>, id: string, patch: Partial<QueryTabState>) {
  const current = states[id] ?? emptyTabState(), next = { ...states, [id]: { ...current, ...('error' in patch ? { failure: undefined } : {}), ...patch } }
  if (!current.session || 'session' in patch && patch.session?.id !== current.session.id) return next
  for (const other of sessionOwners(states, current.session.id)) {
    if (other === id) continue
    const peer = states[other], shared: Partial<QueryTabState> = {}
    if (patch.session?.id === current.session.id) shared.session = patch.session
    for (const key of ['schema', 'tables', 'schemaStale', 'schemaError', 'databases', 'databasesError'] as const) {
      if (key in patch) Object.assign(shared, { [key]: patch[key] })
    }
    // SQL and writes invalidate captured edit originals across the connection.
    // Browsing another tab keeps its independent grid snapshot and export cache.
    if (patch.running || patch.transferBusy || patch.gridExpired) shared.gridExpired = true
    next[other] = { ...peer, ...shared }
  }
  return next
}
