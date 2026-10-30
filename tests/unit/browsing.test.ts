import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { browseSelect } from '../../src/driver/browse-sql'
import { GRID_CELL_LIMIT, GRID_FETCH_CHAR_BUDGET, GRID_PREVIEW_CELL_LIMIT } from '../../src/shared/grid-limits'
import { GridSql } from '../../src/driver/grid-sql'
import { engineSchema, gridQuerySchema, gridRequestSchema, type GridColumn } from '../../src/shared/contracts'

const columns: GridColumn[] = [
  { name: 'id', type: 'INTEGER', primaryKey: true, generated: false, hasDefault: false, nullable: false },
  { name: "Label' value", type: 'VARCHAR(100)', primaryKey: false, generated: false, hasDefault: false, nullable: true }
]
it('bounds aggregate projections while allowing larger values on narrower pages', () => {
  const dialect = new GridSql('sqlite'), table = { schema: 'main', name: 'items' }
  const wide = Array.from({ length: 100 }, (_, i) => ({ ...columns[0], name: `c${i}`, primaryKey: i === 0 }))
  for (const pageSize of [25, 50, 100, 200] as const) {
    const choice = browseSelect(dialect, table, wide, gridQuerySchema.parse({ pageSize }), true)
    expect((pageSize + 1) * wide.length * (choice.cellLimit + 16)).toBeLessThanOrEqual(GRID_FETCH_CHAR_BUDGET)
    expect(choice.cellLimit).toBeGreaterThanOrEqual(GRID_PREVIEW_CELL_LIMIT)
  }
  expect(browseSelect(dialect, table, columns, undefined, true).cellLimit).toBe(GRID_CELL_LIMIT)
  expect(browseSelect(dialect, table, columns).cellLimit).toBe(GRID_PREVIEW_CELL_LIMIT)
})
it('offers short SELECT-star SQL without changing exact browser projections or pagination', () => {
  for (const engine of engineSchema.options) {
    const d = new GridSql(engine), selection = browseSelect(d, { schema: 'schema name', name: 'table name' }, columns)
    expect(selection.statement).toBe(`SELECT * ${selection.from} ${d.mssql || engine === 'oracle' ? 'OFFSET 0 ROWS FETCH NEXT 201 ROWS ONLY' : 'LIMIT 201 OFFSET 0'}`)
    expect(selection.statement).toContain(d.table({ schema: 'schema name', name: 'table name' }))
    expect(selection.sql).toContain(d.q('sc_0'))
    expect(selection.statement).not.toContain('sc_0')
  }
})
it('rejects unbounded pages and SQL-shaped options at the IPC boundary', () => {
  const request = { action: 'browse', sessionId: randomUUID(), table: { schema: 'main', name: 'table' } }
  expect(gridRequestSchema.safeParse(request).success).toBe(true)
  for (const query of [{ offset: -1 }, { offset: 1_000_001 }, { offset: 0.1 }, { pageSize: 10000 }, { where: '1=1' }, { sort: [{ column: 'id', direction: 'asc; DROP TABLE t' }] }, { filters: [{ column: 'id', operator: 'eq' }] }, { filters: [{ column: 'id', operator: 'is-null', value: 'forged' }] }, { filters: Array(9).fill({ column: 'id', operator: 'is-null' }) }]) {
    expect(gridRequestSchema.safeParse({ ...request, query }).success, JSON.stringify(query)).toBe(false)
  }
})
it('binds literal patterns and compares native values across all dialects', () => {
  for (const engine of engineSchema.options) {
    const d = new GridSql(engine), value = "%'_![x]; DROP TABLE secret; --", query = gridQuerySchema.parse({ pageSize: 25, offset: 250, filters: [{ column: columns[1].name, operator: 'contains', value }], sort: [{ column: 'id', direction: 'desc' }] })
    const selection = browseSelect(d, { schema: 'main', name: 'table' }, columns, query)
    expect(selection.sql).not.toContain('DROP TABLE'); expect(selection.values[0]).toContain('DROP TABLE')
    expect(selection.values[0]).toContain("!%'!_!!")
    expect(selection.sql).toContain(`${d.q('id')} DESC`)
    expect(selection.sql).toContain(d.mssql || engine === 'oracle' ? 'OFFSET 250 ROWS FETCH NEXT 26 ROWS ONLY' : 'LIMIT 26 OFFSET 250')
    expect(selection.notice).toContain('Primary-key')
    expect(() => browseSelect(d, { schema: 'main', name: 'table' }, columns, gridQuerySchema.parse({ filters: [{ column: 'id);DROP TABLE t', operator: 'eq', value: '1' }] }))).toThrow('no longer exists')
    expect(() => browseSelect(d, { schema: 'main', name: 'table' }, columns, gridQuerySchema.parse({ filters: [{ column: 'id', operator: 'contains', value: '1' }] }))).toThrow('text column')
  }
})
it('adds composite primary-key tie breakers and warns when rows have no unique order', () => {
  const d = new GridSql('postgres'), table = { schema: 'public', name: 'table' }, composite = [...columns, { ...columns[0], name: 'tenant' }]
  const query = gridQuerySchema.parse({ sort: [{ column: columns[1].name, direction: 'asc' }] })
  const selection = browseSelect(d, table, composite, query)
  expect(selection.sql).toContain('"id" ASC'); expect(selection.sql).toContain('"tenant" ASC')
  expect(selection.query.sort).toHaveLength(1)
  expect(browseSelect(d, table, columns.map(c => ({ ...c, primaryKey: false })), query).notice).toContain('No sortable primary key')
  expect(() => browseSelect(d, table, columns, gridQuerySchema.parse({ sort: [{ column: 'id', direction: 'asc' }, { column: 'id', direction: 'desc' }] }))).toThrow('only once')
})
