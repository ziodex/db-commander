import { randomUUID } from 'node:crypto'
import type { ApplyPrincipalChange, PreparePrincipalChange, PrincipalChangeReview } from '../shared/principal-changes'

export interface PrincipalPlan {
  database: string
  observer: string
  sql: string
  notes: string[]
  fingerprint: string
  implicitCommit?: true
  requiresPassword?: true
}

export class PrincipalReviews {
  private reviews = new Map<string, {
    change: PreparePrincipalChange['change']
    plan: PrincipalPlan
    sourceDatabase: string
    review: PrincipalChangeReview
  }>()

  retain(request: PreparePrincipalChange, plan: PrincipalPlan, sourceDatabase = plan.database) {
    this.forget(request.sessionId)
    const now = Date.now()
    for (const [id, entry] of this.reviews) {
      if (Date.parse(entry.review.expiresAt) <= now) this.forget(id)
    }
    if (this.reviews.size >= 20) throw new Error('Too many pending principal reviews. Wait for an earlier review to expire.')
    const { database, observer, sql, notes } = plan
    const review = {
      id: randomUUID(), database, observer, sql, notes,
      confirmation: `APPLY ${request.change.action.replaceAll('-', ' ').toUpperCase()}`,
      implicitCommit: plan.implicitCommit === true,
      requiresPassword: plan.requiresPassword === true,
      expiresAt: new Date(now + 120_000).toISOString()
    }
    this.reviews.set(request.sessionId, { change: request.change, plan, sourceDatabase, review })
    return { ...review, notes: [...notes] }
  }

  consume(request: ApplyPrincipalChange) {
    const entry = this.reviews.get(request.sessionId)
    if (!entry || entry.review.id !== request.reviewId) throw new Error('Review this change on the connection that will apply it.')
    this.forget(request.sessionId)
    if (Date.parse(entry.review.expiresAt) <= Date.now()) throw new Error('This review expired. Prepare a new review.')
    if (request.confirmation !== entry.review.confirmation) throw new Error('The confirmation did not match. Prepare a new review.')
    if (entry.review.implicitCommit && !request.acknowledgeImplicitCommit) {
      throw new Error('Acknowledge the automatic commit before applying this change. Prepare a new review.')
    }
    if (entry.review.requiresPassword !== (request.newPassword !== undefined)) {
      throw new Error(entry.review.requiresPassword ? 'Supply the new login password. Prepare a new review.' : 'This change does not accept a password. Prepare a new review.')
    }
    return entry
  }

  forget(id: string) { this.reviews.delete(id) }
  clear() { this.reviews.clear() }
}
