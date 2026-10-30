import type { Cell, Column, ResultSet } from '../shared/contracts'

export type ResultFilterOperator = 'contains' | 'not-contains' | 'starts-with' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'is-null' | 'not-null'
export interface ResultFilter { column: number; operator: ResultFilterOperator; value: string; mode?: ResultSort['mode'] }
export interface ResultSort { column: number; direction: 'asc' | 'desc'; mode: 'auto' | 'text' | 'number' }
export interface ResultExploration { find: string; matchCase: boolean; filters: ResultFilter[]; sort: ResultSort[] }
export const emptyExploration = (): ResultExploration => ({ find: '', matchCase: false, filters: [], sort: [] })
export const MAX_RESULT_FILTERS = 8
export const MAX_RESULT_SORTS = 3
export const MAX_FIND_MATCHES = 10_000

/** Compare decimal captures without converting them to lossy JS numbers. */
function decimal(value: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.trim())
    ?? /^([+-]?)()(?:\.(\d+))(?:e([+-]?\d+))?$/i.exec(value.trim())
  if (!match) return undefined
  const digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '') || '0'
  return { digits, negative: match[1] === '-' && digits !== '0', order: BigInt(digits.length) + BigInt(match[4] ?? '0') - BigInt(match[3]?.length ?? 0) }
}
function specialNumber(value: string) {
  const text = value.trim().toLowerCase()
  return /^-inf(?:inity)?$/.test(text) ? 0 : /^\+?inf(?:inity)?$/.test(text) ? 2 : /^[+-]?nan$/.test(text) ? 3 : undefined
}
export function compareCapturedNumbers(a: string, b: string): number | undefined {
  const left = decimal(a), right = decimal(b)
  const leftSpecial = specialNumber(a), rightSpecial = specialNumber(b)
  if (leftSpecial !== undefined || rightSpecial !== undefined) {
    if (!left && leftSpecial === undefined || !right && rightSpecial === undefined) return undefined
    return (leftSpecial ?? 1) - (rightSpecial ?? 1)
  }
  if (!left || !right) return undefined
  if (left.digits === '0' && right.digits === '0') return 0
  if (left.negative !== right.negative) return left.negative ? -1 : 1
  let compared: number
  if (left.digits === '0') compared = -1
  else if (right.digits === '0') compared = 1
  else if (left.order !== right.order) compared = left.order < right.order ? -1 : 1
  else {
    const length = Math.max(left.digits.length, right.digits.length)
    const x = left.digits.padEnd(length, '0'), y = right.digits.padEnd(length, '0')
    compared = x === y ? 0 : x < y ? -1 : 1
  }
  return left.negative ? -compared : compared
}
export function numericColumn(column: Column) {
  return /^(?:u?(?:tinyint|smallint|integer|int\d*|bigint|hugeint)|int[248]|serial\d*|bigserial|smallserial|decimal|numeric|number|real|double|float|money|smallmoney|ubigint)\b/i.test(column.typeName ?? '')
    || !column.typeName && [20, 21, 23, 26, 700, 701, 1700].includes(column.typeId)
}
export function resultFilterError(columns: Column[], filters: ResultFilter[]) {
  for (const [index, filter] of filters.entries()) {
    const column = columns[filter.column]
    if (!column) return `Choose a column for filter ${index + 1}.`
    if ((filter.mode === 'number' || filter.mode !== 'text' && numericColumn(column)) && ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(filter.operator) && !decimal(filter.value) && specialNumber(filter.value) === undefined) return `Filter ${index + 1}: enter a number for ${column.name}.`
  }
  return ''
}
const textCompare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1
function compareValue(a: string, b: string, column: Column, mode: ResultSort['mode'] = 'auto') {
  return (mode === 'number' || mode === 'auto' && numericColumn(column) ? compareCapturedNumbers(a, b) : undefined) ?? textCompare(a, b)
}
function accepts(value: Cell, filter: ResultFilter, column: Column, matchCase: boolean) {
  if (filter.operator === 'is-null') return value === null
  if (filter.operator === 'not-null') return value !== null
  if (value === null) return false
  const a = matchCase ? value : value.toLowerCase(), b = matchCase ? filter.value : filter.value.toLowerCase()
  switch (filter.operator) {
    case 'contains': return a.includes(b)
    case 'not-contains': return !a.includes(b)
    case 'starts-with': return a.startsWith(b)
    case 'eq': return compareValue(a, b, column, filter.mode) === 0
    case 'ne': return compareValue(a, b, column, filter.mode) !== 0
    case 'lt': return compareValue(a, b, column, filter.mode) < 0
    case 'lte': return compareValue(a, b, column, filter.mode) <= 0
    case 'gt': return compareValue(a, b, column, filter.mode) > 0
    case 'gte': return compareValue(a, b, column, filter.mode) >= 0
  }
}

/** Returns source row ordinals. The source capture is never sorted or edited. */
export function exploredRows(result: ResultSet, exploration: ResultExploration) {
  const filters = exploration.filters.filter(filter => result.columns[filter.column])
  const sorts = exploration.sort.filter(sort => result.columns[sort.column])
  const rows = result.rows.map((_, index) => index).filter(row => filters.every(filter => accepts(result.rows[row][filter.column] ?? null, filter, result.columns[filter.column], exploration.matchCase)))
  if (sorts.length) rows.sort((a, b) => {
    for (const sort of sorts) {
      const left = result.rows[a][sort.column] ?? null, right = result.rows[b][sort.column] ?? null
      // NULL remains last in either direction; equal values retain source order.
      if (left === null || right === null) { if (left !== right) return left === null ? 1 : -1; continue }
      const compared = compareValue(left, right, result.columns[sort.column], sort.mode)
      if (compared) return compared * (sort.direction === 'desc' ? -1 : 1)
    }
    return a - b
  })
  return rows
}
export interface ResultMatch { row: number; column: number }
export function findResultMatches(result: ResultSet, rows: number[], visible: number[], text: string, matchCase: boolean) {
  const matches: ResultMatch[] = [], needle = matchCase ? text : text.toLowerCase()
  if (!needle) return { matches, limited: false }
  for (let row = 0; row < rows.length; row++) for (const column of visible) {
    const value = result.rows[rows[row]][column]
    if (value !== null && value !== undefined && (matchCase ? value : value.toLowerCase()).includes(needle)) {
      if (matches.length === MAX_FIND_MATCHES) return { matches, limited: true }
      matches.push({ row, column })
    }
  }
  return { matches, limited: false }
}
