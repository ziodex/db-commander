import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { DataCompareRequest } from '../../src/shared/data-compare'

export async function verifyDataComparison(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-data-compare-')), engine = config.engine, embedded = ['sqlite','duckdb'].includes(engine)
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(e => { events.push(e) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const prefix = 'dc_' + randomUUID().replaceAll('-', '').slice(0, 8), q = (name: string) => quoteIdentifier(name, engine)
  const profile = { ...config, ...(embedded ? { filePath: join(directory, 'source.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const a = await driver.connect(profile), b = await driver.connect({ ...profile, ...(embedded ? { filePath: join(directory, 'target.db') } : {}) })
  const schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? a.user.toUpperCase() : ['mysql','mariadb'].includes(engine) ? a.database : 'main'
  const source = { schema, name: prefix + '_source', ...(engine === 'duckdb' ? { catalog: a.database } : {}) }, target = { ...source, name: prefix + '_target', ...(engine === 'duckdb' ? { catalog: b.database } : {}) }
  const full = (table: typeof source) => [...(table.catalog ? [table.catalog] : []), table.schema, table.name].map(q).join('.')
  const text = engine === 'oracle' ? 'VARCHAR2(4000)' : 'VARCHAR(5000)', integer = engine === 'oracle' ? 'NUMBER(20)' : 'BIGINT'
  const key = 'key FROM ]', label = engine === 'oracle' ? "label ' ]" : 'label " ]'
  async function run(sql: string, sessionId = a.id) {
    const queryId = driver.start({ sessionId, sql, maxRows: 100 }); await driver.wait(sessionId)
    const done = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(done?.status, `${sql.slice(0, 200)}: ${done?.error}`).toBe('completed'); return queryId
  }
  const request: DataCompareRequest = { source: { sessionId: a.id, table: source, filters: [] }, target: { sessionId: b.id, table: target, filters: [] }, keys: [key, 'tenant'], columns: [], maxRows: 10 }
  const sourceColumns = `${q(key)} ${integer}, ${q('tenant')} VARCHAR(30), ${q(label)} ${text}, ${q('nullable')} VARCHAR(30)`
  const targetColumns = `${q('tenant')} VARCHAR(30), ${q(key)} ${integer}, ${q('nullable')} VARCHAR(30), ${q(label)} ${text}`
  try {
    await run(`CREATE TABLE ${full(source)} (${sourceColumns}, PRIMARY KEY (${q(key)},${q('tenant')}))`)
    await run(`CREATE TABLE ${full(target)} (${targetColumns}, PRIMARY KEY (${q(key)},${q('tenant')}))`, b.id)
    const names = [key, 'tenant', label, 'nullable'].map(q).join(',')
    for (const [table, id, values] of [[source, a.id, ["(9007199254740993,'tenant|a','same',NULL)", "(2,'tenant|a','old',NULL)", "(3,'tenant|a','quote'' %_','x')", "(4,'tenant|a','','nullable')"]], [target, b.id, ["(5,'tenant|a','target only','z')", "(4,'tenant|a','','nullable')", "(2,'tenant|a','new','')", "(9007199254740993,'tenant|a','same',NULL)"]]] as const) {
      for (const value of values) await run(`INSERT INTO ${full(table)} (${names}) VALUES ${value}`, id)
      if (engine === 'oracle') await run('COMMIT', id)
    }
    const cached = await run(engine === 'oracle' ? 'SELECT 42 FROM dual' : 'SELECT 42')
    const snapshot = (await driver.editGrid({ action: 'open', sessionId: a.id, table: source })).grid!
    expect(snapshot).toBeDefined()
    const before = events.length, pending = driver.compareData(request)
    for (const id of [a.id, b.id]) expect(() => driver.start({ sessionId: id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/operation/)
    const result = await pending
    expect(events).toHaveLength(before)
    expect(result.counts).toEqual({ 'source-only': 1, 'target-only': 1, changed: 1, matching: 2 })
    expect(result.rows.find(row => row.key.some(k => k.includes('9007199254740993')))?.status).toBe('matching')
    expect(result.rows.find(row => row.status === 'changed')?.changedColumns).toContain(label)
    await expect(driver.compareData({ ...request, maxRows: 3 })).rejects.toThrow(/row limit was exceeded/)
    await expect(driver.compareData({ ...request, keys: ['tenant'] })).rejects.toThrow(/not unique/)
    await expect(driver.compareData({ ...request, keys: ['nullable'] })).rejects.toThrow(/NULL/)
    const filtered = await driver.compareData({ ...request, maxRows: 1, source: { ...request.source, filters: [{ column: label, operator: 'contains', value: "quote' %_" }] }, target: { ...request.target, filters: [{ column: label, operator: 'contains', value: "quote' %_" }] } })
    expect(filtered.counts).toEqual({ 'source-only': 1, 'target-only': 0, changed: 0, matching: 0 })
    const exact = await driver.compareData({ ...request, columns: [label], source: { ...request.source, filters: [{ column: key, operator: 'eq', value: '9007199254740993' }] }, target: { ...request.target, filters: [{ column: key, operator: 'eq', value: '9007199254740993' }] } })
    expect(exact.counts.matching).toBe(1)
    await driver.exportCsv(cached, 0, join(directory, 'cached.csv')); expect(readFileSync(join(directory, 'cached.csv'), 'utf8')).toContain('42')
    const safety = await driver.connect({ ...profile, sqliteMode: 'read-write', duckdbMode: 'read-write', environment: 'production' })
    const equal = await driver.compareData({ ...request, keys: [], target: { ...request.source, sessionId: safety.id } })
    expect(equal.counts.matching).toBe(4); expect(driver.sessionSafety(safety.id)).toMatchObject({ protected: true, unlockedUntil: 0 }); await driver.disconnect(safety.id)
    const begin = engine === 'oracle' ? 'SAVEPOINT DC_GUARD' : ['sqlserver','azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : 'BEGIN'
    await run(begin, b.id); await expect(driver.compareData(request)).rejects.toThrow(/Commit or roll back/); await run('ROLLBACK', b.id)
    // Comparison must leave the previously captured originals usable.
    const edited = await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: snapshot.id, changes: [{ kind: 'update', row: 0, values: [{ column: snapshot.columns.findIndex(c => c.name === label), value: 'retained snapshot' }] }] })
    expect(edited.error).toBeUndefined(); expect(edited.applied).toBe(1); await run('ROLLBACK')
    if (engine !== 'oracle') {
      await run(`UPDATE ${full(source)} SET ${q(label)}='${'x'.repeat(4097)}' WHERE ${q(key)}=2`)
      await expect(driver.compareData(request)).rejects.toThrow(/no truncated values/)
      expect((await driver.compareData({ ...request, columns: ['tenant'] })).sourceRows).toBe(4)
    }
    if (embedded) {
      await driver.disconnect(a.id); await driver.disconnect(b.id)
      const roA = await driver.connect({ ...profile, sqliteMode: 'read-only', duckdbMode: 'read-only' })
      const roB = await driver.connect({ ...profile, filePath: join(directory, 'target.db'), sqliteMode: 'read-only', duckdbMode: 'read-only' })
      expect((await driver.compareData({ ...request, columns: ['tenant'], source: { ...request.source, sessionId: roA.id }, target: { ...request.target, sessionId: roB.id } })).sourceRows).toBe(4)
      return
    }
    expect(driver.getSession(a.id).transaction).toBe('idle'); expect(driver.getSession(b.id).transaction).toBe('idle')
  } finally {
    for (const [id, table] of [[a.id, source], [b.id, target]] as const) { try { await run('ROLLBACK', id) } catch {} try { await run(`DROP TABLE ${full(table)}`, id) } catch {} }
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}
