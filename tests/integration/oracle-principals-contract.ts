import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import oracledb from 'oracledb'
import { DriverRegistry } from '../../src/driver/registry'
import { oracleConnectionOptions } from '../../src/driver/oracle'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { previewOraclePrincipalChange } from '../../src/shared/principals'

export async function verifyOraclePrincipals(config: ConnectionConfig) {
  const adminConfig = { ...config, user: 'system', password: 'Local-Admin-Only2026' }
  const admin = await oracledb.getConnection(oracleConnectionOptions(adminConfig))
  const driver = new DriverRegistry(() => {})
  const prefix = 'A1_' + randomUUID().slice(0, 8).toUpperCase()
  const user = prefix + '_MEMBER', reader = prefix + '_READER', parent = prefix + '_PARENT'
  const relation = { schema: 'DBCOMMANDER', name: 'CUSTOMERS' }
  async function fixture(sql: string) { await admin.execute(sql.replace(/;$/, '')) }
  try {
    await fixture(`CREATE USER "${user}" IDENTIFIED BY "Local-Principal-Test-Only2026"`)
    await fixture(`GRANT CREATE SESSION TO "${user}"`)
    for (const name of [reader, parent]) await fixture(previewOraclePrincipalChange({ action: 'create', name }))
    await fixture(previewOraclePrincipalChange({ action: 'grant', role: reader, member: parent }))
    await fixture(previewOraclePrincipalChange({ action: 'grant', role: parent, member: user }))
    await fixture(previewOraclePrincipalChange({ action: 'grant-relation', role: reader, relation, privilege: 'SELECT' }))

    const session = await driver.connect(adminConfig)
    const list = await driver.inspectPrincipals({ sessionId: session.id, mode: 'roles', search: prefix })
    if (list.mode !== 'roles') throw new Error('Expected an Oracle principal list.')
    expect(list.roles.rows.map(role => role.name).sort()).toEqual([user, reader, parent].sort())
    const roleId = list.roles.rows.find(role => role.name === user)!.id
    const detail = await driver.inspectPrincipals({ sessionId: session.id, mode: 'role', roleId, relation })
    expect(detail).toMatchObject({
      database: config.database, observer: 'SYSTEM',
      direct: { rows: [expect.objectContaining({ role: parent, member: user })] },
      memberships: { rows: expect.arrayContaining([{ role: reader, usable: null }, { role: parent, usable: null }]) },
      catalog: { relation, enabled: null, grants: { rows: expect.arrayContaining([
        expect.objectContaining({ scope: 'Relation DBCOMMANDER.CUSTOMERS', privilege: 'SELECT', via: reader }),
        expect.objectContaining({ scope: 'System', privilege: 'CREATE SESSION', via: undefined })
      ]) } }
    })
    const restricted = await driver.connect({ ...config, user, password: 'Local-Principal-Test-Only2026' })
    const own = await driver.inspectPrincipals({ sessionId: restricted.id, mode: 'role', roleId, relation })
    expect(own).toMatchObject({
      notice: expect.stringContaining('restricted'), direct: { rows: expect.arrayContaining([expect.objectContaining({ role: parent, member: user })]) },
      catalog: { relation, enabled: { rows: expect.arrayContaining([parent, reader]) },
        effective: { rows: expect.arrayContaining([{ scope: 'System', privilege: 'CREATE SESSION' }]) },
        grants: { rows: expect.arrayContaining([expect.objectContaining({ privilege: 'SELECT', via: reader, enabled: true })]) } }
    })
  } finally {
    await driver.close()
    try {
      for (const command of [`DROP USER "${user}"`, `DROP ROLE "${parent}"`, `DROP ROLE "${reader}"`]) {
        try { await fixture(command) }
        catch (error) { if (![1918, 1919].includes(Number((error as { errorNum?: number }).errorNum))) throw error }
      }
    } finally { await admin.close() }
  }
}
