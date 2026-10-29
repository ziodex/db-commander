import type { ResultSet } from '../shared/contracts'

export interface GridPoint { row: number; column: number }
export interface GridSelection { anchor: GridPoint; focus: GridPoint }
export type GridCopyFormat = 'tsv' | 'csv' | 'json' | 'markdown'

/** Columns are source indices, but a range always follows the visible order. */
export function selectionBounds(selection: GridSelection | null, visible: number[], rowCount: number) {
  if (!selection || !rowCount) return null
  const anchor = visible.indexOf(selection.anchor.column), focus = visible.indexOf(selection.focus.column)
  if (anchor < 0 || focus < 0) return null
  return {
    firstRow: Math.max(0, Math.min(selection.anchor.row, selection.focus.row, rowCount - 1)),
    lastRow: Math.min(rowCount - 1, Math.max(selection.anchor.row, selection.focus.row)),
    firstColumn: Math.min(anchor, focus), lastColumn: Math.max(anchor, focus)
  }
}

export function copyGridSelection(result: ResultSet, visible: number[], selection: GridSelection, headers = false, format: GridCopyFormat = 'tsv') {
  const bounds = selectionBounds(selection, visible, result.rows.length)
  if (!bounds) return ''
  const columns = visible.slice(bounds.firstColumn, bounds.lastColumn + 1)
  const single = format === 'tsv' && !headers && bounds.firstRow === bounds.lastRow && columns.length === 1
  const encode = (value: string | null) => {
    const text = value ?? 'NULL'
    return !single && /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines: string[] = []
  let length = 0
  function line(text: string) {
    length += text.length + (lines.length ? 2 : 0)
    if (length > 1_000_000) throw new Error('This selection is too large to copy. Select fewer cells or export the results.')
    lines.push(text)
  }
  const names = columns.map(column => result.columns[column].name)
  const values = (row: number) => columns.map(column => result.rows[row][column])
  if (format === 'json') {
    // Names are a separate array: duplicate SQL labels must not overwrite cells.
    line(`{"columns":${JSON.stringify(names)},"rows":[`)
    for (let row = bounds.firstRow; row <= bounds.lastRow; row++) line(`${row === bounds.firstRow ? '' : ','}${JSON.stringify(values(row))}`)
    line(']}')
    return lines.join('\r\n')
  }
  if (format === 'markdown') {
    const escape = (value: string | null) => (value ?? 'NULL').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
    const append = (cells: (string | null)[]) => line(`| ${cells.map(escape).join(' | ')} |`)
    append(names); line(`| ${columns.map(() => '---').join(' | ')} |`)
    for (let row = bounds.firstRow; row <= bounds.lastRow; row++) append(values(row))
    return lines.join('\r\n')
  }
  function append(cells: (string | null)[]) {
    const text = format === 'csv' ? cells.map(value => value === null ? 'NULL' : `"${value.replace(/"/g, '""')}"`).join(',') : cells.map(encode).join('\t')
    line(text)
  }
  if (headers) append(names)
  for (let row = bounds.firstRow; row <= bounds.lastRow; row++) append(values(row))
  return lines.join('\r\n')
}
