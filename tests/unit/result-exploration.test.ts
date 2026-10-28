import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../../src/shared/contracts'
import { compareCapturedNumbers, emptyExploration, exploredRows, findResultMatches, MAX_FIND_MATCHES, resultFilterError, type ResultExploration } from '../../src/renderer/result-exploration'
import { MAX_RESULT_SNAPSHOTS, pinResultSnapshot, resultSnapshotBytes, type ResultSnapshot } from '../../src/renderer/result-snapshots'
import { defaultColumns } from '../../src/shared/column-layout'

const result: ResultSet = { index: 4, statement: 'SELECT captured', command: 'SELECT', rowCount: 5, truncated: true,
  columns: [{ name: 'amount', typeId: 20, typeName: 'BIGINT' }, { name: 'label', typeId: 0, typeName: 'TEXT' }],
  rows: [['9007199254740993', 'Alpha'], ['9007199254740992', 'beta'], [null, ''], ['9007199254740993', 'ALPHA'], ['-10', null]] }

describe('loaded result exploration', () => {
  it.each([
    ['9007199254740993', '9007199254740992', 1], ['1.0000000000000000001', '1', 1],
    ['-100', '-99', -1], ['-0', '0.000', 0], ['1e10000', '9e9999', 1], ['.5', '0.500', 0],
    ['1e-10000', '0', 1], ['-1e-10000', '0', -1], ['1.200', '1.2', 0], ['001', '1', 0],
    ['-Infinity', '-999999999999999999999', -1], ['Infinity', '1e10000', 1], ['NaN', 'Infinity', 1]
  ])('compares %s and %s exactly', (a, b, order) => { expect(compareCapturedNumbers(a, b)).toBe(order) })
  it('uses stable, exact numeric ordering and keeps NULL last in both directions', () => {
    const before = structuredClone(result), config: ResultExploration = { ...emptyExploration(), sort: [{ column: 0, direction: 'asc', mode: 'auto' }] }
    expect(exploredRows(result, config)).toEqual([4, 1, 0, 3, 2])
    config.sort[0].direction = 'desc'
    expect(exploredRows(result, config)).toEqual([0, 3, 1, 4, 2])
    expect(result).toEqual(before)
  })
  it('supports explicit text ordering and multiple sort keys without changing row identity', () => {
    const config = { ...emptyExploration(), sort: [{ column: 0, direction: 'asc' as const, mode: 'number' as const }, { column: 1, direction: 'asc' as const, mode: 'text' as const }] }
    expect(exploredRows(result, config)).toEqual([4, 1, 3, 0, 2])
    expect(exploredRows({ ...result, rows: [['10'], ['2']] }, { ...emptyExploration(), sort: [{ column: 0, direction: 'asc', mode: 'text' }] })).toEqual([0, 1])
  })
  it('combines filters with exact number comparison, NULL and empty text distinctions', () => {
    expect(exploredRows(result, { ...emptyExploration(), filters: [{ column: 0, operator: 'gt', value: '9007199254740992' }, { column: 1, operator: 'contains', value: 'alpha' }] })).toEqual([0, 3])
    expect(exploredRows(result, { ...emptyExploration(), filters: [{ column: 0, operator: 'is-null', value: '' }] })).toEqual([2])
    expect(exploredRows(result, { ...emptyExploration(), filters: [{ column: 1, operator: 'eq', value: '' }] })).toEqual([2])
    expect(exploredRows(result, { ...emptyExploration(), matchCase: true, filters: [{ column: 1, operator: 'contains', value: 'Alpha' }] })).toEqual([0])
  })
  it('finds in full captured values, displayed order and visible columns, excluding SQL NULL', () => {
    const rows = [3, 0, 2, 4, 1]
    expect(findResultMatches(result, rows, [1], 'alpha', false)).toEqual({ matches: [{ row: 0, column: 1 }, { row: 1, column: 1 }], limited: false })
    expect(findResultMatches(result, rows, [0], 'alpha', false).matches).toEqual([])
    expect(findResultMatches(result, rows, [1], 'Alpha', true).matches).toEqual([{ row: 1, column: 1 }])
    expect(findResultMatches({ ...result, rows: [['x'.repeat(600) + 'needle']] }, [0], [0], 'needle', false).matches).toEqual([{ row: 0, column: 0 }])
    expect(findResultMatches(result, [], [0, 1], 'NULL', false).matches).toEqual([])
  })
  it('allows explicit numeric filtering for untyped expressions and rejects invalid numeric drafts', () => {
    const expression = { ...result, columns: [{ name: 'expression', typeId: 0 }], rows: [['2'], ['10'], ['1000'], [null]] }
    const filter = { column: 0, operator: 'gt' as const, value: '9', mode: 'number' as const }
    expect(exploredRows(expression, { ...emptyExploration(), filters: [filter] })).toEqual([1, 2])
    expect(resultFilterError(expression.columns, [{ ...filter, value: 'invalid' }])).toContain('enter a number')
    expect(resultFilterError(result.columns, [{ column: 0, operator: 'is-null', value: '' }])).toBe('')
    expect(resultFilterError(result.columns, [{ column: 1, operator: 'eq', value: '' }])).toBe('')
  })
  it('bounds find navigation without claiming the remaining matches were searched away', () => {
    const many = { ...result, rows: Array.from({ length: MAX_FIND_MATCHES + 1 }, () => ['hit']) }
    const found = findResultMatches(many, many.rows.map((_, i) => i), [0], 'hit', false)
    expect(found.matches).toHaveLength(MAX_FIND_MATCHES); expect(found.limited).toBe(true)
  })
})

describe('pinned result snapshots', () => {
  const input = () => ({ id: 'capture', name: 'Snapshot 1', capturedAt: '2026-10-28T00:00:00Z', source: 'Query 1 · SQLite', partial: false, result: structuredClone(result), columns: defaultColumns(2), exploration: { ...emptyExploration(), filters: [{ column: 1, operator: 'contains' as const, value: 'Alpha' }] } })
  it('retains immutable values, metadata and view state independently of source mutations', () => {
    const original = input(), [snapshot] = pinResultSnapshot([], original)
    original.result.rows[0][0] = 'changed'; original.result.columns[0].name = 'changed'; original.exploration.filters[0].value = 'changed'; original.columns.hidden.push(0)
    expect(snapshot.result.rows[0][0]).toBe('9007199254740993'); expect(snapshot.result.index).toBe(4)
    expect(snapshot.result.columns[0].name).toBe('amount'); expect(snapshot.result.truncated).toBe(true)
    expect(snapshot.exploration.filters[0].value).toBe('Alpha'); expect(snapshot.columns?.hidden).toEqual([])
  })
  it('refuses capacity overflow without evicting existing captures or silently truncating', () => {
    const [snapshot] = pinResultSnapshot([], input()), existing = Array.from({ length: MAX_RESULT_SNAPSHOTS }, (_, i) => ({ ...snapshot, id: String(i) }))
    expect(() => pinResultSnapshot(existing, input())).toThrow('Remove a snapshot')
    const full: ResultSnapshot[] = [{ ...snapshot, bytes: 32 * 1024 * 1024 }]
    expect(() => pinResultSnapshot(full, input())).toThrow('32 MB')
    expect(existing).toHaveLength(MAX_RESULT_SNAPSHOTS); expect(full[0].result.rows).toEqual(result.rows)
    expect(resultSnapshotBytes({ ...result, rows: [['long'.repeat(100)]] })).toBeGreaterThan(800)
  })
})
