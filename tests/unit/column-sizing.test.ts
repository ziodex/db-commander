import { expect, it } from 'vitest'
import { columnWidth, fittedColumnWidth, AUTO_SIZE_ROWS, AUTO_SIZE_CHARACTERS } from '../../src/renderer/column-sizing'

it('bounds widths to integer pixels, including invalid numeric input', () => {
  expect(columnWidth(1)).toBe(90); expect(columnWidth(900)).toBe(800)
  expect(columnWidth(210.7)).toBe(211)
  expect(columnWidth(NaN)).toBe(210); expect(columnWidth(Infinity)).toBe(210)
  expect(columnWidth(NaN, 320)).toBe(320)
})

it('fits headers, types and displayed NULL/default values without changing the source', () => {
  const values = ['short', null, undefined, 'exact  9007199254740993', 'two\nlines']
  const seen: string[] = []
  const width = fittedColumnWidth({ name: 'value', type: 'numeric' }, values.length, row => values[row], text => { seen.push(text); return text.length * 8 })
  expect(width).toBe('exact  9007199254740993'.length * 8 + 32)
  expect(seen).toEqual(['value', 'numeric', 'short', 'NULL', 'DEFAULT', 'exact  9007199254740993', 'two lines'])
  expect(values[4]).toBe('two\nlines')
  expect(fittedColumnWidth({ name: 'a'.repeat(40), type: 'text' }, 0, () => { throw new Error('No rows') }, text => text.length * 8)).toBe(352)
  expect(fittedColumnWidth({ name: 'a', type: 'long type'.repeat(10) }, 0, () => '', text => text.length * 8)).toBe(752)
})

it('caps row reads and measured strings, stops early at maximum width and never scans entire large values', () => {
  const accessed: number[] = [], measured: string[] = []
  const width = fittedColumnWidth({ name: 'x', type: 'text' }, 10000, row => {
    accessed.push(row)
    if (row >= AUTO_SIZE_ROWS) throw new Error('Read beyond the sample')
    return row === AUTO_SIZE_ROWS - 1 ? 'x'.repeat(50) : 'short'
  }, text => text.length * 8)
  expect(width).toBe(432); expect(accessed).toHaveLength(AUTO_SIZE_ROWS)
  expect(fittedColumnWidth({ name: 'column' }, 10000, row => {
    if (row > 0) throw new Error('Already reached maximum width')
    return 'x'.repeat(1_000_000)
  }, text => { measured.push(text); return text.length * 8 })).toBe(800)
  expect(measured.every(text => text.length <= AUTO_SIZE_CHARACTERS)).toBe(true)
  expect(fittedColumnWidth({ name: 'n'.repeat(1000) }, 1, () => { throw new Error('Header already fills width') }, text => text.length * 8)).toBe(800)
})
