import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { gridQuerySchema, type ConnectionConfig, type DatabaseEvent, type GridQueryOptions, type GridTable } from '../../src/shared/contracts'

export async function verifyTableBrowsing(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-browse-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const embedded = ['sqlite', 'duckdb'].includes(config.engine), oracle = config.engine === 'oracle'
  const local = { ...config, ...(embedded ? { filePath: join(directory, 'browse.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const a = await driver.connect(local), b = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
  const q = (value: string) => quoteIdentifier(value, config.engine), name = `browse '${randomUUID().slice(0, 8)}`, label = "Label ' value"
  const textType = ['sqlserver', 'azure-sql'].includes(config.engine) ? 'NVARCHAR' : 'VARCHAR'
  let table: GridTable
  async function run(sql: string, id = a.id) {
    const queryId = driver.start({ sessionId: id, sql, maxRows: 1000 }); await driver.wait(id)
    expect(events.find(e => e.type === 'complete' && e.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : [])
  }
  async function load(options: Partial<GridQueryOptions> = {}, action: 'browse' | 'open' = 'browse', target = table, id = a.id) {
    const response = await driver.editGrid({ action, sessionId: id, table: target, query: gridQuerySchema.parse(options) })
    expect(response.error).toBeUndefined(); expect(response.session.transaction).toBe('idle')
    return response.grid!
  }
  try {
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER NOT NULL,${q('tenant')} INTEGER NOT NULL,${q(label)} ${textType}(120),${q('note')} ${textType}(30),${q('amount')} DECIMAL(30,8),PRIMARY KEY(${q('id')},${q('tenant')}))`)
    for (let start = 0; start < 305; start += 100) {
      const inserts = Array.from({ length: Math.min(100, 305 - start) }, (_, offset) => {
        const i = start + offset
        return `INSERT INTO ${q(name)} VALUES(${Math.floor(i / 2)},${i % 2},'group_${i % 3}',${i % 2 ? "'has note'" : 'NULL'},${i})`
      })
      await run(inserts.join(';'))
    }
    if (oracle) await run('COMMIT')
    const object = (await driver.schema(a.id)).objects.find(o => o.name === name)!
    table = { schema: object.schema, name, ...(object.catalog ? { catalog: object.catalog } : {}) }
    let page = await load({ pageSize: 100 })
    expect(page.rows).toHaveLength(100); expect(page.truncated).toBe(true)
    expect(page.rows[0].slice(0, 2)).toEqual(['0', '0'])
    const all: string[] = []
    // All 305 rows, past the previous 200-row ceiling, once each in PK order.
    for (let offset = 0; offset < 400; offset += 100) {
      page = await load({ pageSize: 100, offset }); all.push(...page.rows.map(row => row.slice(0, 2).join(':')))
      expect(page.truncated).toBe(offset < 300)
    }
    expect(all).toHaveLength(305); expect(new Set(all).size).toBe(305)
    expect(all.at(-1)).toBe('152:0')
    expect((await load({ offset: 400, pageSize: 100 })).rows).toEqual([])
    // Native numeric sorting, multiple sort priorities and NULLs last.
    page = await load({ pageSize: 25, sort: [{ column: 'amount', direction: 'desc' }] })
    expect(page.rows[0].slice(0, 2)).toEqual(['152', '0']); expect(page.rows[24].slice(0, 2)).toEqual(['140', '0'])
    page = await load({ pageSize: 25, sort: [{ column: 'note', direction: 'asc' }, { column: 'id', direction: 'desc' }] })
    expect(page.rows[0].slice(0, 2)).toEqual(['151', '1']); expect(page.rows.every(row => row[3] === 'has note')).toBe(true)
    page = await load({ filters: [{ column: 'id', operator: 'gte', value: '150' }, { column: 'note', operator: 'is-null' }] })
    expect(page.rows.map(row => row[0])).toEqual(['150', '151', '152'])
    page = await load({ filters: [{ column: 'id', operator: 'lt', value: '3' }, { column: 'note', operator: 'not-null' }] })
    expect(page.rows.map(row => row.slice(0, 2))).toEqual([['0', '1'], ['1', '1'], ['2', '1']])
    // Filter values/patterns never become SQL, and exact decimals stay text.
    const literal = "100%_![x] O'Brien Ω; DELETE FROM anything; --"
    let edit = await load({ offset: 300, pageSize: 25 }, 'open')
    let applied = await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: edit.id, changes: [{ kind: 'update', row: 0, values: [{ column: 2, value: literal }, { column: 3, value: 'n'.repeat(30) }, { column: 4, value: '9007199254740993.12345678' }] }] })
    expect(applied.error).toBeUndefined(); await run('COMMIT')
    page = await load({ filters: [{ column: label, operator: 'eq', value: literal }] })
    expect(page.rows).toHaveLength(1); expect(page.rows[0][0]).toBe('150'); expect(page.rows[0][2]).toBe(literal)
    // SQLite NUMERIC uses native floating storage; exact text fixtures are
    // covered separately by grid-contract, not promised for NUMERIC affinity.
    if (config.engine !== 'sqlite') expect(page.rows[0][4]).toBe('9007199254740993.12345678')
    expect((await load({ filters: [{ column: 'note', operator: 'eq', value: 'n'.repeat(30) + 'x' }] })).rows).toEqual([])
    for (const operator of ['contains', 'starts-with'] as const) {
      page = await load({ filters: [{ column: label, operator, value: '100%_![x]' }] })
      expect(page.rows).toHaveLength(1); expect(page.rows[0][2]).toBe(literal)
    }
    expect((await load({ filters: [{ column: label, operator: 'eq', value: "' OR 1=1 --" }] })).rows).toEqual([])
    expect((await driver.editGrid({ action: 'browse', sessionId: a.id, table, query: gridQuerySchema.parse({ filters: [{ column: 'missing', operator: 'eq', value: '1' }] }) })).error).toMatch(/no longer exists/)
    expect((await load()).rows).toHaveLength(200)
    // New pages invalidate edit snapshots; another session's pages do not.
    edit = await load({ offset: 300, pageSize: 25 }, 'open')
    await load({ pageSize: 25 }, 'browse', table, b.id)
    applied = await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: edit.id, changes: [{ kind: 'update', row: 0, values: [{ column: 2, value: 'rolled back' }] }] })
    expect(applied.error).toBeUndefined()
    expect((await driver.editGrid({ action: 'browse', sessionId: a.id, table })).error).toMatch(/transaction/)
    await run('ROLLBACK')
    edit = await load({ offset: 300, pageSize: 25 }, 'open')
    await load({ offset: 25, pageSize: 25 })
    expect((await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: edit.id, changes: [{ kind: 'delete', row: 0 }] })).error).toMatch(/expired/)
    // Optimistic concurrency still addresses the original row on a later page.
    edit = await load({ offset: 300, pageSize: 25 }, 'open')
    await run(`UPDATE ${q(name)} SET ${q(label)}='external' WHERE ${q('id')}=150 AND ${q('tenant')}=0`, b.id)
    if (oracle) await run('COMMIT', b.id)
    expect((await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: edit.id, changes: [{ kind: 'delete', row: 0 }] })).error).toMatch(/Concurrency conflict/)
    // Views and keyless tables are browsable; browsing itself grants no edits.
    const view = name + '_view', keyless = name + '_nokey'
    await run(`CREATE VIEW ${q(view)} AS SELECT ${q('id')},${q(label)} FROM ${q(name)}`)
    page = await load({ pageSize: 25, offset: 25, sort: [{ column: 'id', direction: 'desc' }] }, 'browse', { ...table, name: view })
    expect(page.rows).toHaveLength(25); expect(page.notice).toContain('No sortable primary key')
    await run(`CREATE TABLE ${q(keyless)} (${q('value')} INTEGER)`)
    await run(`INSERT INTO ${q(keyless)} VALUES(2); INSERT INTO ${q(keyless)} VALUES(1)`)
    if (oracle) await run('COMMIT')
    page = await load({}, 'browse', { ...table, name: keyless }); expect(page.rows).toEqual([['1'], ['2']])
    expect((await driver.editGrid({ action: 'apply', sessionId: a.id, snapshotId: page.id, changes: [{ kind: 'delete', row: 0 }] })).error).toMatch(/expired/)
    await run(`DROP VIEW ${q(view)}`); await run(`DROP TABLE ${q(keyless)}`)
    // Unsupported binary values are explicit placeholders, never fake NULLs.
    const binary = name + '_binary'
    const binaryType = config.engine === 'postgres' ? 'BYTEA' : oracle ? 'RAW(20)' : ['sqlserver', 'azure-sql'].includes(config.engine) ? 'VARBINARY(20)' : 'BLOB'
    const binaryValue = config.engine === 'postgres' ? "decode('00ff','hex')" : oracle ? "HEXTORAW('00ff')" : config.engine === 'duckdb' ? "from_hex('00ff')" : ['sqlserver', 'azure-sql'].includes(config.engine) ? '0x00ff' : "X'00ff'"
    await run(`CREATE TABLE ${q(binary)} (${q('id')} INTEGER PRIMARY KEY,${q('payload')} ${binaryType})`)
    await run(`INSERT INTO ${q(binary)} VALUES(1,NULL); INSERT INTO ${q(binary)} VALUES(2,${binaryValue})`)
    if (oracle) await run('COMMIT')
    page = await load({}, 'browse', { ...table, name: binary })
    expect(page.rows[0]).toEqual(['1', null])
    expect(page.rows[1][1]).toBe(config.engine === 'sqlite' ? '0x00FF' : '[Use SQL to inspect this type]')
    expect(page.columns[1].filterable).toBe(false)
    page = await load({ filters: [{ column: 'payload', operator: 'not-null' }] }, 'browse', { ...table, name: binary })
    expect(page.rows.map(row => row[0])).toEqual(['2'])
    await run(`DROP TABLE ${q(binary)}`)
    if (embedded) {
      await driver.disconnect(a.id); await driver.disconnect(b.id)
      const ro = await driver.connect({ ...local, sqliteMode: 'read-only', duckdbMode: 'read-only' })
      expect((await load({ offset: 300, pageSize: 25 }, 'browse', table, ro.id)).rows).toHaveLength(5)
      expect((await driver.editGrid({ action: 'open', sessionId: ro.id, table })).error).toMatch(/read-only/)
      await driver.disconnect(ro.id)
    } else await run(`DROP TABLE ${q(name)}`)
  } finally { await driver.close(); rmSync(directory, { recursive: true, force: true }) }
}
