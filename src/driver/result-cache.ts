import type { ResultSet } from '../shared/contracts'
import { MAX_TABS } from '../shared/contracts'

/** Index exports by connection and tab, including callers without a tab ID. */
export class SessionQueryIndex {
  private sessions = new Map<string, Map<string, string>>()
  replace(sessionId: string, queryId: string, viewId = '') {
    const views = this.sessions.get(sessionId) ?? new Map<string, string>(), removed: string[] = []
    const previous = views.get(viewId)
    if (previous) removed.push(previous)
    views.delete(viewId)
    if (views.size >= MAX_TABS) {
      const oldest = views.keys().next().value!
      removed.push(views.get(oldest)!); views.delete(oldest)
    }
    views.set(viewId, queryId); this.sessions.set(sessionId, views)
    return removed
  }
  forget(sessionId: string, viewId?: string) {
    const views = this.sessions.get(sessionId)
    if (!views) return []
    if (viewId === undefined) { this.sessions.delete(sessionId); return [...views.values()] }
    const queryId = views.get(viewId); views.delete(viewId)
    if (!views.size) this.sessions.delete(sessionId)
    return queryId ? [queryId] : []
  }
  clear() { this.sessions.clear() }
}

/** One bounded execution per tab. Other tabs must never evict these rows. */
export class SessionResultCache {
  private results = new Map<string, ResultSet[]>()
  private latest = new SessionQueryIndex()
  begin(sessionId: string, queryId: string, streaming = false, viewId?: string) {
    if (streaming) { this.results.set(queryId, []); return }
    for (const previous of this.latest.replace(sessionId, queryId, viewId)) this.results.delete(previous)
    this.results.set(queryId, [])
  }
  get(queryId: string) { return this.results.get(queryId) }
  finishStream(queryId: string) { this.results.delete(queryId) }
  forget(sessionId: string, viewId?: string) {
    for (const previous of this.latest.forget(sessionId, viewId)) this.results.delete(previous)
  }
  clear() { this.latest.clear(); this.results.clear() }
}
