import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { mysqlPrincipalSql, previewMysqlPrincipalChange } from '../../src/shared/principals'

export async function verifyMysqlPrincipals(config: ConnectionConfig) {
  const engine = config.engine === 'mariadb' ? 'mariadb' : 'mysql'
  const adminConfig = { ...config, user: 'root', password: 'local-root-test-only' }
  const admin = await openMysqlTransport(adminConfig)
  const registry = new DriverRegistry(() => {})
  const prefix = 'a1_' + randomUUID().slice(0, 8)
  const account = { user: prefix + '@member', host: '%' }
  const role = { user: prefix + '_reader', host: engine === 'mysql' ? '%' : '' }
  const parent = { user: prefix + '_parent', host: role.host }
  const userName = mysqlPrincipalSql(engine, account)
  const roleName = mysqlPrincipalSql(engine, role)
  const parentName = mysqlPrincipalSql(engine, parent)
  const relation = { schema: config.database, name: 'customers' }
  try {
    await admin.query(`CREATE USER ${userName} IDENTIFIED BY 'local-principal-test-only'`)
    await admin.query(previewMysqlPrincipalChange(engine, { action: 'create', role }))
    await admin.query(previewMysqlPrincipalChange(engine, { action: 'create', role: parent }))
    await admin.query(previewMysqlPrincipalChange(engine, { action: 'grant-relation', role, relation, privilege: 'SELECT' }))
    await admin.query(previewMysqlPrincipalChange(engine, { action: 'grant', role, member: parent }))
    await admin.query(previewMysqlPrincipalChange(engine, { action: 'grant', role: parent, member: account }))
    await admin.query(engine === 'mysql' ? `SET DEFAULT ROLE ${parentName} TO ${userName}` : `SET DEFAULT ROLE ${parentName} FOR ${userName}`)
    await admin.query(`GRANT SELECT ON dbcommander.customers TO ${userName}`)

    const session = await registry.connect(adminConfig)
    const listing = await registry.inspectPrincipals({ sessionId: session.id, mode: 'roles', search: prefix })
    if (listing.mode !== 'roles') throw new Error('Expected principal list.')
    expect(listing.roles.rows.map(item => item.name).sort()).toEqual([userName, roleName, parentName].sort())
    const selected = listing.roles.rows.find(item => item.name === userName)!
    const detail = await registry.inspectPrincipals({ sessionId: session.id, mode: 'role', roleId: selected.id, relation })
    expect(detail).toMatchObject({
      mode: 'role', role: { account }, direct: { rows: [{ role: parentName, member: userName }] },
      memberships: { rows: expect.arrayContaining([{ role: roleName, usable: null }, { role: parentName, usable: null }]) },
      catalog: { enabled: null, relation, grants: { rows: expect.arrayContaining([expect.objectContaining({ scope: 'Table dbcommander.customers', privilege: 'SELECT', grantable: false, via: undefined }), expect.objectContaining({ scope: 'Table dbcommander.customers', privilege: 'SELECT', via: roleName })]) } }
    })
    const roleDetail = await registry.inspectPrincipals({ sessionId: session.id, mode: 'role', roleId: listing.roles.rows.find(item => item.name === roleName)!.id, relation })
    expect(roleDetail).toMatchObject({ catalog: { relation, grants: { rows: expect.arrayContaining([expect.objectContaining({ scope: 'Table dbcommander.customers', privilege: 'SELECT', grantable: false })]) } } })
    const connected = await registry.connect({ ...config, user: account.user, password: 'local-principal-test-only' })
    const own = await registry.inspectPrincipals({ sessionId: connected.id, mode: 'roles', search: prefix })
    expect(own).toMatchObject({ notice: expect.stringContaining('restricted'), roles: { rows: [{ id: selected.id }] } })
    const restricted = await registry.inspectPrincipals({ sessionId: connected.id, mode: 'role', roleId: selected.id, relation })
    expect(restricted).toMatchObject({
      direct: { rows: expect.arrayContaining([expect.objectContaining({ role: parentName, member: userName })]) },
      catalog: { enabled: { rows: expect.arrayContaining([parentName]) }, relation, grants: { rows: expect.arrayContaining([expect.objectContaining({ scope: 'Table dbcommander.customers', privilege: 'SELECT', grantable: false })]) } },
      notice: expect.stringContaining('restricted')
    })
    await expect(Promise.resolve().then(() => registry.inspectPrincipals({ sessionId: connected.id, mode: 'role', roleId: listing.roles.rows.find(item => item.name === roleName)!.id }))).rejects.toThrow('only its own account')
  } finally {
    await registry.close()
    try {
      await admin.query(`DROP USER IF EXISTS ${userName}`)
      await admin.query(`DROP ROLE IF EXISTS ${parentName}, ${roleName}`)
    } finally { await admin.end() }
  }
}
