import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planSqlServerAdministration } from '../../src/administration/sqlserver'
import type { CatalogQuery } from '../../src/catalog/common'
import { AdministrationReviews } from '../../src/administration/reviews'
import { mysqlMaintenanceResult } from '../../src/administration/mysql'
import { applyAdministrationSchema, prepareAdministrationSchema } from '../../src/shared/database-administration'

const sessionId = randomUUID()
const request = prepareAdministrationSchema.parse({ sessionId, change: { action: 'drop-database', database: 'reviewed' } })
const plan = {
  database: 'control', observer: 'operator', scope: 'PostgreSQL cluster', target: '"reviewed"',
  sql: 'DROP DATABASE "reviewed";', notes: ['Permanent deletion'], fingerprint: 'internal'
}

afterEach(() => { vi.useRealTimers() })

describe('database administration review authority', () => {
  it('rejects renderer-supplied SQL, target changes and missing acknowledgement', () => {
    const apply = { sessionId, reviewId: randomUUID(), confirmation: 'DROP DATABASE "reviewed"', acknowledge: true }
    expect(applyAdministrationSchema.safeParse({ ...apply, sql: 'DROP DATABASE other' }).success).toBe(false)
    expect(applyAdministrationSchema.safeParse({ ...apply, change: request.change }).success).toBe(false)
    expect(applyAdministrationSchema.safeParse({ ...apply, acknowledge: false }).success).toBe(false)
    expect(prepareAdministrationSchema.safeParse({ ...request, change: { ...request.change, force: true } }).success).toBe(false)
  })

  it('binds the execution plan to a physical owner, replaces old reviews and consumes on the first attempt', () => {
    const reviews = new AdministrationReviews()
    const old = reviews.prepare(request, plan, 'source')
    const next = reviews.prepare(request, plan, 'source')
    expect(next).not.toHaveProperty('fingerprint')
    next.notes.push('renderer edit')
    const requestFor = (reviewId: string) => ({ sessionId, reviewId, confirmation: next.confirmation, acknowledge: true as const })
    expect(() => reviews.consume(requestFor(old.id))).toThrow('connection that will apply it')
    expect(() => reviews.consume({ ...requestFor(next.id), sessionId: randomUUID() })).toThrow('connection that will apply it')
    const consumed = reviews.consume(requestFor(next.id))
    expect(consumed.sourceDatabase).toBe('source')
    expect(consumed.plan).toEqual(plan)
    expect(consumed.review.notes).toEqual(['Permanent deletion'])
    expect(() => reviews.consume(requestFor(next.id))).toThrow('connection that will apply it')
  })

  it('expires a review at two minutes', () => {
    vi.useFakeTimers()
    const reviews = new AdministrationReviews()
    const review = reviews.prepare(request, plan, 'source')
    vi.setSystemTime(new Date(review.expiresAt))
    expect(() => reviews.consume({ sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true })).toThrow('review expired')
  })
})

describe('MySQL-family native maintenance receipts', () => {
  const table = 'target.items'
  it('requires the correct table, operation and final native status', () => {
    expect(mysqlMaintenanceResult([['other.items', 'analyze', 'status', 'OK']], 'analyze-table', table)).toBeUndefined()
    expect(mysqlMaintenanceResult([[table, 'analyze', 'note', 'OK']], 'analyze-table', table)).toBeUndefined()
    expect(mysqlMaintenanceResult([[table, 'analyze', 'status', 'OK']], 'analyze-table', table)).toMatchObject({ status: 'applied' })
  })

  it('keeps native integrity problems visible and accepts the native rebuild note before OK', () => {
    expect(mysqlMaintenanceResult([[table, 'check', 'warning', 'Corrupt page'], [table, 'check', 'status', 'OK']], 'check-table', table))
      .toMatchObject({ status: 'issues' })
    expect(mysqlMaintenanceResult([[table, 'optimize', 'error', 'Server error'], [table, 'optimize', 'status', 'OK']], 'optimize-table', table))
      .toBeUndefined()
    expect(mysqlMaintenanceResult([[table, 'optimize', 'note', 'Recreate and analyze'], [table, 'optimize', 'status', 'OK']], 'optimize-table', table))
      .toMatchObject({ status: 'applied' })
  })
})

describe('logical Azure SQL administration', () => {
  const create = { action: 'create-database', database: 'review] name' } as const
  const context = ['master', '1', 'operator', 'operator', 'dbo', '5', '0', '512']
  it('reviews an exact standalone create in logical master and requires an ONLINE catalog receipt', async () => {
    const catalog = vi.fn<CatalogQuery>()
      .mockResolvedValueOnce([context])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[create.database, '7', '2026-11-04', '7', null, '0', '0']])
      .mockResolvedValueOnce([[create.database, '7', '2026-11-04', '0', null, '0', '0']])
    const plan = await planSqlServerAdministration(catalog, 'azure-sql', 'source', create)
    expect(plan).toMatchObject({ sql: 'CREATE DATABASE [review]] name];', scope: 'Azure SQL logical server · Billable database', database: 'master' })
    expect(plan.notes.join(' ')).toContain('billable')
    expect(catalog.mock.calls[1][0]).not.toMatch(/sys\.database_recovery_status|HAS_DBACCESS|IS_SRVROLEMEMBER/)
    expect(catalog.mock.calls[1][1]).toEqual([create.database])
    expect(await plan.verify()).toBe(false)
    expect(await plan.verify()).toBe(true)
  })

  it('refuses unsafe database scope, unsupported profiles and destructive lifecycle actions', async () => {
    const catalog = vi.fn<CatalogQuery>().mockResolvedValue([context])
    await expect(planSqlServerAdministration(catalog, 'azure-sql', 'source', { action: 'drop-database', database: 'other' })).rejects.toThrow('unavailable')
    await expect(planSqlServerAdministration(catalog, 'azure-sql', 'source', { action: 'rename-database', database: 'other', destination: 'new' })).rejects.toThrow('unavailable')
    await expect(planSqlServerAdministration(catalog, 'sqlserver', 'source', create)).rejects.toThrow('supported SQL Server or Azure SQL Database connection profile')
    catalog.mockResolvedValue([['source', ...context.slice(1)]])
    await expect(planSqlServerAdministration(catalog, 'azure-sql', 'source', create)).rejects.toThrow('verify the database')
    expect(catalog.mock.calls.every(([sql]) => sql.startsWith('SELECT DB_NAME()'))).toBe(true)
  })
})
