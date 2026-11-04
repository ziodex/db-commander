import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openSqlServer, sqlServerQuery } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { previewSqlServerPrincipalChange } from '../../src/shared/principals'
import { quoteIdentifier } from '../../src/shared/sql/common'

export async function verifySqlServerPrincipals(config: ConnectionConfig) {
  const adminConfig = { ...config, user: 'sa', password: 'Local-SA-Only!2026' }
  const admin = await openSqlServer(adminConfig)
  const driver = new DriverRegistry(() => {})
  const prefix = 'a1_' + randomUUID().slice(0, 8)
  const user = prefix + '_user', first = prefix + '_role', second = prefix + '_parent'
  const relation = { schema: 'dbo', name: 'customers' }
  const quote = (value: string) => quoteIdentifier(value, 'sqlserver')
  try {
    await sqlServerQuery(admin, `CREATE LOGIN ${quote(user)} WITH PASSWORD = 'Local-Principal-Test-Only!2026'`)
    await sqlServerQuery(admin, `CREATE USER ${quote(user)} FOR LOGIN ${quote(user)}`)
    for (const name of [first, second]) await sqlServerQuery(admin, previewSqlServerPrincipalChange('sqlserver', 'database', { action: 'create', name }))
    await sqlServerQuery(admin, previewSqlServerPrincipalChange('sqlserver', 'database', { action: 'grant', role: first, member: second }))
    await sqlServerQuery(admin, previewSqlServerPrincipalChange('sqlserver', 'database', { action: 'grant', role: second, member: user }))
    await sqlServerQuery(admin, previewSqlServerPrincipalChange('sqlserver', 'database', { action: 'grant-relation', role: first, relation, privilege: 'SELECT' }))
    await sqlServerQuery(admin, `DENY UPDATE ON OBJECT::dbo.customers TO ${quote(user)}`)

    for (const engine of ['sqlserver', 'azure-sql'] as const) {
      const adminSession = await driver.connect({ ...adminConfig, engine })
      const roles = await driver.inspectPrincipals({ sessionId: adminSession.id, scope: 'database', mode: 'roles', search: prefix })
      if (roles.mode !== 'roles') throw new Error('Expected database principal list.')
      expect(roles.roles.rows.map(role => role.name).sort()).toEqual([user, first, second].sort())
      const id = roles.roles.rows.find(role => role.name === user)!.id
      const selected = await driver.inspectPrincipals({ sessionId: adminSession.id, scope: 'database', mode: 'role', roleId: id, relation })
      expect(selected).toMatchObject({
        direct: { rows: [expect.objectContaining({ role: second, member: user })] },
        memberships: { rows: expect.arrayContaining([{ role: first, usable: null }, { role: second, usable: null }]) },
        catalog: { relation, grants: { rows: expect.arrayContaining([
          expect.objectContaining({ scope: 'Relation dbo.customers', privilege: 'SELECT', effect: 'GRANT', via: first }),
          expect.objectContaining({ scope: 'Relation dbo.customers', privilege: 'UPDATE', effect: 'DENY', via: undefined })
        ]) } }
      })
      const observer = await driver.connect({ ...config, engine, user, password: 'Local-Principal-Test-Only!2026' })
      const own = await driver.inspectPrincipals({ sessionId: observer.id, scope: 'database', mode: 'role', roleId: id, relation })
      expect(own).toMatchObject({ catalog: { effective: { rows: expect.arrayContaining([{ scope: 'Relation dbo.customers', privilege: 'SELECT' }]) } } })
      if (own.mode !== 'role') throw new Error('Expected database principal detail.')
      expect(own.catalog?.effective?.rows).not.toContainEqual({ scope: 'Relation dbo.customers', privilege: 'UPDATE' })
      const logins = await driver.inspectPrincipals({ sessionId: adminSession.id, scope: 'server', mode: 'roles', search: user })
      expect(logins).toMatchObject({ roles: { rows: [expect.objectContaining({ name: user })] } })
      if (logins.mode !== 'roles') throw new Error('Expected server principal list.')
      const login = await driver.inspectPrincipals({ sessionId: adminSession.id, scope: 'server', mode: 'role', roleId: logins.roles.rows[0].id })
      expect(login).toMatchObject({ role: { name: user }, catalog: { enabled: null } })
    }
  } finally {
    await driver.close()
    try {
      await sqlServerQuery(admin, `IF DATABASE_PRINCIPAL_ID('${user}') IS NOT NULL DROP USER ${quote(user)};
        IF DATABASE_PRINCIPAL_ID('${second}') IS NOT NULL DROP ROLE ${quote(second)};
        IF DATABASE_PRINCIPAL_ID('${first}') IS NOT NULL DROP ROLE ${quote(first)};
        IF SUSER_ID('${user}') IS NOT NULL DROP LOGIN ${quote(user)};`)
    } finally { admin.close() }
  }
}
