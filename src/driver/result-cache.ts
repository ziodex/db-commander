import type { ResultSet } from '../shared/contracts'

/** One bounded execution per session. Other tabs must never evict these rows. */
export class SessionResultCache {
  private results = new Map<string, ResultSet[]>()
  private latest = new Map<string, string>()
  begin(sessionId: string, queryId: string, streaming = false) {
    if (streaming) { this.results.set(queryId, []); return }
    this.forget(sessionId)
    this.latest.set(sessionId, queryId); this.results.set(queryId, [])
  }
  get(queryId: string) { return this.results.get(queryId) }
  finishStream(queryId: string) { this.results.delete(queryId) }
  forget(sessionId: string) {
    const previous = this.latest.get(sessionId)
    if (previous) this.results.delete(previous)
    this.latest.delete(sessionId)
  }
  clear() { this.latest.clear(); this.results.clear() }
}
