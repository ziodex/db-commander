import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planOraclePrincipalChange } from '../../src/principals/oracle-changes'
import { planSqlServerPrincipalChange } from '../../src/principals/sqlserver-changes'
import { PrincipalReviews } from '../../src/principals/reviews'
import { applyPrincipalChangeSchema, preparePrincipalChangeSchema } from '../../src/shared/principal-changes'

afterEach(() => vi.useRealTimers())

describe('reviewed principal change authority', () => {
  const sessionId = randomUUID()
  const request = { sessionId, change: { action: 'create' as const, name: 'reviewed_role' } }
  const plan = {
    database: 'dev', observer: 'admin', sql: 'CREATE ROLE "reviewed_role" NOLOGIN;',
    notes: ['PostgreSQL validates authority.'], fingerprint: 'private catalog identity'
  }

  it('accepts structured actions and requires an acknowledged host review to apply', () => {
    expect(preparePrincipalChangeSchema.parse(request)).toEqual(request)
    expect(preparePrincipalChangeSchema.safeParse({ ...request, sql: 'DROP ROLE admin' }).success).toBe(false)
    expect(preparePrincipalChangeSchema.safeParse({ ...request, change: { action: 'drop', roleId: 'x' } }).success).toBe(false)
    expect(preparePrincipalChangeSchema.safeParse({ ...request, change: {
      action: 'grant-relation', roleId: '1', relation: { schema: 'public', name: 'item' }, privilege: 'ALL'
    } }).success).toBe(false)
    expect(preparePrincipalChangeSchema.safeParse({ ...request, change: { ...request.change, password: 'fixture' } }).success).toBe(false)
    const apply = { sessionId, reviewId: randomUUID(), confirmation: 'APPLY CREATE', acknowledge: true }
    expect(applyPrincipalChangeSchema.parse(apply)).toEqual(apply)
    expect(applyPrincipalChangeSchema.safeParse({ ...apply, sql: plan.sql }).success).toBe(false)
    expect(applyPrincipalChangeSchema.safeParse({ ...apply, acknowledge: false }).success).toBe(false)
  })

  it('keeps host-qualified accounts structured and consumes authority without the automatic commit acknowledgment', () => {
    const mysql = { sessionId, change: { engine: 'mysql' as const, action: 'create-login' as const, account: { user: 'name@team', host: 'localhost' } } }
    expect(preparePrincipalChangeSchema.parse(mysql)).toEqual(mysql)
    expect(preparePrincipalChangeSchema.safeParse({ ...mysql, change: {
      engine: 'mysql', action: 'drop', roleId: '10'
    } }).success).toBe(false)
    expect(preparePrincipalChangeSchema.safeParse({ ...mysql, change: { ...mysql.change, password: 'fixture' } }).success).toBe(false)
    const reviews = new PrincipalReviews()
    const review = reviews.retain(mysql, { ...plan, implicitCommit: true })
    expect(review.implicitCommit).toBe(true)
    const apply = { sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true as const }
    expect(() => reviews.consume(apply)).toThrow('automatic commit')
    expect(() => reviews.consume({ ...apply, acknowledgeImplicitCommit: true })).toThrow('connection that will apply')
  })

  it('binds server reviews to their originating database and accepts a new secret only at apply', () => {
    const request = { sessionId, change: { engine: 'azure-sql' as const, scope: 'server' as const, action: 'create-login' as const, name: 'new_login' } }
    const reviewed = { ...plan, database: 'master', sql: 'CREATE LOGIN [new_login] WITH PASSWORD = @newPassword;', requiresPassword: true as const }
    expect(preparePrincipalChangeSchema.safeParse({ ...request, change: { ...request.change, newPassword: 'fixture' } }).success).toBe(false)
    const reviews = new PrincipalReviews()
    const review = reviews.retain(request, reviewed, 'application')
    const apply = { sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true as const, newPassword: 'fixture' }
    expect(review).toMatchObject({ database: 'master', requiresPassword: true })
    expect(reviews.consume(apply)).toMatchObject({ sourceDatabase: 'application', plan: reviewed })
    expect(JSON.stringify(review)).not.toContain(apply.newPassword)
    const ordinary = reviews.retain(request, plan)
    expect(() => reviews.consume({ ...apply, reviewId: ordinary.id })).toThrow('does not accept a password')
  })

  it('replaces old authority, isolates public review data, and consumes valid authority once', () => {
    const reviews = new PrincipalReviews()
    const first = reviews.retain(request, plan), current = reviews.retain(request, plan)
    const apply = { sessionId, reviewId: current.id, confirmation: current.confirmation, acknowledge: true as const }
    expect(current).not.toHaveProperty('fingerprint')
    current.notes[0] = 'Renderer copy changed'
    current.sql = 'DROP ROLE admin;'
    expect(() => reviews.consume({ ...apply, reviewId: first.id })).toThrow('connection that will apply')
    expect(() => reviews.consume({ ...apply, sessionId: randomUUID() })).toThrow('connection that will apply')
    expect(reviews.consume(apply).plan).toEqual(plan)
    expect(() => reviews.consume(apply)).toThrow('connection that will apply')
  })

  it('invalidates expired or incorrectly confirmed authority and forgets disconnected sessions', () => {
    vi.useFakeTimers()
    const reviews = new PrincipalReviews()
    const apply = () => {
      const review = reviews.retain(request, plan)
      return { sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true as const }
    }
    const expired = apply()
    vi.advanceTimersByTime(120_000)
    expect(() => reviews.consume(expired)).toThrow('expired')
    const wrong = apply()
    expect(() => reviews.consume({ ...wrong, confirmation: 'apply create' })).toThrow('confirmation did not match')
    expect(() => reviews.consume(wrong)).toThrow('connection that will apply')
    const disconnected = apply()
    reviews.forget(sessionId)
    expect(() => reviews.consume(disconnected)).toThrow('connection that will apply')
  })
})

