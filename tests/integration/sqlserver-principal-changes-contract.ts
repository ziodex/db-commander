import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openSqlServer, sqlServerBound, sqlServerQuery } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'
import type { PrincipalChangeReview, SqlServerPrincipalChange } from '../../src/shared/principal-changes'
import type { PrincipalScope } from '../../src/shared/principals'
import { quoteIdentifier } from '../../src/shared/sql/common'

type ChangeFields<T> = T extends SqlServerPrincipalChange ? Omit<T, 'engine' | 'scope'> : never

export async function verifySqlServerPrincipalChanges(config: ConnectionConfig, engine: 'sqlserver' | 'azure-sql') {
  const adminConfig = { ...config, engine, user: 'sa', password: 'Local-SA-Only!2026' }
  const admin = await openSqlServer(adminConfig)
  const driver = new DriverRegistry(() => {})
  const prefix = 'a1_' + randomUUID().slice(0, 8)
  const user = prefix + '_user', login = prefix + ']login', role = prefix + '_role'
  const next = prefix + '_renamed', standalone = prefix + '_standalone', serverRole = prefix + '_server'
  const secret = "Local-Test-Only!'2026"
  const relation = { schema: 'dbo', name: 'customers' }
  const quote = (name: string) => quoteIdentifier(name, 'sqlserver')
  const catalog = async (name: string, scope: PrincipalScope) => (await sqlServerBound(admin,
    scope === 'server'
      ? 'SELECT principal_id, CONVERT(varchar(172), sid, 1), is_disabled FROM sys.server_principals WHERE name = @p1'
      : 'SELECT principal_id, CONVERT(varchar(172), sid, 1), authentication_type_desc FROM sys.database_principals WHERE name = @p1',
    [name])).rows[0]
  try {
    const session = await driver.connect(adminConfig)
    const prepare = (change: ChangeFields<SqlServerPrincipalChange>, scope: PrincipalScope = 'database') =>
      Promise.resolve().then(() => driver.preparePrincipalChange({ sessionId: session.id, change: { engine, scope, ...change } }))
    const apply = (review: PrincipalChangeReview, newPassword?: string) =>
      Promise.resolve().then(() => driver.applyPrincipalChange({
        sessionId: session.id, reviewId: review.id, acknowledge: true, confirmation: review.confirmation, newPassword
      }))
    const run = async (sql: string) => {
      driver.start({ sessionId: session.id, sql, maxRows: 1 })
      await driver.wait(session.id)
    }

    const draft = await prepare({ action: 'create-login', name: login }, 'server')
    expect(draft).toMatchObject({ database: 'master', requiresPassword: true, implicitCommit: false,
      sql: `CREATE LOGIN ${quote(login)} WITH PASSWORD = @newPassword;` })
    expect(draft.sql).not.toContain(secret)
    expect(await catalog(login, 'server')).toBeUndefined()
    await expect(apply(draft)).rejects.toThrow('new login password')
    await expect(apply(draft, secret)).rejects.toThrow('connection that will apply')
    const active = await prepare({ action: 'create-login', name: login }, 'server')
    await run('BEGIN TRANSACTION')
    await expect(apply(active, secret)).rejects.toThrow('settle the transaction')
    await run('ROLLBACK TRANSACTION')
    expect(await apply(await prepare({ action: 'create-login', name: login }, 'server'), secret)).toMatchObject({ status: 'applied' })
    const [loginId, sid] = await catalog(login, 'server')

    const mapped = await prepare({ action: 'create-mapped-user', name: user, login })
    expect(mapped.sql).toBe(`CREATE USER ${quote(user)} FOR LOGIN ${quote(login)};`)
    expect(await apply(mapped)).toMatchObject({ status: 'applied' })
    const [userId, mappedSid] = await catalog(user, 'database')
    expect(mappedSid).toBe(sid)
    await expect(prepare({ action: 'drop', roleId: loginId! }, 'server')).rejects.toThrow('maps to this login')
    const loginConfig = { ...config, engine, user: login, password: secret }
    const connected = await openSqlServer(loginConfig)
    connected.close()
    expect(await apply(await prepare({ action: 'disable-login', roleId: loginId! }, 'server'))).toMatchObject({ status: 'applied' })
    expect((await catalog(login, 'server'))[2]).toBe('1')
    await expect(openSqlServer(loginConfig)).rejects.toThrow()
    expect(await apply(await prepare({ action: 'enable-login', roleId: loginId! }, 'server'))).toMatchObject({ status: 'applied' })

    expect(await apply(await prepare({ action: 'create-user', name: standalone }))).toMatchObject({ status: 'applied' })
    expect((await catalog(standalone, 'database'))[2]).toBe('NONE')
    expect(await apply(await prepare({ action: 'create', name: role }))).toMatchObject({ status: 'applied' })
    const [roleId] = await catalog(role, 'database')
    expect(await apply(await prepare({ action: 'grant', roleId: roleId!, member: user }))).toMatchObject({ status: 'applied' })
    await expect(prepare({ action: 'drop', roleId: roleId! })).rejects.toThrow('role membership')

    const grant = { action: 'grant-relation' as const, roleId: roleId!, relation, privilege: 'SELECT' as const }
    expect(await apply(await prepare(grant))).toMatchObject({ status: 'applied' })
    const deny = { ...grant, action: 'deny-relation' as const, roleId: userId! }
    expect(await apply(await prepare(deny))).toMatchObject({ status: 'applied' })
    const effective = () => sqlServerQuery(admin, `EXECUTE AS USER = '${user}';
      SELECT HAS_PERMS_BY_NAME('dbo.customers', 'OBJECT', 'SELECT'); REVERT;`)
    expect(await effective()).toEqual([['0']])
    const removeDeny = await prepare({ ...deny, action: 'revoke-relation' })
    expect(removeDeny.notes.join(' ')).toContain('Removing a denial')
    expect(await apply(removeDeny)).toMatchObject({ status: 'applied' })
    expect(await effective()).toEqual([['1']])
    expect(await apply(await prepare({ ...grant, action: 'revoke-relation' }))).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'revoke', roleId: roleId!, member: user }))).toMatchObject({ status: 'applied' })

    const stale = await prepare({ action: 'drop', roleId: roleId! })
    await sqlServerQuery(admin, `ALTER ROLE ${quote(role)} WITH NAME = ${quote(next)};`)
    await expect(apply(stale)).rejects.toThrow('changed')
    expect(await apply(await prepare({ action: 'rename', roleId: roleId!, name: role }))).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'drop', roleId: roleId! }))).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'drop', roleId: userId! }))).toMatchObject({ status: 'applied' })
    expect(await apply(await prepare({ action: 'drop', roleId: loginId! }, 'server'))).toMatchObject({ status: 'applied' })
    expect(await catalog(login, 'server')).toBeUndefined()

    if (engine === 'sqlserver') {
      expect(await apply(await prepare({ action: 'create', name: serverRole }, 'server'))).toMatchObject({ status: 'applied' })
      const [serverRoleId] = await catalog(serverRole, 'server')
      expect(await apply(await prepare({ action: 'drop', roleId: serverRoleId! }, 'server'))).toMatchObject({ status: 'applied' })
    } else await expect(prepare({ action: 'create', name: serverRole }, 'server')).rejects.toThrow('predefined server roles')
    expect(driver.getSession(session.id)).toMatchObject({ database: config.database, transaction: 'idle' })
  } finally {
    await driver.close()
    try {
      await sqlServerQuery(admin, `IF DATABASE_PRINCIPAL_ID('${user}') IS NOT NULL DROP USER ${quote(user)};
        IF DATABASE_PRINCIPAL_ID('${standalone}') IS NOT NULL DROP USER ${quote(standalone)};
        IF DATABASE_PRINCIPAL_ID('${next}') IS NOT NULL DROP ROLE ${quote(next)};
        IF DATABASE_PRINCIPAL_ID('${role}') IS NOT NULL DROP ROLE ${quote(role)};
        IF SUSER_ID('${serverRole}') IS NOT NULL DROP SERVER ROLE ${quote(serverRole)};
        IF SUSER_ID('${login}') IS NOT NULL DROP LOGIN ${quote(login)};`)
    } finally { admin.close() }
  }
}
