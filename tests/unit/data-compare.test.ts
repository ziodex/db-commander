import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect } from 'vitest'
import { DATA_ROWS, dataCompareSchema, type DataCaptureRequest, type DataCapture } from '../../src/shared/data-compare'
import { gridRequestSchema, type GridColumn, type SessionInfo } from '../../src/shared/contracts'
import { captureData } from '../../src/driver/data-capture'
import { GridSql } from '../../src/driver/grid-sql'
import { matchData, compareData } from '../../src/data/compare'
const id = '00000000-0000-4000-8000-000000000001'
const table = { schema: 'public', name: 'odd FROM "table' }
const column = (name: string, type = 'integer', primaryKey = false): GridColumn => ({ name, type, primaryKey, nullable: !primaryKey, generated: false, hasDefault: false })
const columns = [column('id', 'integer', true), column('value', 'text')]
const request: DataCaptureRequest = { action: 'compare-data', sessionId: id, table, filters: [], keys: [], columns: [], maxRows: 100 }
const scope = { sessionId: id, table, filters: [] }
const input = { source: scope, target: scope, keys: [], columns: [], maxRows: 100 }
const d = new GridSql('postgres')
const read = (rows: (string | null)[][], overrides: Partial<DataCaptureRequest> = {}, available = columns) => captureData(d, table, available, { ...request, ...overrides }, async () => ({ rows, affected: 0 }))
describe('bounded keyed comparison', () => {
  it('validates scopes and refuses public access to the host-only capture operation', () => {
    expect(() => gridRequestSchema.parse(request)).toThrow()
    for (const change of [{ maxRows: DATA_ROWS + 1 }, { maxRows: 0 }, { keys: ['id', 'id'] }, { keys: Array.from({ length: 9 }, (_, i) => String(i)) }, { sql: 'DELETE FROM t' }]) expect(() => dataCompareSchema.parse({ ...input, ...change })).toThrow()
  })
  it('matches by composite keys rather than order and keeps tuple boundaries', () => {
    const cols = [column('a'), column('b'), column('v', 'text')], keys = ['a', 'b']
    const source: DataCapture = { keys, columns: cols, rows: [['a,b', 'c', '9007199254740993'], ['a', 'b,c', null], ['only', 'a', '']] }
    const target: DataCapture = { keys, columns: [cols[2], cols[1], cols[0]], rows: [['', 'b,c', 'a'], ['9007199254740993', 'c', 'a,b'], ['new', 'b', 'only']] }
    const rows = matchData(source, target)
    expect(rows.map(r => r.status).sort()).toEqual(['changed', 'matching', 'source-only', 'target-only'])
    expect(rows.find(r => r.status === 'changed')?.changedColumns).toEqual(['v'])
    expect(rows.find(r => r.status === 'matching')?.source?.[2]).toBe('9007199254740993')
  })
  it('rejects incompatible types and different implicit keys', () => {
    const source = { keys: ['id'], columns, rows: [] }
    expect(() => matchData(source, { ...source, keys: ['value'] })).toThrow(/keys differ/)
    expect(() => matchData(source, { ...source, columns: [column('id', 'text'), columns[1]] })).toThrow(/native types/)
  })
  it('rejects incomplete rows, duplicate keys, NULL keys and missing keys', async () => {
    await expect(read([['1', 'a'], ['1', 'b']])).rejects.toThrow(/not unique/)
    await expect(read([[null, 'a']])).rejects.toThrow(/NULL/)
    await expect(read([['1']])).rejects.toThrow(/unsupported/)
    await expect(read([], { keys: ['missing'] })).rejects.toThrow(/unavailable/)
    await expect(read([], {}, [column('id')])).rejects.toThrow(/declared primary key/)
  })
  it('never compares truncated sets or values, and accepts the exact boundary', async () => {
    await expect(read([['1', 'a'], ['2', 'b']], { maxRows: 1 })).rejects.toThrow(/No partial comparison/)
    await expect(read([['1', 'x'.repeat(4097)]])).rejects.toThrow(/no truncated values/)
    expect((await read([['1', 'x'.repeat(4096)]], { maxRows: 1 })).rows).toHaveLength(1)
  })
  it('bounds UTF-8 retained bytes independently of row and character limits', async () => {
    const available = [columns[0], ...Array.from({ length: 8 }, (_, i) => column(`v${i}`, 'text'))]
    const rows = Array.from({ length: 100 }, (_, i) => [String(i), ...Array(8).fill('€'.repeat(2000))])
    await expect(read(rows, {}, available)).rejects.toThrow(/4 MiB/)
  })
  it('selects supported columns explicitly and includes the key', async () => {
    const available = [...columns, column('unsupported', 'bytea')]
    await expect(read([], {}, available)).rejects.toThrow(/no exact/)
    expect((await read([['1', 'a']], { columns: ['value'] }, available)).columns.map(c => c.name)).toEqual(['id', 'value'])
  })
  it('quotes identifiers, binds filters, and uses native row limits for every engine', async () => {
    for (const engine of ['postgres','mysql','mariadb','sqlserver','azure-sql','oracle','sqlite','duckdb'] as const) {
      const dialect = new GridSql(engine), available = [column('id', engine === 'oracle' ? 'NUMBER' : 'integer', true)]
      await captureData(dialect, table, available, { ...request, filters: [{ column: 'id', operator: 'eq', value: "x' OR 1=1--" }], maxRows: 7 }, async (sql, values) => {
        expect(sql).toContain(dialect.table(table)); expect(sql).not.toContain("x' OR"); expect(values).toEqual(["x' OR 1=1--"])
        expect(sql).toContain(dialect.mssql || engine === 'oracle' ? 'FETCH NEXT 8 ROWS ONLY' : 'LIMIT 8 OFFSET 0')
        return { rows: [], affected: 0 }
      })
    }
  })
  it('refuses cross-engine, transaction and unavailable catalog comparisons before capturing rows', async () => {
    const session = { id, engine: 'postgres', database: 'db', transaction: 'idle' } as SessionInfo
    const reader = (overrides: Partial<SessionInfo> = {}) => ({ getSession: () => ({ ...session, ...overrides }), explore: async () => ({ catalog: { objects: [], truncated: false, notice: '' } }), editGrid: async () => { throw new Error('Must not capture') } })
    await expect(compareData(input, reader(), reader({ engine: 'mysql' }))).rejects.toThrow(/same engine/)
    await expect(compareData(input, reader({ transaction: 'transaction' }), reader())).rejects.toThrow(/Commit or roll back/)
    await expect(compareData(input, reader(), reader())).rejects.toThrow(/base table is unavailable/)
  })
})


