import { randomUUID } from 'node:crypto'
import type { AdministrationReview, ApplyAdministration, PrepareAdministration } from '../shared/database-administration'

export interface AdministrationPlan {
  database: string
  observer: string
  scope: string
  target: string
  sql: string
  notes: string[]
  fingerprint: string
}

export class AdministrationReviews {
  private entries = new Map<string, {
    request: PrepareAdministration
    plan: AdministrationPlan
    sourceDatabase: string
    review: AdministrationReview
    expiresAt: number
  }>()

  prepare(request: PrepareAdministration, plan: AdministrationPlan, sourceDatabase: string): AdministrationReview {
    const now = Date.now()
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.forget(id)
    }
    if (this.entries.size >= 20 && !this.entries.has(request.sessionId)) throw new Error('Too many pending database administration reviews.')
    const expiresAt = now + 120_000
    const { database, observer, scope, target, sql, notes } = plan
    const review = {
      id: randomUUID(), database, observer, scope, target, sql, notes: [...notes],
      confirmation: `${request.change.action.replaceAll('-', ' ').toUpperCase()} ${target}`,
      expiresAt: new Date(expiresAt).toISOString()
    }
    this.entries.set(request.sessionId, { request, plan, sourceDatabase, review, expiresAt })
    return { ...review, notes: [...notes] }
  }

  consume(request: ApplyAdministration) {
    const entry = this.entries.get(request.sessionId)
    if (!entry || entry.review.id !== request.reviewId) throw new Error('Prepare the review on the connection that will apply it.')
    this.forget(request.sessionId)
    if (entry.expiresAt <= Date.now()) throw new Error('This review expired. Prepare a new review.')
    if (request.confirmation !== entry.review.confirmation) throw new Error('The confirmation did not match. Prepare a new review.')
    return entry
  }

  forget(id: string) { this.entries.delete(id) }
  clear() { this.entries.clear() }
}
