import { describe, expect, it } from 'vitest'
import { copyGridSelection, selectionBounds, type GridSelection } from '../../src/renderer/grid-selection'
import type { ResultSet } from '../../src/shared/contracts'

const result: ResultSet = {
  index: 0, statement: '', command: 'SELECT', rowCount: 3, truncated: false,
  columns: ['id', 'label', 'note'].map(name => ({ name, typeId: 0 })),
  rows: [['1', 'First', null], ['2', 'Tab\tand\n"quote"', ''], ['3', 'Last', 'long'.repeat(300)]]
}
const range = (row: number, column: number, endRow = row, endColumn = column): GridSelection => ({ anchor: { row, column }, focus: { row: endRow, column: endColumn } })

describe('result selection clipboard', () => {
  it('copies reversed ranges in visible order, excluding hidden columns and row numbers', () => {
    expect(copyGridSelection(result, [2, 0], range(2, 0, 0, 2), true)).toBe(`note\tid\r\nNULL\t1\r\n\t2\r\n${'long'.repeat(300)}\t3`)
  })
  it('quotes TSV delimiters, newlines and quotes without losing empty text or NULL', () => {
    expect(copyGridSelection(result, [0, 1, 2], range(0, 1, 1, 2))).toBe('First\tNULL\r\n"Tab\tand\n""quote"""\t')
  })
  it('copies a single captured value verbatim, beyond the visual ellipsis', () => {
    expect(copyGridSelection(result, [0, 1, 2], range(1, 1))).toBe(result.rows[1][1])
    expect(copyGridSelection(result, [0, 1, 2], range(2, 2))).toHaveLength(1200)
    expect(copyGridSelection(result, [0, 1, 2], range(0, 2))).toBe('NULL')
    expect(copyGridSelection(result, [0, 1, 2], range(1, 2))).toBe('')
  })
  it('rejects oversized selections instead of silently truncating clipboard data', () => {
    expect(() => copyGridSelection({ ...result, rows: [['x'.repeat(1_000_001)]] }, [0], range(0, 0))).toThrow('too large to copy')
  })
  it('has no selection for empty results or a hidden endpoint', () => {
    expect(selectionBounds(range(0, 0), [0, 1], 0)).toBeNull()
    expect(selectionBounds(range(0, 2), [0, 1], 3)).toBeNull()
    expect(selectionBounds(range(2, 2, 0, 0), [2, 0], 3)).toEqual({ firstRow: 0, lastRow: 2, firstColumn: 0, lastColumn: 1 })
  })
})
