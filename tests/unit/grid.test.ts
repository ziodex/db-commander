import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { gridRequestSchema } from '../../src/shared/contracts'
import { GridSql } from '../../src/driver/grid-sql'
import { duckdbGeneratedColumns } from '../../src/driver/table-editor'
import { applyDatabaseEvent, canCloseTab, emptyTabState } from '../../src/renderer/query-tabs'
import { GRID_CELL_LIMIT } from '../../src/shared/grid-limits'

it('accepts explicit NULL but rejects forged originals, SQL fragments and out-of-range edits at IPC', () => {
  const request = { action: 'apply', sessionId: randomUUID(), snapshotId: randomUUID(), changes: [{ kind: 'update', row: 0, values: [{ column: 1, value: null }] }] }
  expect(gridRequestSchema.parse(request)).toEqual(request)
  for (const bad of [ { ...request, sql: 'DELETE FROM t' }, { ...request, originals: [['forged']] },
    { ...request, changes: [{ kind: 'delete', row: -1 }] }, { ...request, changes: [{ kind: 'update', row: 0, values: [{ column: 100, value: 'x' }] }] },
    { ...request, changes: [{ kind: 'insert', values: [{ column: 1, value: 'x'.repeat(GRID_CELL_LIMIT + 1) }] }] }, { ...request, changes: [] } ]) {
    expect(gridRequestSchema.safeParse(bad).success).toBe(false)
  }
})
it('keeps the total staged value limit while permitting bounded large cells', () => {
  const request = { action: 'preview', sessionId: randomUUID(), snapshotId: randomUUID(), changes: [{ kind: 'insert', values: [{ column: 1, value: 'Ω'.repeat(20_000) }] }] }
  expect(gridRequestSchema.safeParse(request).success).toBe(true)
  const changes = Array.from({ length: 33 }, () => ({ kind: 'insert', values: [{ column: 1, value: 'x'.repeat(GRID_CELL_LIMIT) }] }))
  expect(gridRequestSchema.safeParse({ ...request, changes }).success).toBe(false)
})
it('keeps database identifiers quoted and catalog filters bound on every dialect', () => {
  for (const engine of ['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql', 'oracle', 'sqlite', 'duckdb'] as const) {
    const dialect = new GridSql(engine), table = { schema: 'sample', name: "a'; DROP TABLE other;--", catalog: 'catalog' }
    const metadata = dialect.metadata(table)
    expect(metadata.sql).not.toContain(table.name); expect(metadata.values).toContain(table.name)
    expect(dialect.table(table)).toContain(engine === 'mysql' || engine === 'mariadb' ? '`' : engine === 'sqlserver' || engine === 'azure-sql' ? '[' : '"')
    expect(dialect.supported({ name: 'unsafe', type: 'int); DROP TABLE other;--', generated: false, hasDefault: false, nullable: true, primaryKey: false })).toBe(false)
    if (engine === 'sqlserver' || engine === 'azure-sql') expect(dialect.value({ name: 'version', type: 'rowversion', generated: true, hasDefault: false, nullable: false, primaryKey: true }, 1)).toBe('CONVERT(binary(8),@p1,2)')
  }
})
it('distinguishes DuckDB generated expressions from quoted names and ordinary defaults in the server definition', () => {
  const sql = `CREATE TABLE "quoted (table" (id INTEGER PRIMARY KEY, "GENERATED" VARCHAR DEFAULT 'GENERATED ALWAYS AS (id)',
    "a,b" INTEGER GENERATED ALWAYS AS ((id + 1)), amount DECIMAL(10,2) DEFAULT (2.5), "quote""field" INTEGER GENERATED ALWAYS AS (id * 2), CHECK (id > 0));`
  expect([...duckdbGeneratedColumns(sql)]).toEqual(['a,b', 'quote"field'])
})
it('guards unapplied edits and preserves drafts as expired after a connection loss', () => {
  const state = { ...emptyTabState(), gridChanges: [{ kind: 'delete' as const, row: 1 }], session: { id: 'a', engine: 'postgres' as const, name: 'db', database: 'db', user: 'u', host: 'local', port: 1, tls: false, transaction: 'idle' as const, version: '' } }
  expect(canCloseTab(state)).toContain('staged')
  expect(canCloseTab({ ...emptyTabState(), gridBusy: true })).toContain('Wait')
  const lost = applyDatabaseEvent(state, { type: 'session-lost', sessionId: 'a', message: 'lost' })
  expect(lost).toMatchObject({ gridExpired: true, gridBusy: false, gridChanges: state.gridChanges, session: null })
})
