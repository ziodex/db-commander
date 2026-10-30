import { expect, it } from 'vitest'
import type { GridChange, GridSnapshot } from '../../src/shared/contracts'
import { duplicateGridRow, parseGridTsv, pasteGrid } from '../../src/renderer/grid-batch'

const grid: GridSnapshot = { id: 'a', table: { schema: 'main', name: 't' }, mode: 'edit', query: { offset: 0, pageSize: 25, filters: [], sort: [] }, truncated: false,
  columns: [
    { name: 'id', type: 'int', primaryKey: true, nullable: false, generated: false, hasDefault: false },
    { name: 'a', type: 'text', primaryKey: false, nullable: true, generated: false, hasDefault: false },
    { name: 'b', type: 'text', primaryKey: false, nullable: true, generated: false, hasDefault: false },
    { name: 'computed', type: 'int', primaryKey: false, nullable: true, generated: true, hasDefault: false }
  ], rows: [['1','one',null,'2'],['2','two','old','4']] }

it('parses rectangular quoted TSV and preserves literal empty values', () => {
  expect(parseGridTsv('"a\tb"\t"line 1\nline 2"\r\n"say ""hi"""\t\r\n')).toEqual([['a\tb','line 1\nline 2'],['say "hi"','']])
  for (const text of ['a\tb\nc', '"unfinished\tx', '"a"oops\tb', 'x'.repeat(16385) + '\ty']) expect(() => parseGridTsv(text)).toThrow()
})
it('duplicates a loaded row including staged values but not keys or generated values', () => {
  const changes: GridChange[] = [{ kind: 'update', row: 0, values: [{ column: 1, value: 'changed' }] }]
  expect(duplicateGridRow(grid, changes, 0)).toEqual([...changes, { kind: 'insert', values: [{ column: 1, value: 'changed' }, { column: 2, value: null }] }])
  expect(() => duplicateGridRow(grid, [{ kind: 'delete', row: 0 }], 0)).toThrow(/deletion/)
})
it('pastes into visible columns atomically while protecting keys, generated and deleted rows', () => {
  const old: GridChange[] = [{ kind: 'update', row: 0, values: [{ column: 1, value: 'prior' }] }]
  expect(pasteGrid(grid, old, [0,2,1,3], 0, 1, [['', 'next'], ['value', 'two']])).toEqual([
    { kind: 'update', row: 0, values: [{ column: 2, value: '' }, { column: 1, value: 'next' }] },
    { kind: 'update', row: 1, values: [{ column: 2, value: 'value' }] }
  ])
  expect(() => pasteGrid(grid, old, [0,1,2,3], 0, 0, [['99','new']])).toThrow(/primary keys/)
  expect(() => pasteGrid(grid, old, [1,3], 0, 0, [['new','3']])).toThrow(/generated/)
  expect(() => pasteGrid(grid, [{ kind: 'delete', row: 1 }], [1], 0, 0, [['new'],['new']])).toThrow(/deletion/)
  expect(old).toEqual([{ kind: 'update', row: 0, values: [{ column: 1, value: 'prior' }] }])
})
