import type { Cell, GridChange, GridSnapshot } from '../shared/contracts'

/** Parse spreadsheet TSV, including quoted tabs, newlines and double quotes. */
export function parseGridTsv(text: string): string[][] {
  if (text.length > 8 * 1024 * 1024) throw new Error('The pasted data exceeds 8 MiB.')
  const rows: string[][] = [[]]
  let value = '', quoted = false, closed = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else value += c
    } else if (c === '"' && !value && !closed) quoted = true
    else if (c === '\t' || c === '\n' || c === '\r') {
      rows.at(-1)!.push(value); value = ''; closed = false
      if (c !== '\t') { if (c === '\r' && text[i + 1] === '\n') i++; rows.push([]) }
    } else if (closed) throw new Error('A quoted pasted value has unexpected text after its closing quote.')
    else value += c
    if (value.length > 16384) throw new Error('A pasted cell exceeds 16,384 characters.')
    if (rows.length > 200 || rows.at(-1)!.length > 100) throw new Error('Paste supports at most 200 rows and 100 columns.')
  }
  if (quoted) throw new Error('A quoted pasted value is not closed.')
  if (value || closed || rows.at(-1)!.length || !rows.length) rows.at(-1)!.push(value)
  else if (rows.length > 1) rows.pop()
  if (rows.some(row => row.length > 100)) throw new Error('Paste supports at most 200 rows and 100 columns.')
  if (!rows[0]?.length || rows.some(row => row.length !== rows[0].length)) throw new Error('Paste a rectangular set of cells.')
  return rows
}

export function duplicateGridRow(grid: GridSnapshot, changes: GridChange[], row: number): GridChange[] {
  if (changes.length >= 200 || row < 0 || row >= grid.rows.length) throw new Error('Select a loaded row and keep at most 200 staged changes.')
  const change = changes.find(item => item.kind !== 'insert' && item.row === row)
  if (change?.kind === 'delete') throw new Error('Undo the row deletion before duplicating it.')
  const values = grid.columns.flatMap((column, index) => {
    if (column.primaryKey || column.generated) return []
    const staged = change?.kind === 'update' ? change.values.find(value => value.column === index) : undefined
    const value = staged ? staged.value : grid.rows[row][index]
    return value === undefined ? [] : [{ column: index, value }]
  })
  return [...changes, { kind: 'insert', values }]
}

/** Apply a rectangle atomically to visible columns and loaded/staged rows. */
export function pasteGrid(grid: GridSnapshot, changes: GridChange[], visible: number[], rowStart: number, columnStart: number, cells: string[][]): GridChange[] {
  const result = structuredClone(changes), inserts = () => result.flatMap((change, index) => change.kind === 'insert' ? [{ change, index }] : [])
  if (rowStart < 0 || columnStart < 0 || rowStart + cells.length > grid.rows.length + inserts().length || columnStart + cells[0].length > visible.length) throw new Error('The pasted cells extend beyond the loaded rows or visible columns.')
  for (let r = 0; r < cells.length; r++) for (let c = 0; c < cells[r].length; c++) {
    const row = rowStart + r, columnIndex = visible[columnStart + c], column = grid.columns[columnIndex], isNew = row >= grid.rows.length
    if (!column || column.generated || column.primaryKey && !isNew) throw new Error('Paste cannot change existing primary keys or generated columns. No cells were changed.')
    const insert = isNew ? inserts()[row - grid.rows.length] : undefined
    const index = insert?.index ?? result.findIndex(change => change.kind !== 'insert' && change.row === row)
    const existing = result[index]
    if (existing?.kind === 'delete') throw new Error('Paste cannot change a row marked for deletion. No cells were changed.')
    const value: Cell = cells[r][c], values = existing ? existing.values.filter(item => item.column !== columnIndex) : []
    if (isNew || value !== grid.rows[row][columnIndex]) values.push({ column: columnIndex, value })
    const updated: GridChange = isNew ? { kind: 'insert', values } : { kind: 'update', row, values }
    if (index < 0) { if (values.length) result.push(updated) }
    else if (!isNew && !values.length) result.splice(index, 1)
    else result[index] = updated
    if (result.length > 200) throw new Error('Paste would exceed 200 staged rows. No cells were changed.')
  }
  return result
}
