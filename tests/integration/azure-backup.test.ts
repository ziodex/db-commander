import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'

// Opt-in because Azure SQL copies provision billed resources. Docker SQL Server
// validates the native .bak path and TDS transport, not Azure service behavior.
it.skipIf(process.env.SQLCOMMANDER_AZURE_BACKUP_TEST !== '1')('live Azure recovery-copy round trip (creates two billed databases)', async () => {
  const config: ConnectionConfig = { engine: 'azure-sql', name: 'Azure backup contract', host: process.env.SQLCOMMANDER_AZURE_HOST!, port: 1433,
    database: process.env.SQLCOMMANDER_AZURE_DATABASE!, user: process.env.SQLCOMMANDER_AZURE_USER!, password: process.env.SQLCOMMANDER_AZURE_PASSWORD ?? '',
    authentication: process.env.SQLCOMMANDER_AZURE_TOKEN ? 'entra-token' : 'sql-password', accessToken: process.env.SQLCOMMANDER_AZURE_TOKEN, tls: 'verify-full' }
  if (!config.host || !config.database || !config.user) throw new Error('Configure a disposable Azure SQL test server and source database first.')
  const suffix = randomUUID().replaceAll('-', ''), copy = `sc_backup_${suffix}`, target = `sc_restore_${suffix}`
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) })
  const session = await driver.connect(config)
  async function query(id: string, sql: string) {
    events.length = 0; driver.start({ sessionId: id, sql, maxRows: 1000 }); await driver.wait(id)
    expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' ? event.rows : [])
  }
  try {
    const expected = await query(session.id, 'SELECT name FROM sys.tables ORDER BY name')
    expect(expected.length, 'Seed the disposable source database before running this test.').toBeGreaterThan(0)
    const backup = driver.startBackup({ sessionId: session.id, action: 'backup', artifact: copy, content: 'all', confirmed: true })
    expect(await driver.waitBackup(backup.id)).toMatchObject({ status: 'completed' })
    const restore = driver.startBackup({ sessionId: session.id, action: 'restore', artifact: copy, target, content: 'all', confirmed: true })
    expect(await driver.waitBackup(restore.id)).toMatchObject({ status: 'completed' })
    const restored = await driver.connect({ ...config, database: target })
    expect(await query(restored.id, 'SELECT name FROM sys.tables ORDER BY name')).toEqual(expected)
    await driver.disconnect(restored.id)
    const duplicate = driver.startBackup({ sessionId: session.id, action: 'restore', artifact: copy, target, content: 'all', confirmed: true })
    expect(await driver.waitBackup(duplicate.id)).toMatchObject({ status: 'failed' })
  } finally {
    await driver.disconnect(session.id).catch(() => {})
    const admin = await driver.connect({ ...config, database: 'master' })
    for (const name of [target, copy]) await query(admin.id, `IF DB_ID(N'${name}') IS NOT NULL DROP DATABASE [${name}]`).catch(() => {})
    await driver.close()
  }
}, 30 * 60 * 1000)
