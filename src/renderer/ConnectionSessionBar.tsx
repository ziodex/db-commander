import type { WorkspaceTab } from '../shared/contracts'
import { connectionGroups, sessionOwners } from './shared-sessions'
import type { QueryTabState } from './query-tabs'
import { ActionMenu } from './ActionMenu'

export function ConnectionSessionBar({ tabs, states, activeId, onSwitch }: { tabs: WorkspaceTab[]; states: Record<string, QueryTabState>; activeId: string; onSwitch(id: string): void }) {
  const session = states[activeId]?.session
  if (!session) return null
  const owners = sessionOwners(states, session.id), group = connectionGroups(tabs, states).find(group => group.session.id === session.id)!
  return <div className="connection-session-bar" aria-label="Query connection ownership">
    <strong>Connection {group.number}</strong><span>{owners.length > 1 ? `Shared by ${owners.length} tabs` : 'Only this tab'}</span>
    <span className="connection-sharing-help">Transactions and temporary objects belong to this connection.</span>
    <ActionMenu label="Tabs on this connection" items={group.tabs.map((tab, index) => ({ label: `${index + 1}. ${tab.title}${tab.id === activeId ? ' (current)' : ''}`, action: () => onSwitch(tab.id) }))}/>
  </div>
}
