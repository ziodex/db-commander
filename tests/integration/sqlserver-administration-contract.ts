import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { openSqlServer, sqlServerBound, sqlServerQuery } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { AdministrationChange, AdministrationReview } from '../../src/shared/database-administration'
import { quoteIdentifier } from '../../src/shared/sql/common'

export async function verifySqlServerAdministration(config: ConnectionConfig) {
  const suffix = randomUUID().slice(0, 8), database = `A2 ] ${suffix}`, destination = `A2 renamed ${suffix}`, table = `a2_${suffix}`
  const quoted = (name: string) => quoteIdentifier(name, 'sqlserver')
  const target = `[dbo].${quoted(table)}`
  const events: DatabaseEvent[] = []
  const registry = new DriverRegistry(event => { events.push(event) })
  const privileged = { ...config, user: 'sa', password: 'Local-SA-Only!2026' }
  const fixture = await openSqlServer(privileged)
  const lifecycle = await openSqlServer({ ...privileged, database: 'master' })
  const exists = async (name: string) => (await sqlServerBound(lifecycle, 'SELECT name FROM sys.databases WHERE name=@p1', [name])).rows.length > 0
  const drop = (name: string) => ({ action: 'drop-database', database: name } as const)
  const create = { action: 'create-database', database } as const
  const rename = { action: 'rename-database', database, destination } as const
  try {
    const session = await registry.connect({ ...privileged, environment: 'production' })
    const restricted = await registry.connect(config)
    const prepare = (change: AdministrationChange, sessionId = session.id) => registry.prepareAdministration({ sessionId, change })
    const apply = (review: AdministrationReview) => registry.applyAdministration({ sessionId: session.id, reviewId: review.id, confirmation: review.confirmation, acknowledge: true })
    async function execute(sql: string) {
      events.length = 0
      registry.start({ sessionId: session.id, sql, maxRows: 10 })
      await registry.wait(session.id)
      expect(events.find(event => event.type === 'complete')).toMatchObject({ status: 'completed' })
    }
    await expect(async () => prepare(create, restricted.id)).rejects.toThrow('creation permission')
    const locked = await prepare(create)
    await expect(async () => apply(locked)).rejects.toThrow('protected connection is locked')
    expect(await exists(database)).toBe(false)
    registry.unlockSession(session.id, config.name)
    await execute('SET IMPLICIT_TRANSACTIONS ON')
    await expect(async () => prepare(create)).rejects.toThrow('enable autocommit')
    await execute('SET IMPLICIT_TRANSACTIONS OFF; CREATE TABLE #a2_retained(value int); INSERT INTO #a2_retained VALUES (42)')
    await expect(async () => prepare({ ...create, database: 'master' })).rejects.toThrow('non-system')
    if (config.engine === 'sqlserver') await expect(async () => prepare(drop(config.database.toUpperCase()))).rejects.toThrow('different database')
    const reviewed = await prepare(create)
    expect(reviewed).toMatchObject({ database: 'master', sql: `CREATE DATABASE ${quoted(database)};` })
    expect(await exists(database)).toBe(false)
    expect(await apply(reviewed)).toMatchObject({ status: 'applied' })
    await expect(async () => prepare(create)).rejects.toThrow('already exists')
    if (config.engine === 'sqlserver') {
      await expect(async () => prepare(drop(database), restricted.id)).rejects.toThrow('sysadmin')
      const busy = await openSqlServer({ ...privileged, database })
      try {
        await expect(async () => prepare(rename)).rejects.toThrow('Close connections')
        await expect(async () => prepare(drop(database))).rejects.toThrow('Close connections')
      } finally { busy.close() }

      const stale = await prepare(drop(database))
      await sqlServerQuery(lifecycle, `DROP DATABASE ${quoted(database)}`)
      await sqlServerQuery(lifecycle, `CREATE DATABASE ${quoted(database)}`)
      await expect(async () => apply(stale)).rejects.toThrow('reviewed database or table changed')
      expect(await exists(database)).toBe(true)
      const reviewedRename = await prepare(rename)
      expect(reviewedRename.sql).toBe(`ALTER DATABASE ${quoted(database)} MODIFY NAME = ${quoted(destination)};`)
      expect(await apply(reviewedRename)).toMatchObject({ status: 'applied' })
      expect(await exists(database)).toBe(false)
      expect(await exists(destination)).toBe(true)
      const reviewedDrop = await prepare(drop(destination))
      expect(reviewedDrop.sql).toBe(`DROP DATABASE ${quoted(destination)};`)
      expect(await apply(reviewedDrop)).toMatchObject({ status: 'applied' })
      expect(await exists(destination)).toBe(false)
    } else {
      await expect(async () => prepare(rename)).rejects.toThrow('unavailable')
      await expect(async () => prepare(drop(database))).rejects.toThrow('unavailable')
    }

    await sqlServerQuery(fixture, `CREATE TABLE ${target}(id int PRIMARY KEY, val int); INSERT INTO ${target} VALUES (1,7),(2,9)`)
    const analyze = { action: 'analyze-table', schema: 'dbo', table } as const
    const reindex = { ...analyze, action: 'reindex-table' } as const
    const nativeIndex = async () => (await sqlServerBound(fixture, `SELECT p.hobt_id,
      CONVERT(nvarchar(30), STATS_DATE(p.object_id,p.index_id),126) FROM sys.partitions p
      WHERE p.object_id=OBJECT_ID(@p1) AND p.index_id=1`, [target])).rows[0]
    const before = await nativeIndex()
    const reviewedStats = await prepare(analyze)
    expect(reviewedStats.sql).toBe(`UPDATE STATISTICS ${target};`)
    expect(await apply(reviewedStats)).toMatchObject({ status: 'applied' })
    const updated = await nativeIndex()
    expect(updated[1]).toBeTruthy()
    expect(updated[1]).not.toBe(before[1])
    const staleIndex = await prepare(reindex)
    await sqlServerQuery(fixture, `CREATE INDEX a2_added ON ${target}(val)`)
    await expect(async () => apply(staleIndex)).rejects.toThrow('reviewed database or table changed')
    const reviewedRebuild = await prepare(reindex)
    expect(reviewedRebuild.sql).toBe(`ALTER INDEX ALL ON ${target} REBUILD;`)
    expect(await apply(reviewedRebuild)).toMatchObject({ status: 'applied' })
    expect((await nativeIndex())[0]).not.toBe(updated[0])
    await sqlServerQuery(fixture, `CREATE INDEX a2_filtered ON ${target}(val) WHERE val>0`)
    await expect(async () => prepare(reindex)).rejects.toThrow('unfiltered rowstore')
    await execute('SELECT value FROM #a2_retained')
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : [])).toEqual([['42']])
    expect(registry.getSession(session.id)).toMatchObject({ database: config.database, transaction: 'idle', autocommit: true })
  } finally {
    await registry.close()
    try {
      await sqlServerQuery(fixture, `DROP TABLE IF EXISTS ${target}`)
      for (const name of [database, destination]) {
        if (await exists(name)) await sqlServerQuery(lifecycle, `DROP DATABASE ${quoted(name)}`)
      }
    } finally { fixture.close(); lifecycle.close() }
  }
}
