import { expect, it, vi } from 'vitest'
import { readScheduler, SchedulerReviews } from '../../src/activity/scheduler'
import type { SessionInfo } from '../../src/shared/contracts'

it('expires a native scheduler review without carrying its authority across owners or databases', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z')
  const reviews = new SchedulerReviews(() => now)
  const session: SessionInfo = { id: 'source', engine: 'sqlserver', name: 'Source', user: 'test', database: 'test',
    host: 'local', port: 1, tls: false, transaction: 'idle', version: '1' }
  const query = vi.fn().mockResolvedValueOnce([['3']])
    .mockResolvedValueOnce([['12345678-1234-1234-1234-123456789abc', 'test-job', 'test', '0', '1', '0', '0']])
    .mockResolvedValueOnce([])
  const snapshot = reviews.remember(session, await readScheduler({
    engine: 'sqlserver', currentSessionId: '42', database: 'test', query
  }))
  const target = snapshot.entries[0]
  expect(() => reviews.prepare({ ...session, database: 'other' }, target.id)).toThrow(/refresh/i)
  const review = reviews.prepare(session, target.id)
  const request = { sessionId: session.id, reviewId: review.id, confirmation: 'ENABLE', acknowledge: true as const }
  expect(() => reviews.consume({ ...request, sessionId: 'other' })).toThrow(/no longer available/)
  now += 60_000
  expect(() => reviews.consume(request)).toThrow(/expired/)
  expect(() => reviews.consume(request)).toThrow(/no longer available/)
})
