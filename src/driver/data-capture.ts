import type { Cell, GridColumn, GridTable } from '../shared/contracts'
import { DATA_BYTES, DATA_CELL, DATA_COLUMNS, type DataCapture, type DataCaptureRequest } from '../shared/data-compare'
import { browseSelect } from './browse-sql'
import type { GridSql } from './grid-sql'
import type { GridQuery } from './table-editor'

export async function captureData(d: GridSql, table: GridTable, available: GridColumn[], request: DataCaptureRequest, query: GridQuery): Promise<DataCapture> {
  const keys = request.keys.length ? request.keys : available.filter(c => c.primaryKey).map(c => c.name)
  if (!keys.length || keys.length > 8) throw new Error('Choose one to eight unique, non-null key columns, or use a declared primary key.')
  if (keys.some(name => !available.some(c => c.name === name))) throw new Error('A chosen key column is unavailable. Refresh the schema.')
  const names = request.columns.length ? [...new Set([...keys, ...request.columns])] : available.map(c => c.name)
  if (names.length > DATA_COLUMNS) throw new Error(`Select at most ${DATA_COLUMNS} columns including the key.`)
  const columns = names.map(name => {
    const column = available.find(c => c.name === name)
    if (!column) throw new Error(`Column “${name}” is unavailable. Refresh the schema and review the comparison.`)
    if (!d.supported(column)) throw new Error(`Column “${name}” (${column.type}) has no exact comparison representation. Exclude it or use SQL.`)
    return column
  })
  // Reuse the browser's catalog-checked, bound AND filters. No arbitrary SQL or
  // renderer-provided type casts are accepted. Ordering is not used for matching.
  const selection = browseSelect(d, table, available, { offset: 0, pageSize: 200, filters: request.filters, sort: [] })
  const expressions = columns.map(c => `${d.mssql ? 'SUBSTRING' : 'SUBSTR'}(${d.expression(c)},1,${DATA_CELL + 1})`)
  const paging = d.mssql || d.engine === 'oracle' ? `OFFSET 0 ROWS FETCH NEXT ${request.maxRows + 1} ROWS ONLY` : `LIMIT ${request.maxRows + 1} OFFSET 0`
  const sql = `SELECT ${expressions.join(',')} ${selection.from} ${paging}`
  const response = await query(sql, selection.values)
  if (response.warnings) throw new Error('The database reported a conversion warning. No comparison was produced.')
  if (response.rows.length > request.maxRows) throw new Error(`The ${request.maxRows}-row limit was exceeded. Narrow the filters or raise the limit (maximum 200). No partial comparison was produced.`)
  const seen = new Set<string>(), indexes = keys.map(name => columns.findIndex(c => c.name === name))
  let bytes = 0
  for (const row of response.rows) {
    if (row.length !== columns.length || row.some(value => value !== null && typeof value !== 'string')) throw new Error('The database returned an unsupported comparison value.')
    if (row.some(value => value !== null && value.length > DATA_CELL)) throw new Error(`A comparison value exceeds ${DATA_CELL} characters. Exclude the column or narrow the filters; no truncated values are compared.`)
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (bytes > DATA_BYTES) throw new Error('Comparison data exceeds 4 MiB on one side. Select fewer rows or columns.')
    const key: Cell[] = indexes.map(index => row[index])
    if (key.some(v => v === null || v === undefined)) throw new Error('Comparison keys contain NULL. Choose a non-null key or narrow the filters.')
    const encoded = JSON.stringify(key)
    if (seen.has(encoded)) throw new Error('Comparison keys are not unique within the selected rows. Choose a unique or composite key.')
    seen.add(encoded)
  }
  return { columns, keys, rows: response.rows }
}
