import { INSPECT_LIMIT } from '../shared/inspection'
import type { GridColumn } from '../shared/contracts'
import { GridSql } from './grid-sql'

export function inspectExpression(d: GridSql, column: GridColumn) {
  const name = d.q(column.name), type = column.type.toLowerCase()
  const binary = /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|raw|image|rowversion)(\b|\()/.test(type) || d.mssql && type === 'timestamp'
  const supported = d.supported(column) || binary || /^(clob|nclob|xml|xmltype|json|jsonb|text|ntext)(\b|\()/.test(type) || /^(real|float|double|binary_float|binary_double)/.test(type) || d.engine === 'sqlite'
  if (!supported) throw new Error(`Inspection of ${column.type} requires an explicit SQL conversion.`)
  const limit = INSPECT_LIMIT + 1
  let value: string
  if (d.engine === 'postgres') value = binary ? `encode(${name},'hex')` : `CAST(${name} AS TEXT)`
  else if (d.mysql) value = binary ? `HEX(${name})` : `CAST(${name} AS CHAR CHARACTER SET utf8mb4)`
  else if (d.mssql) value = binary ? `CONVERT(varchar(max),${name},2)` : type === 'xml' ? `CONVERT(nvarchar(max),${name})` : `CONVERT(nvarchar(max),${name},126)`
  else if (d.engine === 'duckdb') value = binary ? `hex(${name})` : `CAST(${name} AS VARCHAR)`
  else if (d.engine === 'sqlite') value = `CASE WHEN typeof(${name})='blob' THEN hex(${name}) ELSE CAST(${name} AS TEXT) END`
  else {
    // BLOB locators are read with a native, bounded getData call by the adapter.
    if (type === 'blob') return { value: name, kind: "'hex'" }
    value = binary ? `RAWTOHEX(${name})` : type === 'xmltype' ? `XMLSERIALIZE(CONTENT ${name} AS CLOB)` : type === 'json' ? `JSON_SERIALIZE(${name} RETURNING CLOB)` : /^(n?clob)$/.test(type) ? name : `TO_CLOB(${name})`
  }
  return { value: `${d.mssql ? 'SUBSTRING' : 'SUBSTR'}(${value},1,${limit})`, kind: d.engine === 'sqlite' ? `CASE WHEN typeof(${name})='blob' THEN 'hex' ELSE 'text' END` : binary ? "'hex'" : "'text'" }
}