it('withholds an oversized wide result at the native transport boundary', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT);
      WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i<1000)
      INSERT INTO items SELECT i, printf('%03000d',0), printf('%03000d',0), printf('%03000d',0) FROM ids`)
    const selected = { schema: 'main', name: 'items' }
    const available = [column('id', 'integer', true), ...['a', 'b', 'c'].map(name => column(name, 'text'))]
    let wire: (string | null)[][] = []
    await expect(captureData(new GridSql('sqlite'), selected, available, { ...request, table: selected, maxRows: 1000 }, async (sql, values) => {
      const statement = db.prepare(sql)
      statement.setReturnArrays(true)
      wire = (statement.all(...values ?? []) as unknown as unknown[][]).map(row => row.map(value => value === null ? null : String(value)))
      return { rows: wire, affected: 0 }
    })).rejects.toThrow(/4 MiB/)
    expect(wire).toHaveLength(1000)
    expect(wire.every(row => row.slice(0, -2).every(value => value === null) && row.at(-2) === 'overflow')).toBe(true)
  } finally { db.close() }
})

it('refuses SQLite text containing NUL rather than comparing a prefix', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1, char(97,0,98));')
    const selected = { schema: 'main', name: 'items' }
    await expect(captureData(new GridSql('sqlite'), selected, columns, { ...request, table: selected }, async (sql, values) => {
      const statement = db.prepare(sql)
      statement.setReturnArrays(true)
      return { rows: statement.all(...values ?? []) as unknown as (string | null)[][], affected: 0 }
    })).rejects.toThrow(/containing NUL/)
  } finally { db.close() }
})

it('rejects a silently capped driver fetch even when it is below the selected row limit', async () => {
  await expect(read([['1', 'value', 'ok', '202']], { maxRows: 1000 })).rejects.toThrow(/incomplete capture/)
})
