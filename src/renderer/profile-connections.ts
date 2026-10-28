import type { SavedConnectionProfile, WorkspaceTab } from '../shared/contracts'
import { sameConnectionSettings } from '../shared/connection-profiles'
import { canCloseTab, type QueryTabState } from './query-tabs'

export interface ProfileConnectionState {
  connected: boolean
  previousSettings: boolean
  activePreviousSettings: boolean
  busy: boolean
  tabIds: string[]
  sessionIds: string[]
  disconnectReason?: string
}

export function profileConnectionStates(profiles: SavedConnectionProfile[], tabs: WorkspaceTab[], states: Record<string, QueryTabState>, activeTabId: string) {
  const connections = new Map<string, ProfileConnectionState>()
  for (const tab of tabs) {
    const profile = profiles.find(profile => profile.id === tab.profileId), state = states[tab.id]
    if (!profile || !state) continue
    const connection = connections.get(profile.id) ?? { connected: false, previousSettings: false, activePreviousSettings: false, busy: false, tabIds: [], sessionIds: [] }
    if (state.session) {
      connection.tabIds.push(tab.id)
      if (!connection.sessionIds.includes(state.session.id)) connection.sessionIds.push(state.session.id)
    }
    const matches = sameConnectionSettings(tab.profile, profile.config)
    connection.connected ||= Boolean(state.session && matches)
    connection.previousSettings ||= Boolean(state.session && !matches)
    connection.activePreviousSettings ||= tab.id === activeTabId && !matches
    connection.busy ||= state.connecting || state.closing
    connection.disconnectReason ??= canCloseTab(state)
    connections.set(profile.id, connection)
  }
  return connections
}
