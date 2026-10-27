import { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH } from '../shared/column-layout'
export { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH } from '../shared/column-layout'
export const AUTO_SIZE_ROWS = 200
export const AUTO_SIZE_CHARACTERS = 200

export function columnWidth(value: number, fallback = DEFAULT_COLUMN_WIDTH): number {
  return Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Number.isFinite(value) ? value : fallback)))
}

/** Measure a bounded sample of already loaded display values. Never fetch data. */
export function fittedColumnWidth(column: { name: string; type?: string }, count: number,
  cell: (row: number) => string | null | undefined,
  measure: (text: string, kind: 'name' | 'type' | 'value') => number): number {
  const text = (value: string) => value.slice(0, AUTO_SIZE_CHARACTERS).replace(/\s/g, ' ')
  let width = Math.max(measure(text(column.name), 'name'), measure(text(column.type ?? ''), 'type'))
  for (let row = 0; row < Math.min(count, AUTO_SIZE_ROWS) && width < MAX_COLUMN_WIDTH - 32; row++) {
    const value = cell(row)
    width = Math.max(width, measure(text(value === null ? 'NULL' : value === undefined ? 'DEFAULT' : value), 'value'))
  }
  return columnWidth(Math.ceil(width) + 32)
}

/** Read the current grid fonts, including native platform font substitution. */
export function columnMeasurer(grid: HTMLElement | null) {
  const context = document.createElement('canvas').getContext('2d')
  const font = (selector: string, fallback: string) => {
    const element = grid?.querySelector(selector)
    return element ? getComputedStyle(element).font || fallback : fallback
  }
  const fonts = {
    name: font('.grid-header b', '500 11px sans-serif'),
    type: font('.grid-header small', '8px monospace'),
    value: font('.grid-row', '11px monospace')
  }
  return (text: string, kind: keyof typeof fonts) => {
    if (!context) return text.length * 8
    context.font = fonts[kind]
    return context.measureText(text).width
  }
}
