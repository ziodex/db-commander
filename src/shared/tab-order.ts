interface TabIdentity { id: string; pinned?: boolean }

/** Stable groups also recover older/manually reordered workspace records. */
export function orderPinnedTabs<T extends TabIdentity>(tabs: T[]): T[] {
  const ordered = [...tabs.filter(tab => tab.pinned === true), ...tabs.filter(tab => tab.pinned !== true)]
  return ordered.every((tab, index) => tab === tabs[index]) ? tabs : ordered
}

/** Tabs move only within their pinned or unpinned group. Input is grouped. */
export function tabMoveBounds(tabs: TabIdentity[], id: string): { first: number; last: number } | undefined {
  const tab = tabs.find(tab => tab.id === id)
  if (!tab) return
  const pinned = tabs.filter(tab => tab.pinned === true).length
  return tab.pinned ? { first: 0, last: pinned - 1 } : { first: pinned, last: tabs.length - 1 }
}

export function tabMoveIndex(tabs: TabIdentity[], id: string, destination: number): number {
  const bounds = tabMoveBounds(tabs, id)
  return bounds && Number.isInteger(destination) ? Math.max(bounds.first, Math.min(bounds.last, destination)) : -1
}

/** Reorder by identity; preserve every tab object, active tab and per-tab runtime state. */
export function moveTab<T extends TabIdentity>(tabs: T[], id: string, destination: number): T[] {
  const source = tabs.findIndex(tab => tab.id === id)
  const index = tabMoveIndex(tabs, id, destination)
  if (index < 0 || source === index) return tabs
  const next = [...tabs], [tab] = next.splice(source, 1)
  next.splice(index, 0, tab)
  return next
}
export function dropIndex(tabs: TabIdentity[], sourceId: string, targetId: string, after: boolean) {
  const source = tabs.findIndex(tab => tab.id === sourceId), target = tabs.findIndex(tab => tab.id === targetId)
  if (source < 0 || target < 0) return -1
  if (Boolean(tabs[source].pinned) !== Boolean(tabs[target].pinned)) return -1
  return target + Number(after) - Number(source < target + Number(after))
}

/** Pin at the end of the pinned group; unpin at the start of ordinary tabs. */
export function setTabPinned<T extends TabIdentity>(tabs: T[], id: string, pinned: boolean): T[] {
  const tab = tabs.find(tab => tab.id === id)
  if (!tab || Boolean(tab.pinned) === pinned) return tabs
  const next = tabs.filter(tab => tab.id !== id)
  next.splice(next.filter(tab => tab.pinned === true).length, 0, { ...tab, pinned })
  return next
}
