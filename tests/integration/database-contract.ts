import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'

/** Real Docker servers, including restricted logins and a quoted target name. */
export async function verifyDatabaseBrowsing(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], registry = new DriverRegistry(event => { events.push(event) })
  const pg = config.engine === 'postgres', mysql = ['mysql', 'mariadb'].includes(config.engine)
  const target = "team's data", credentials = { ...config, user: 'browser_user', database: '' }
  let a = await registry.connect(credentials)
  const b = await registry.connect({ ...credentials, database: 'dbcommander' })
  async function run(id: string, sql: string) {
    const queryId = registry.start({ sessionId: id, sql, maxRows: 100 })
    await registry.wait(id)
    expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  const context = pg ? 'SELECT current_database()' : mysql ? 'SELECT DATABASE()' : 'SELECT DB_NAME()'
  try {
    expect(a.database).toBe(pg ? 'postgres' : mysql ? '' : config.engine === 'azure-sql' ? 'master' : 'dbcommander')
    expect(await run(a.id, context)).toEqual([[a.database || null]])
    if (mysql) expect((await registry.schema(a.id)).objects).toEqual([])
    const catalog = await registry.databases(a.id)
    expect(catalog.switchable).toBe(true)
    expect(catalog.databases).toEqual(expect.arrayContaining(['dbcommander', target]))
    expect(catalog.databases).not.toContain('private_database')
    expect(await run(a.id, context)).toEqual([[a.database || null]]) // discovery did not change context
    await run(b.id, pg ? 'CREATE TEMP TABLE private_temp(id int); INSERT INTO private_temp VALUES(91)' : mysql ? 'CREATE TEMPORARY TABLE private_temp(id int); INSERT INTO private_temp VALUES(91)' : 'CREATE TABLE #private_temp(id int); INSERT INTO #private_temp VALUES(91)')
    const oldId = a.id
    const pending = registry.switchDatabase({ sessionId: a.id, database: target })
    expect(() => registry.start({ sessionId: oldId, sql: 'SELECT 1', maxRows: 10 })).toThrow(/operation/)
    await expect(registry.disconnect(oldId)).rejects.toThrow(/operation/)
    await expect(registry.switchDatabase({ sessionId: oldId, database: target })).rejects.toThrow(/operation/)
    a = await pending
    expect(a.id).not.toBe(oldId)
    expect(() => registry.getSession(oldId)).toThrow(/disconnected/)
    expect(await run(a.id, context)).toEqual([[target]])
    expect(await run(a.id, 'SELECT id,label FROM switch_marker')).toEqual([['7', 'target database']])
    const schema = await registry.schema(a.id)
    expect(schema.database).toBe(target)
    expect(schema.objects.map(table => table.name)).toContain('switch_marker')
    expect(schema.objects.map(table => table.name)).not.toContain('customers')
    expect(await run(b.id, `SELECT id FROM ${pg || mysql ? 'private_temp' : '#private_temp'}`)).toEqual([['91']])
    expect(await run(b.id, context)).toEqual([['dbcommander']])
    for (const database of ['missing_database', 'private_database', "missing'; DROP TABLE switch_marker; --"]) {
      await expect(registry.switchDatabase({ sessionId: a.id, database })).rejects.toThrow()
      expect(await run(a.id, 'SELECT id FROM switch_marker')).toEqual([['7']])
    }
    await run(a.id, pg || mysql ? 'BEGIN' : 'BEGIN TRANSACTION')
    await run(a.id, "UPDATE switch_marker SET label='pending' WHERE id=7")
    await expect(registry.switchDatabase({ sessionId: a.id, database: 'dbcommander' })).rejects.toThrow(/Commit or roll back/)
    await registry.databases(a.id)
    expect(registry.getSession(a.id).transaction).toBe('transaction')
    await run(a.id, 'ROLLBACK')
    if (!pg) {
      await run(a.id, mysql ? 'SET autocommit=0' : 'SET IMPLICIT_TRANSACTIONS ON')
      await expect(registry.switchDatabase({ sessionId: a.id, database: 'dbcommander' })).rejects.toThrow(/autocommit/)
      await run(a.id, mysql ? 'SET autocommit=1' : 'SET IMPLICIT_TRANSACTIONS OFF')
    }
    registry.start({ sessionId: a.id, sql: pg ? 'SELECT pg_sleep(3)' : mysql ? 'SELECT SLEEP(3)' : "WAITFOR DELAY '00:00:03'", maxRows: 10 })
    await expect(registry.switchDatabase({ sessionId: a.id, database: 'dbcommander' })).rejects.toThrow(/running query/)
    await registry.cancel(a.id); await registry.wait(a.id)
    a = await registry.switchDatabase({ sessionId: a.id, database: 'dbcommander' })
    expect(await run(a.id, context)).toEqual([['dbcommander']])
    expect(registry.getSession(b.id).database).toBe('dbcommander')
  } finally { await registry.close() }
}
