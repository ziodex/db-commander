import { quoteIdentifier } from '../shared/sql/common'
import type { Cell, Column, DatabaseEngine } from '../shared/contracts'
import { insertTargetSchema, type InsertTarget } from '../shared/transfer'

type Kind = 'text' | 'number' | 'boolean' | 'binary' | 'date' | 'timestamp' | 'zoned' | 'time' | 'unsupported'
const postgres: Record<number, Kind> = {
  16:'boolean',17:'binary',18:'text',19:'text',20:'number',21:'number',23:'number',25:'text',26:'number',
  114:'text',142:'text',700:'number',701:'number',1042:'text',1043:'text',1082:'date',1083:'time',
  1114:'timestamp',1184:'zoned',1700:'number',2950:'text',3802:'text'
}
function kind(column: Column, engine: DatabaseEngine): Kind {
  if (engine === 'postgres') return postgres[column.typeId] ?? 'unsupported'
  const type = (column.typeName ?? '').toUpperCase().replace(/\s*\([^)]*\)/g, '').trim()
  if (engine === 'mysql' || engine === 'mariadb') {
    if (column.typeId === 255) return 'unsupported' // Geometry bytes are not ordinary binary values.
    if ([0,1,2,3,4,5,8,9,13,246].includes(column.typeId)) return 'number'
    if ([7,12,17,18].includes(column.typeId)) return 'timestamp'
    if ([10,14].includes(column.typeId)) return 'date'
    if ([11,19].includes(column.typeId)) return 'time'
    if (type === 'BINARY' || column.typeId === 16) return 'binary'
    if ([15,249,250,251,252,253,254,245].includes(column.typeId)) return 'text'
    return 'unsupported'
  }
  if (/^(BOOL|BOOLEAN|BIT|BITN)$/.test(type)) return 'boolean'
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|INT1|INT2|INT4|INT8|INTN|NUMBER|NUMERIC|DECIMAL|DECIMALN|NUMERICN|MONEY|MONEYN|SMALLMONEY|REAL|FLOAT|FLOAT4|FLOAT8|FLOATN|DOUBLE|DOUBLE PRECISION|BINARY_FLOAT|BINARY_DOUBLE)( UNSIGNED)?$/.test(type)) return 'number'
  if (/^(CHAR|NCHAR|VARCHAR|NVARCHAR|VARCHAR2|NVARCHAR2|BPCHAR|TEXT|NTEXT|STRING|UUID|UNIQUEIDENTIFIER|JSON|XML)$/.test(type)) return 'text'
  if (/^(BINARY|VARBINARY|BLOB|RAW|LONG RAW|IMAGE)$/.test(type)) return 'binary'
  if (/^(TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITH LOCAL TIME ZONE|DATETIMEOFFSET)$/.test(type)) return 'zoned'
  if (type === 'DATE') return engine === 'oracle' ? 'timestamp' : 'date'
  if (/^(TIMESTAMP|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS|DATETIME|DATETIMEN|SMALLDATETIME|DATETIME2)$/.test(type)) {
    // SQL Server TIMESTAMP is a binary rowversion, not a calendar value.
    return type === 'TIMESTAMP' && ['sqlserver','azure-sql'].includes(engine) ? 'unsupported' : 'timestamp'
  }
  if (type === 'TIME') return 'time'
  return 'unsupported'
}
const fail = () => new Error('SQL INSERT export cannot represent this value exactly. Convert unsupported columns explicitly in the SELECT, or use JSON export.')
const quoted = (value: string) => "'" + value.replaceAll("'", "''") + "'"
function textLiteral(value: string, engine: DatabaseEngine) {
  if (engine === 'postgres') return 'E' + quoted(value.replaceAll('\\', '\\\\'))
  if (engine === 'mysql' || engine === 'mariadb') return `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`
  if (engine === 'sqlserver' || engine === 'azure-sql') return 'N' + quoted(value)
  if (engine === 'oracle' && Buffer.byteLength(value, 'utf8') > 4000) throw fail()
  return quoted(value)
}
const date = '[0-9]{4}-[0-9]{2}-[0-9]{2}'
const time = '[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?'
function temporal(value: string, type: Kind, engine: DatabaseEngine, column: Column) {
  let normalized = value.replace('T',' ').replace(/\s+([+-]\d\d(?::\d\d)?)$/, '$1')
  if (type === 'zoned') normalized = normalized.replace(/Z$/, '+00:00').replace(/([+-]\d\d)$/, '$1:00')
  const expression = type === 'date' ? date : type === 'time' ? time : date + ' ' + time + (type === 'zoned' ? '[+-][0-9]{2}:[0-9]{2}' : '')
  if (!new RegExp('^' + expression + '$').test(normalized)) throw fail()
  if (engine === 'sqlite') return quoted(normalized)
  if (engine === 'mysql' || engine === 'mariadb') return quoted(normalized)
  if (engine === 'sqlserver' || engine === 'azure-sql') {
    const target = type === 'date' ? 'date' : type === 'time' ? 'time(7)' : type === 'zoned' ? 'datetimeoffset(7)' : 'datetime2(7)'
    if ((normalized.match(/\.(\d+)/)?.[1].length ?? 0) > 7) throw fail()
    return `CONVERT(${target}, ${quoted(normalized.replace(' ', 'T'))}, ${type === 'date' ? 23 : 127})`
  }
  if (engine === 'oracle') {
    const model = 'FXYYYY-MM-DD HH24:MI:SS' + (normalized.includes('.') ? '.FF9' : '') + (type === 'zoned' ? 'TZH:TZM' : '')
    // DATE contains a time of day; an explicit model avoids NLS_DATE_FORMAT.
    const fn = column.typeName?.toUpperCase() === 'DATE' ? 'TO_DATE' : type === 'zoned' ? 'TO_TIMESTAMP_TZ' : 'TO_TIMESTAMP'
    return `${fn}(${quoted(normalized)}, '${model}', 'NLS_CALENDAR=GREGORIAN')`
  }
  return `${type === 'date' ? 'DATE' : type === 'time' ? 'TIME' : type === 'zoned' ? 'TIMESTAMPTZ' : engine === 'duckdb' && column.typeName?.toUpperCase() === 'TIMESTAMP_NS' ? 'TIMESTAMP_NS' : 'TIMESTAMP'} ${quoted(normalized)}`
}
function literal(value: Cell, type: Kind, engine: DatabaseEngine, column: Column): string {
  if (value === null) return 'NULL'
  if (value.length > 16384 || value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw fail()
  if (type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw fail()
    return value // Exact spelling, never converted through Number.
  }
  if (type === 'boolean') {
    if (!/^(true|false|t|f|0|1)$/i.test(value)) throw fail()
    const truth = /^(true|t|1)$/i.test(value)
    return ['postgres','duckdb','oracle'].includes(engine) ? truth ? 'TRUE' : 'FALSE' : truth ? '1' : '0'
  }
  if (type === 'binary') {
    if (!/^(?:0x|\\x)(?:[0-9a-fA-F]{2})*$/.test(value)) throw fail()
    const hex = value.slice(2)
    if (engine === 'postgres') return `decode('${hex}', 'hex')`
    if (engine === 'duckdb') return `from_hex('${hex}')`
    if (engine === 'oracle') { if (hex.length > 4000) throw fail(); return `HEXTORAW('${hex}')` }
    if (['sqlserver','azure-sql'].includes(engine)) return '0x' + hex
    return `X'${hex}'`
  }
  if (type === 'text') {
    // SQLite permits BLOB storage even in declared TEXT columns; Cell alone
    // cannot distinguish that display encoding from literal text. Refuse ambiguity.
    if (engine === 'sqlite' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw fail()
    return textLiteral(value, engine)
  }
  if (['date','timestamp','zoned','time'].includes(type)) return temporal(value, type, engine, column)
  throw fail()
}

/** Generates data-only, same-engine SQL. Never connects to or executes on the destination. */
export function insertWriter(engine: DatabaseEngine, input: InsertTarget, columns: Column[]) {
  const target = insertTargetSchema.parse(input)
  if (!columns.length || columns.length > 100 || columns.some(column => !column.name.trim() || column.name.length > 255 || /[\u0000-\u001f\u007f]/.test(column.name)) || new Set(columns.map(column => column.name.toLowerCase())).size !== columns.length) throw new Error('SQL INSERT export needs 1–100 uniquely named result columns. Alias duplicate or unnamed columns in the SELECT.')
  for (const name of [target.name, target.schema, ...columns.map(column => column.name)]) {
    if (name === undefined) continue
    const limit = engine === 'postgres' ? 63 : engine === 'oracle' || ['sqlserver','azure-sql'].includes(engine) ? 128 : ['mysql','mariadb'].includes(engine) ? 64 : 255
    const size = ['postgres','oracle'].includes(engine) ? Buffer.byteLength(name, 'utf8') : name.length
    if (size > limit || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name) || ['mysql','mariadb'].includes(engine) && name.includes('\\')) throw new Error('SQL INSERT export identifier exceeds the engine limit or contains unsupported characters. Use a shorter destination or result alias.')
  }
  const table = [target.schema, target.name].filter((value): value is string => value !== undefined).map(value => quoteIdentifier(value, engine)).join('.')
  const prefix = `INSERT INTO ${table} (${columns.map(column => quoteIdentifier(column.name, engine)).join(', ')}) VALUES (`
  const types = columns.map(column => kind(column, engine))
  return { header: `-- Db Commander SQL INSERT export (${engine}).\n-- Data only. Review the destination, column types and transaction strategy before execution.\n-- No CREATE, identity override, BEGIN or COMMIT is included.\n`, row(values: Cell[]) {
    if (values.length !== columns.length) throw new Error('SQL INSERT export received a row that does not match its columns.')
    const sql = prefix + values.map((value, i) => literal(value, types[i], engine, columns[i])).join(', ') + ');\n'
    if (Buffer.byteLength(sql) > 2 * 1024 * 1024) throw new Error('SQL INSERT export exceeds the 2 MiB statement limit.')
    return sql
  } }
}
