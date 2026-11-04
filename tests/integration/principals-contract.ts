import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import pg from 'pg'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'

export async function verifyPostgresPrincipals(config: ConnectionConfig) {
  const prefix = 'principal_' + randomUUID().slice(0, 8)
  const q = (name: string) => quoteIdentifier(name)
  const observer = prefix + '_observer', member = prefix + '_member', team = prefix + '_team', reader = prefix + '_reader', hidden = prefix + '_hidden'
  const fixturePassword = 'Local-Principal-Test-Only!'
  const admin = new pg.Client({ host: config.host, port: config.port, user: config.user, password: config.password,
    database: config.database, ssl: { rejectUnauthorized: true, ca: config.ca } })
  const driver = new DriverRegistry(() => {}, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  await admin.connect()
  try {
    await admin.query(`
      CREATE ROLE ${q(observer)} LOGIN PASSWORD '${fixturePassword}';
      CREATE ROLE ${q(member)} NOLOGIN;
      CREATE ROLE ${q(team)} NOLOGIN;
      CREATE ROLE ${q(reader)} NOLOGIN;
      CREATE ROLE ${q(hidden)} NOLOGIN;
      GRANT ${q(team)} TO ${q(member)};
      GRANT ${q(reader)} TO ${q(team)};
      GRANT ${q(hidden)} TO ${q(member)} WITH INHERIT FALSE, SET FALSE;
      CREATE SCHEMA ${q(prefix)};
      GRANT USAGE ON SCHEMA ${q(prefix)} TO ${q(observer)}, ${q(member)};
      CREATE TABLE ${q(prefix)}.visible (id int);
      CREATE TABLE ${q(prefix)}.hidden (id int);
      ALTER TABLE ${q(prefix)}.visible ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON ${q(prefix)}.visible TO ${q(reader)}, ${q(observer)};
      GRANT UPDATE ON ${q(prefix)}.visible TO ${q(member)} WITH GRANT OPTION;
      GRANT INSERT ON ${q(prefix)}.visible TO PUBLIC;`)
    const session = await driver.connect({ ...config, user: observer, password: fixturePassword })
    const sessionId = session.id
    const roles = await driver.inspectPrincipals({ sessionId, mode: 'roles', search: prefix })
    expect(roles).toMatchObject({ mode: 'roles', observer, database: config.database, roles: { truncated: false } })
    if (roles.mode !== 'roles') throw new Error('Expected role list')
    const roleId = roles.roles.rows.find(role => role.name === member)!.id
    expect(roles.roles.rows.map(role => role.name)).toHaveLength(5)
    const detail = await driver.inspectPrincipals({ sessionId, mode: 'role', roleId, relation: { schema: prefix, name: 'visible' } })
    expect(detail).toMatchObject({ mode: 'role', role: { name: member, login: false, superuser: false }, relation: { schemaUsage: true, rowSecurity: true } })
    if (detail.mode !== 'role') throw new Error('Expected role inspection')
    expect(detail.direct.rows).toEqual(expect.arrayContaining([expect.objectContaining({ role: team, member, inherit: true, set: true }), expect.objectContaining({ role: hidden, member, inherit: false, set: false })]))
    expect(detail.memberships.rows).toEqual(expect.arrayContaining([{ role: reader, usable: true }, { role: hidden, usable: false }]))
    expect(detail.databasePrivileges).toContainEqual({ privilege: 'CONNECT', effective: true, grantable: false })
    expect(detail.relation!.privileges).toEqual(expect.arrayContaining([
      { privilege: 'SELECT', effective: true, grantable: false },
      { privilege: 'UPDATE', effective: true, grantable: true },
      { privilege: 'INSERT', effective: true, grantable: false },
      { privilege: 'DELETE', effective: false, grantable: false }
    ]))
    expect(detail.relation!.grants.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantee: member, privilege: 'UPDATE', grantable: true }),
      expect.objectContaining({ grantee: 'PUBLIC', privilege: 'INSERT' })
    ]))
    expect(detail.relation!.grants.rows.some(grant => grant.privilege === 'SELECT')).toBe(false)
    const inaccessible = await driver.inspectPrincipals({ sessionId, mode: 'role', roleId, relation: { schema: prefix, name: 'hidden' } })
    expect(inaccessible).toMatchObject({ relation: null })
    expect(await driver.inspectPrincipals({ sessionId, mode: 'roles', search: prefix + '%' })).toMatchObject({ roles: { rows: [] } })
    await expect(Promise.resolve().then(() => driver.inspectPrincipals({ sessionId, mode: 'role', roleId: '0' }))).rejects.toThrow('no longer visible')
    driver.start({ sessionId, sql: 'BEGIN', maxRows: 1 })
    await driver.wait(sessionId)
    expect(() => driver.inspectPrincipals({ sessionId, mode: 'roles', search: prefix })).toThrow('settle the transaction')
    driver.start({ sessionId, sql: 'ROLLBACK', maxRows: 1 })
    await driver.wait(sessionId)
    expect(driver.getSession(sessionId).transaction).toBe('idle')
  } finally {
    await driver.close()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${q(prefix)} CASCADE; DROP ROLE IF EXISTS ${[observer, member, team, reader, hidden].map(q).join(', ')};`) }
    finally { await admin.end() }
  }
}
