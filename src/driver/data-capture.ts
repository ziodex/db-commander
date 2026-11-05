import type { Cell, GridColumn, GridTable } from '../shared/contracts'
import { DATA_BYTES, DATA_CELL, DATA_COLUMNS, DATA_ROWS, type DataCapture, type DataCaptureRequest } from '../shared/data-compare'
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
    if (!d.supported(column) || d.binary(column)) throw new Error(`Column “${name}” (${column.type}) has no exact comparison representation. Exclude it or use SQL.`)
    return column
  })
  // Reuse the browser's catalog-checked, bound AND filters. No arbitrary SQL or
  // renderer-provided type casts are accepted. Ordering is not used for matching.
  const selection = browseSelect(d, table, available, { offset: 0, pageSize: 200, filters: request.filters, sort: [] })
  const expressions = columns.map(c => `${d.mssql ? 'SUBSTRING' : 'SUBSTR'}(${d.expression(c, d.engine === 'sqlite' ? DATA_CELL : false)},1,${DATA_CELL + 1})`)
  const paging = d.mssql || d.engine === 'oracle' ? `OFFSET 0 ROWS FETCH NEXT ${request.maxRows + 1} ROWS ONLY` : `LIMIT ${request.maxRows + 1} OFFSET 0`
  let sql = `SELECT ${expressions.join(',')} ${selection.from} ${paging}`
  // The larger result is still a single statement on each owner. A window
  // total prevents a wide, oversized selection from crossing the driver
  // boundary before the exact JSON byte check below.
  const large = request.maxRows > 200
  if (large) {
    const names = expressions.map((_, index) => `cell_${index}`)
    const bytes = (name: string) => {
      if (d.mssql) return `DATALENGTH(${name})`
      if (d.engine === 'oracle') return `LENGTHB(${name})`
      if (d.engine === 'sqlite') return `LENGTH(CAST(${name} AS BLOB))`
      if (d.engine === 'duckdb') return `OCTET_LENGTH(ENCODE(${name}))`
      return `OCTET_LENGTH(${name})`
    }
    const size = names.map(name => `COALESCE(${bytes(name)},0)`).join('+')
    const limit = 2 * DATA_BYTES
    const projection = names.map(name => `CASE WHEN capture_bytes <= ${limit} THEN ${name} END`).join(',')
    const limited = `SELECT ${expressions.map((value, index) => `${value} AS ${names[index]}`).join(',')} ${selection.from} ${paging}`
    sql = `SELECT ${projection}, CASE WHEN capture_bytes <= ${limit} THEN 'ok' ELSE 'overflow' END, capture_rows
      FROM (SELECT captured.*, SUM(${size}) OVER () AS capture_bytes, COUNT(*) OVER () AS capture_rows FROM (${limited}) captured) measured`
  }
  const response = await query(sql, selection.values, large ? request.maxRows + 1 : undefined)
  if (response.warnings) throw new Error('The database reported a conversion warning. No comparison was produced.')
  if (response.rows.length > request.maxRows) throw new Error(`The ${request.maxRows}-row limit was exceeded. Narrow the filters or raise the limit (maximum ${DATA_ROWS}). No partial comparison was produced.`)
  const rows = large ? response.rows.map(row => {
    if (Number(row.at(-1)) !== response.rows.length) throw new Error('The driver returned an incomplete capture. No partial comparison was produced.')
    if (row.at(-2) !== 'ok') throw new Error('Comparison data exceeds 4 MiB on one side. Select fewer rows or columns.')
    return row.slice(0, -2)
  }) : response.rows
  const seen = new Set<string>(), indexes = keys.map(name => columns.findIndex(c => c.name === name))
  let bytes = 0
  for (const row of rows) {
    if (row.length !== columns.length || row.some(value => value !== null && typeof value !== 'string')) throw new Error('The database returned an unsupported comparison value.')
    if (row.some(value => value !== null && value.length > DATA_CELL)) throw new Error(`A comparison value exceeds ${DATA_CELL} characters. Exclude the column or narrow the filters; no truncated values are compared.`)
    if (d.engine === 'sqlite' && row.includes('nul:')) throw new Error('SQLite text containing NUL cannot be captured losslessly. Exclude the column or narrow the filters.')
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (bytes > DATA_BYTES) throw new Error('Comparison data exceeds 4 MiB on one side. Select fewer rows or columns.')
    const key: Cell[] = indexes.map(index => row[index])
    if (key.some(v => v === null || v === undefined)) throw new Error('Comparison keys contain NULL. Choose a non-null key or narrow the filters.')
    const encoded = JSON.stringify(key)
    if (seen.has(encoded)) throw new Error('Comparison keys are not unique within the selected rows. Choose a unique or composite key.')
    seen.add(encoded)
  }
  return { columns, keys, rows, primaryKey: available.filter(column => column.primaryKey).map(column => column.name) }
}
