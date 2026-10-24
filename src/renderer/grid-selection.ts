import type { ResultSet } from '../shared/contracts'

export interface GridPoint { row: number; column: number }
export interface GridSelection { anchor: GridPoint; focus: GridPoint }

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

export function copyGridSelection(result: ResultSet, visible: number[], selection: GridSelection, headers = false) {
  const bounds = selectionBounds(selection, visible, result.rows.length)
  if (!bounds) return ''
  const columns = visible.slice(bounds.firstColumn, bounds.lastColumn + 1)
  const single = !headers && bounds.firstRow === bounds.lastRow && columns.length === 1
  const encode = (value: string | null) => {
    const text = value ?? 'NULL'
    return !single && /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines: string[] = []
  let length = 0
  function append(values: (string | null)[]) {
    const line = values.map(encode).join('\t')
    length += line.length + (lines.length ? 2 : 0)
    if (length > 1_000_000) throw new Error('This selection is too large to copy. Select fewer cells or export the results.')
    lines.push(line)
  }
  if (headers) append(columns.map(column => result.columns[column].name))
  for (let row = bounds.firstRow; row <= bounds.lastRow; row++) append(columns.map(column => result.rows[row][column]))
  return lines.join('\r\n')
}
