import { randomUUID } from 'node:crypto'
import oracledb from 'oracledb'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { oracleConnectionOptions } from '../../src/driver/oracle'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { AdministrationChange, AdministrationReview } from '../../src/shared/database-administration'

export async function verifyOracleAdministration(config: ConnectionConfig) {
  const suffix = randomUUID().slice(0, 8).toUpperCase()
  const table = `A2 '${suffix}`, target = `"DBCOMMANDER"."${table}"`, first = `A2_A_${suffix}`, second = `A2_Z_${suffix}`, trigger = `A2_TRG_${suffix}`
  const registry = new DriverRegistry(event => { events.push(event) })
  const events: DatabaseEvent[] = []
  const fixture = await oracledb.getConnection(oracleConnectionOptions(config))
  fixture.callTimeout = 15_000
  const nativeIndexes = async () => (await fixture.execute<unknown[]>(`SELECT object_name,data_object_id FROM user_objects
    WHERE object_name IN (:1,:2) AND object_type='INDEX' ORDER BY object_name`, [first, second], { outFormat: oracledb.OUT_FORMAT_ARRAY })).rows!
  try {
    const session = await registry.connect({ ...config, environment: 'production' })
    const prepare = (change: AdministrationChange) => registry.prepareAdministration({ sessionId: session.id, change })
    const apply = (review: AdministrationReview) => registry.applyAdministration({ sessionId: session.id, reviewId: review.id, confirmation: review.confirmation, acknowledge: true })
    const analyze = { action: 'analyze-table', schema: 'DBCOMMANDER', table } as const
    const rebuild = { ...analyze, action: 'reindex-table' } as const
    async function execute(sql: string) {
      events.length = 0
      registry.start({ sessionId: session.id, sql, maxRows: 10 })
      await registry.wait(session.id)
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'completed' })
    }
    await fixture.execute(`CREATE TABLE ${target}(id int, val int)`)
    await fixture.execute(`INSERT INTO ${target} VALUES(1,7)`, [], { autoCommit: true })
    await expect(async () => prepare({ action: 'create-database', database: 'new_pdb' })).rejects.toThrow('unavailable')
    await expect(async () => prepare({ ...analyze, schema: 'SYS' })).rejects.toThrow('owned by the connected user')
    await expect(async () => prepare({ ...analyze, table: 'RETAINED' })).rejects.toThrow('ordinary persistent table')
    const locked = await prepare(analyze)
    await expect(async () => apply(locked)).rejects.toThrow('protected connection is locked')
    registry.unlockSession(session.id, config.name)
    await execute('INSERT INTO retained VALUES(42)')
    await expect(async () => prepare(analyze)).rejects.toThrow('settle the transaction')
    await execute('COMMIT')
    const reviewed = await prepare(analyze)
    expect(reviewed.sql).toContain(`tabname => '"A2 ''${suffix}"'`)
    expect(await apply(reviewed)).toMatchObject({ status: 'applied' })
    expect((await fixture.execute(`SELECT num_rows FROM user_tables WHERE table_name=:1`, [table], { outFormat: oracledb.OUT_FORMAT_ARRAY })).rows).toEqual([[1]])

    await fixture.execute(`BEGIN SYS.DBMS_STATS.LOCK_TABLE_STATS('DBCOMMANDER', :1); END;`, ['"' + table + '"'])
    await expect(async () => prepare(analyze)).rejects.toThrow('statistics are unavailable or locked')
    await fixture.execute(`BEGIN SYS.DBMS_STATS.UNLOCK_TABLE_STATS('DBCOMMANDER', :1); END;`, ['"' + table + '"'])
    await expect(async () => prepare(rebuild)).rejects.toThrow('B-tree indexes')
    await fixture.execute(`CREATE INDEX ${first} ON ${target}(id)`)
    const stale = await prepare(rebuild)
    await fixture.execute(`CREATE INDEX ${second} ON ${target}(val)`)
    await expect(async () => apply(stale)).rejects.toThrow('table or indexes changed')
    const old = await nativeIndexes()
    await fixture.execute(`CREATE TRIGGER ${trigger} BEFORE ALTER ON SCHEMA
      BEGIN IF ORA_DICT_OBJ_NAME = '${second}' THEN RAISE_APPLICATION_ERROR(-20003, 'fixture denies second index'); END IF; END;`)
    const partial = await prepare(rebuild)
    expect(partial.sql).toContain(`ALTER INDEX "DBCOMMANDER"."${first}" REBUILD`)
    expect(partial.notes.join(' ')).toContain('earlier rebuilds can remain applied')
    expect(await apply(partial)).toMatchObject({ status: 'partial' })
    const afterPartial = await nativeIndexes()
    expect(afterPartial[0][1]).not.toBe(old[0][1])
    expect(afterPartial[1][1]).toBe(old[1][1])
    await fixture.execute(`DROP TRIGGER ${trigger}`)
    expect(await apply(await prepare(rebuild))).toMatchObject({ status: 'applied' })
    const after = await nativeIndexes()
    expect(after[0][1]).not.toBe(afterPartial[0][1])
    expect(after[1][1]).not.toBe(afterPartial[1][1])
    await execute('SELECT value FROM retained')
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : [])).toEqual([['42']])
    expect(registry.getSession(session.id)).toMatchObject({ database: session.database, transaction: 'idle' })
  } finally {
    await registry.close()
    try { await fixture.execute(`DROP TRIGGER ${trigger}`).catch(() => {}); await fixture.execute(`DROP TABLE ${target} PURGE`).catch(() => {}) }
    finally { await fixture.close() }
  }
}