describe('reviewed logical Azure SQL server principals', () => {
  const base = { engine: 'azure-sql', scope: 'server' } as const
  const lookup = async () => { throw new Error('Unexpected extra catalog connection.') }
  const login = ['14', 'new_login', 'S', '0x0102', '2026-11-04T08:00:00', '0', '0', '0']
  const role = ['21', '##MS_LoginManager##', 'R', '0x0103', '2026-11-04T08:00:00', '1', '0', '0']

  it('uses the master login view and supports predefined role membership', async () => {
    let granted = false
    const query = vi.fn(async (sql: string, binds: (string | null)[] = []): Promise<(string | null)[][]> => {
      if (sql.startsWith('SELECT DB_NAME()')) return [['master', 'observer', '5']]
      if (sql.includes('FROM sys.server_role_members')) return granted ? [['1']] : []
      if (sql.includes('sys.sql_logins')) return [binds[0] === '21' ? role : login]
      throw new Error('Unexpected catalog query.')
    })
    const plan = await planSqlServerPrincipalChange(query, { ...base, action: 'grant', roleId: '21', member: 'new_login' }, lookup)
    expect(plan.sql).toBe('ALTER SERVER ROLE [##MS_LoginManager##] ADD MEMBER [new_login];')
    expect(plan.notes.join(' ')).toContain('built-in permissions')
    granted = true
    await plan.verify()
    expect(query.mock.calls.some(([sql]) => sql.includes('sys.sql_logins') && !sql.includes('password_hash'))).toBe(true)
  })

  it('refuses server role creation and removal without cross-database mapping visibility', async () => {
    const query = vi.fn(async (sql: string, binds: (string | null)[] = []): Promise<(string | null)[][]> =>
      sql.startsWith('SELECT DB_NAME()') ? [['master', 'observer', '5']] : binds[0] === '14' ? [login] : [])
    await expect(planSqlServerPrincipalChange(query, { ...base, action: 'create', name: 'role' }, lookup)).rejects.toThrow('predefined server roles')
    await expect(planSqlServerPrincipalChange(query, { ...base, action: 'drop', roleId: '14' }, lookup)).rejects.toThrow('cross-database')
    expect(query.mock.calls.every(([sql]) => !sql.includes('sys.databases'))).toBe(true)
  })
})

describe('reviewed Oracle container authority', () => {
  it('refuses root and seed scope before reading principal metadata', async () => {
    for (const id of ['1', '2']) {
      const query = vi.fn(async () => [[id === '1' ? 'CDB$ROOT' : 'PDB$SEED', 'SYSTEM', id, 'FREE']])
      await expect(planOraclePrincipalChange(query, { engine: 'oracle', action: 'create', name: 'USER_ROLE' })).rejects.toThrow('local container')
      expect(query).toHaveBeenCalledTimes(1)
    }
  })

  it('requires tagged Oracle identities and a local, non-maintained principal', async () => {
    const sessionId = randomUUID()
    expect(preparePrincipalChangeSchema.safeParse({ sessionId, change: { engine: 'oracle', action: 'drop', roleId: '1' } }).success).toBe(false)
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT USERNAME')
      ? [['C##TEST', 'user', '79', '2026-11-04 09:00:00', 'YES', 'N', 'YES', 'PASSWORD', 'OPEN']]
      : [['FREEPDB1', 'SYSTEM', '3', 'FREE']])
    await expect(planOraclePrincipalChange(query, {
      engine: 'oracle', action: 'disable-login', roleId: JSON.stringify(['oracle', 'C##TEST', 'user'])
    })).rejects.toThrow('common principals')
  })
})
