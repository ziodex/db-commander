import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { AdministrationChange, AdministrationReview } from '../../src/shared/database-administration'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'

export async function verifyEmbeddedAdministration(engine: 'sqlite' | 'duckdb') {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-embedded-administration-'))
  const filePath = join(directory, `reviewed.${engine}`)
  const config: ConnectionConfig = {
    engine, name: 'Embedded administration fixture', host: 'local', port: 1, database: 'local',
    user: 'local', password: '', tls: 'disable', filePath, [engine === 'sqlite' ? 'sqliteMode' : 'duckdbMode']: 'create'
  }
  const events: DatabaseEvent[] = []
  const registry = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  try {
    const session = await registry.connect({ ...config, environment: 'production' })
    const prepare = (change: AdministrationChange, sessionId = session.id) => registry.prepareAdministration({ sessionId, change })
    const apply = (review: AdministrationReview, sessionId = session.id) => registry.applyAdministration({ sessionId, reviewId: review.id, confirmation: review.confirmation, acknowledge: true })
    async function execute(sql: string, sessionId = session.id) {
      events.length = 0
      registry.start({ sessionId, sql, maxRows: 10 })
      await registry.wait(sessionId)
      const completed = events.find(event => event.type === 'complete')
      expect(completed, JSON.stringify(completed)).toMatchObject({ status: 'completed' })
      return events.flatMap(event => event.type === 'rows' ? event.rows : [])
    }
    registry.unlockSession(session.id, config.name)
    await execute("CREATE TABLE retained(value int); INSERT INTO retained VALUES (7); CREATE TEMP TABLE a2_temp(value int); INSERT INTO a2_temp VALUES (42)")
    if (engine === 'sqlite') {
      const table = "A2 ' scoped", target = `"main"."${table}"`
      const analyze = { action: 'analyze-table', schema: 'main', table } as const
      const rebuild = { ...analyze, action: 'reindex-table' } as const
      const check = { ...analyze, action: 'check-table' } as const
      await execute(`CREATE TABLE ${target}(id int); INSERT INTO ${target} VALUES (1),(2); CREATE INDEX a2_idx ON "${table}"(id)`)
      registry.lockSession(session.id)
      await expect(async () => apply(await prepare(analyze))).rejects.toThrow('protected connection is locked')
      registry.unlockSession(session.id, config.name)
      await expect(async () => prepare({ ...analyze, schema: 'temp', table: 'a2_temp' })).rejects.toThrow('main database')
      await execute("ATTACH ':memory:' AS a2_attached")
      await expect(async () => prepare(analyze)).rejects.toThrow('Detach other SQLite files')
      expect(await apply(await prepare(check))).toMatchObject({ status: 'applied' })
      await execute('DETACH a2_attached; BEGIN')
      await expect(async () => prepare(analyze)).rejects.toThrow('settle the transaction')
      await execute('ROLLBACK; PRAGMA busy_timeout=2333')
      const review = await prepare(analyze)
      expect(review.sql).toBe(`ANALYZE ${target};`)
      expect(await apply(review)).toMatchObject({ status: 'applied' })
      expect(await execute('SELECT stat FROM main.sqlite_stat1 WHERE idx=\'a2_idx\'')).toEqual([['2 1']])
      expect(await execute('PRAGMA busy_timeout')).toEqual([['2333']])
      const stale = await prepare(rebuild)
      const other = await registry.connect({ ...config, sqliteMode: 'read-write' })
      await execute(`DROP INDEX a2_idx; CREATE INDEX a2_idx ON "${table}"(id DESC)`, other.id)
      await expect(async () => apply(stale)).rejects.toThrow('reviewed SQLite table or indexes changed')
      expect(await execute('PRAGMA busy_timeout')).toEqual([['2333']])
      const index = await prepare(rebuild)
      expect(index.sql).toBe(`REINDEX ${target};`)
      expect(await apply(index)).toMatchObject({ status: 'applied' })
      const readonly = await registry.connect({ ...config, sqliteMode: 'read-only' })
      await expect(async () => prepare(analyze, readonly.id)).rejects.toThrow('read-only')
      const integrity = await prepare(check, readonly.id)
      expect(integrity.sql).toBe("PRAGMA main.integrity_check('A2 '' scoped');")
      expect(await apply(integrity, readonly.id)).toMatchObject({ status: 'applied' })
      await execute('PRAGMA query_only=ON')
      await expect(async () => prepare(analyze)).rejects.toThrow('read-only')
      await execute('PRAGMA query_only=OFF')
    } else {
      const checkpoint = { action: 'checkpoint-database', database: session.database } as const
      registry.lockSession(session.id)
      await expect(async () => apply(await prepare(checkpoint))).rejects.toThrow('protected connection is locked')
      registry.unlockSession(session.id, config.name)
      const review = await prepare(checkpoint)
      expect(review.sql).toBe(`CHECKPOINT "${session.database}";`)
      expect(await apply(review)).toMatchObject({ status: 'applied' })
      const other = await registry.connect({ ...config, duckdbMode: 'read-write' })
      await execute('BEGIN; INSERT INTO retained VALUES (8)', other.id)
      expect(await apply(await prepare(checkpoint))).toMatchObject({ status: 'rejected' })
      expect(await execute('SELECT count(*) FROM retained', other.id)).toEqual([['2']])
      await execute('ROLLBACK', other.id)
      await registry.disconnect(other.id)
      expect(await apply(await prepare(checkpoint))).toMatchObject({ status: 'applied' })
      await execute("ATTACH ':memory:' AS a2_attached; USE a2_attached")
      await expect(async () => prepare({ ...checkpoint, database: 'a2_attached' })).rejects.toThrow('opened writable DuckDB database file')
      await expect(async () => prepare(checkpoint)).rejects.toThrow('opened writable DuckDB database file')
      await execute(`USE "${session.database}"; DETACH a2_attached`)
      const memory = await registry.connect({ ...config, duckdbMode: 'memory' })
      await expect(async () => prepare({ ...checkpoint, database: memory.database }, memory.id)).rejects.toThrow('opened writable DuckDB database file')
    }
    expect(await execute('SELECT value FROM a2_temp')).toEqual([['42']])
    expect(await execute('SELECT value FROM retained')).toEqual([['7']])
    expect(registry.getSession(session.id)).toMatchObject({ transaction: 'idle', database: session.database })
    if (engine === 'duckdb') {
      await registry.disconnect(session.id)
      const readonly = await registry.connect({ ...config, duckdbMode: 'read-only' })
      await expect(async () => prepare({ action: 'checkpoint-database', database: readonly.database }, readonly.id)).rejects.toThrow('opened writable DuckDB database file')
    }
  } finally { await registry.close(); rmSync(directory, { recursive: true, force: true }) }
}
