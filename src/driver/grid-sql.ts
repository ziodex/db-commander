import type { DatabaseEngine, GridColumn, GridTable } from '../shared/contracts'
import { quoteIdentifier } from '../shared/sql/common'
import { GRID_CELL_LIMIT, GRID_PREVIEW_CELL_LIMIT } from '../shared/grid-limits'

export class GridSql {
  constructor(readonly engine: DatabaseEngine) {}
  get mysql() { return this.engine === 'mysql' || this.engine === 'mariadb' }
  get mssql() { return this.engine === 'sqlserver' || this.engine === 'azure-sql' }
  q(name: string) { return quoteIdentifier(name, this.engine) }
  table(table: GridTable) { return [...(this.engine === 'duckdb' && table.catalog ? [table.catalog] : []), table.schema, table.name].map(name => this.q(name)).join('.') }
  p(index: number) { return this.engine === 'postgres' ? `$${index}` : this.engine === 'oracle' ? `:p${index}` : this.mssql ? `@p${index}` : '?' }
  binary(column: GridColumn) { return this.engine === 'postgres' && column.type.toLowerCase() === 'bytea' || this.engine === 'duckdb' && column.type.toLowerCase() === 'blob' }
  /** All catalog filters are bound, including names containing SQL syntax. */
  metadata(table: GridTable, browse = false): { sql: string; values: string[] } {
    const a = this.p(1), b = this.p(2)
    if (this.engine === 'postgres') return { values: [table.schema, table.name], sql: `SELECT a.attname,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,
      EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=t.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)),
      a.attgenerated<>'' OR a.attidentity<>'',a.atthasdef,t.oid::text,pg_get_expr(d.adbin,d.adrelid),a.attcollation::text
      FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
      WHERE n.nspname=${a} AND t.relname=${b} AND t.relkind IN (${browse ? "'r','p','v','m','f'" : "'r','p'"}) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum` }
    if (this.mysql) return { values: [table.schema, table.name], sql: `SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',c.COLUMN_KEY='PRI',
      c.GENERATION_EXPRESSION<>'' OR c.EXTRA LIKE '%auto_increment%',c.COLUMN_DEFAULT IS NOT NULL,t.CREATE_TIME,c.GENERATION_EXPRESSION,c.COLUMN_DEFAULT,c.CHARACTER_SET_NAME,c.COLLATION_NAME
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA=${a} AND c.TABLE_NAME=${b} ${browse ? '' : `AND t.TABLE_TYPE='BASE TABLE' AND t.ENGINE='InnoDB'
      AND NOT EXISTS(SELECT 1 FROM information_schema.TRIGGERS tr WHERE tr.EVENT_OBJECT_SCHEMA=t.TABLE_SCHEMA AND tr.EVENT_OBJECT_TABLE=t.TABLE_NAME)`}
      ORDER BY c.ORDINAL_POSITION` }
    if (this.mssql) return { values: [table.schema, table.name], sql: `SELECT c.name,TYPE_NAME(c.system_type_id),c.is_nullable,
      CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns k ON k.object_id=i.object_id AND k.index_id=i.index_id WHERE i.object_id=t.object_id AND i.is_primary_key=1 AND k.column_id=c.column_id) THEN 1 ELSE 0 END,
      CASE WHEN c.is_identity=1 OR c.is_computed=1 OR c.generated_always_type<>0 OR c.system_type_id=189 THEN 1 ELSE 0 END,
      CASE WHEN c.default_object_id<>0 THEN 1 ELSE 0 END,t.object_id,CONCAT(c.max_length,':',c.precision,':',c.scale,':',c.collation_name,':',cc.definition,':',OBJECT_DEFINITION(c.default_object_id))
      FROM ${browse ? 'sys.objects' : 'sys.tables'} t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id
      LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
      WHERE s.name=${a} AND t.name=${b} AND t.is_ms_shipped=0 AND ${browse ? "t.type IN ('U','V')" : 't.is_memory_optimized=0'} ORDER BY c.column_id` }
    if (this.engine === 'oracle') return { values: [table.schema, table.name], sql: `SELECT c.COLUMN_NAME,c.DATA_TYPE,CASE WHEN c.NULLABLE='Y' THEN 1 ELSE 0 END,
      CASE WHEN EXISTS(SELECT 1 FROM ALL_CONSTRAINTS k JOIN ALL_CONS_COLUMNS kc ON kc.OWNER=k.OWNER AND kc.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.OWNER=c.OWNER AND k.TABLE_NAME=c.TABLE_NAME AND k.CONSTRAINT_TYPE='P' AND k.STATUS='ENABLED' AND kc.COLUMN_NAME=c.COLUMN_NAME) THEN 1 ELSE 0 END,
      CASE WHEN c.VIRTUAL_COLUMN='YES' OR c.IDENTITY_COLUMN='YES' THEN 1 ELSE 0 END,CASE WHEN c.DEFAULT_LENGTH>0 THEN 1 ELSE 0 END,o.OBJECT_ID,
      c.DATA_LENGTH||':'||c.DATA_PRECISION||':'||c.DATA_SCALE,c.DATA_DEFAULT
      FROM ALL_TAB_COLS c ${browse ? 'LEFT JOIN' : 'JOIN'} ALL_TABLES t ON t.OWNER=c.OWNER AND t.TABLE_NAME=c.TABLE_NAME
      JOIN ALL_OBJECTS o ON o.OWNER=c.OWNER AND o.OBJECT_NAME=c.TABLE_NAME AND o.OBJECT_TYPE IN (${browse ? "'TABLE','VIEW'" : "'TABLE'"})
      WHERE c.OWNER=${a} AND c.TABLE_NAME=${b} AND c.USER_GENERATED='YES' ${browse ? '' : "AND t.NESTED='NO'"} ORDER BY c.INTERNAL_COLUMN_ID` }
    if (this.engine === 'sqlite') return { values: [table.name, table.schema, table.name], sql: `SELECT c.name,c.type,NOT c.[notnull],c.pk>0,c.hidden<>0,
      c.dflt_value IS NOT NULL OR (c.pk>0 AND upper(c.type)='INTEGER'),t.rootpage,t.sql
      FROM pragma_table_xinfo(${a},${b}) c JOIN ${this.q(table.schema)}.sqlite_schema t ON t.name=${this.p(3)} AND t.type IN (${browse ? "'table','view'" : "'table'"})
      WHERE ${browse ? 'c.hidden<>1' : "t.sql NOT LIKE 'CREATE VIRTUAL TABLE%'"} ORDER BY c.cid` }
    // Generated columns are identified from the server-produced CREATE text;
    // column_default alone also includes ordinary defaults.
    return { values: [table.schema, table.name, table.catalog ?? ''], sql: `SELECT c.column_name,c.data_type,c.is_nullable,
      EXISTS(SELECT 1 FROM system.main.duckdb_constraints() k WHERE k.database_name=c.database_name AND k.schema_name=c.schema_name AND k.table_name=c.table_name AND k.constraint_type='PRIMARY KEY' AND list_contains(k.constraint_column_names,c.column_name)),
      false,c.column_default IS NOT NULL,t.table_oid,t.sql
      FROM system.main.duckdb_columns() c ${browse ? 'LEFT JOIN' : 'JOIN'} system.main.duckdb_tables() t ON t.database_name=c.database_name AND t.schema_name=c.schema_name AND t.table_name=c.table_name
      WHERE c.schema_name=${a} AND c.table_name=${b} AND c.database_name=${this.p(3)} AND ${browse ? 'NOT c.internal' : 'NOT t.internal'} ORDER BY c.column_index` }
  }
  supported(column: GridColumn) {
    const t = column.type.toLowerCase()
    if (this.binary(column)) return !column.primaryKey
    if (['postgres', 'mysql', 'mariadb', 'oracle'].includes(this.engine) && /^(real|float|double|binary_float|binary_double)/.test(t)) return false
    if (this.mysql && /^bit/.test(t)) return false
    if (['postgres', 'duckdb', 'mysql', 'mariadb'].includes(this.engine) && /^(json|jsonb)$/.test(t)) return true
    if (this.mysql && /^(tinytext|mediumtext|longtext)$/.test(t)) return true
    // Whitelist built-in scalar types; domains, arrays, objects, spatial values
    // and LOBs need dedicated editors before they can be compared losslessly.
    return /^(?:smallint|integer|int|int2|int4|int8|bigint|tinyint|mediumint|hugeint|uhugeint|utinyint|usmallint|uinteger|ubigint|numeric|decimal|number|real|float|double|double precision|binary_float|binary_double|boolean|bool|bit|uuid|uniqueidentifier|text|varchar|varchar2|nvarchar|nvarchar2|char|nchar|character varying|character|date|datetime|datetime2|smalldatetime|datetimeoffset|timestamp|timestamp_s|timestamp_ms|timestamp_ns|timestamptz|time|timetz)(?:\([\d, ]+\))?(?: unsigned)?(?: with(?:out)? time zone)?$/i.test(t) || (this.mssql && /^(?:timestamp|rowversion)$/.test(t))
  }
  expression(column: GridColumn, editable: boolean | number = false) {
    const name = this.q(column.name), t = column.type.toLowerCase()
    let value: string
    if (this.binary(column)) value = this.engine === 'postgres' ? `encode(${name},'hex')` : `hex(${name})`
    else if (this.engine === 'oracle') {
      value = t === 'date' ? `TO_CHAR(${name},'SYYYY-MM-DD HH24:MI:SS')` : t.startsWith('timestamp') ? `TO_CHAR(${name},'SYYYY-MM-DD HH24:MI:SS.FF9${t.includes('TIME ZONE'.toLowerCase()) ? ' TZR TZD' : ''}')` : `CAST(${name} AS VARCHAR2(4000))`
    } else if (this.engine === 'sqlite') {
      // SQLite's text SUBSTR stops at NUL. Signal it instead of retaining a
      // partial original which could hide a concurrent change after the NUL.
      value = `CASE WHEN ${name} IS NULL THEN NULL ${editable ? `WHEN typeof(${name})='text' AND instr(${name},char(0))>0 THEN 'nul:'` : ''} WHEN typeof(${name})='real' THEN 'real:'||printf('%!.26g',${name}) WHEN typeof(${name})='blob' THEN 'blob:'||hex(${name}) ELSE typeof(${name})||':'||CAST(${name} AS TEXT) END`
    } else if (this.mssql) value = /^(rowversion|timestamp)$/.test(t) ? `CONVERT(varchar(max),${name},2)` : `CONVERT(nvarchar(max),${name},${/^(real|float)$/.test(t) ? '3' : '126'})`
    else value = `CAST(${name} AS ${this.mysql ? 'CHAR CHARACTER SET utf8mb4' : this.engine === 'duckdb' ? 'VARCHAR' : 'TEXT'})`
    // Detect oversize cells instead of silently retaining partial originals.
    const limit = editable && this.engine !== 'oracle' ? typeof editable === 'number' ? editable : GRID_CELL_LIMIT : GRID_PREVIEW_CELL_LIMIT
    return this.mssql ? `SUBSTRING(${value},1,${limit + 1})` : `SUBSTR(${value},1,${limit + (this.engine === 'sqlite' ? 16 : 1)})`
  }
  value(column: GridColumn, index: number) {
    const p = this.p(index)
    if (this.binary(column)) return this.engine === 'postgres' ? `decode(${p},'hex')` : `from_hex(${p})`
    if (this.mssql && /^(timestamp|rowversion)$/i.test(column.type)) return `CONVERT(binary(8),${p},2)`
    if (this.engine === 'postgres' || this.engine === 'duckdb') return `CAST(${p} AS ${column.type})` // type came from the whitelist above
    if (this.engine === 'oracle' && column.type === 'DATE') return `TO_DATE(${p},'SYYYY-MM-DD HH24:MI:SS')`
    if (this.engine === 'oracle' && column.type.startsWith('TIMESTAMP')) return column.type.includes('TIME ZONE') ? `TO_TIMESTAMP_TZ(${p},'SYYYY-MM-DD HH24:MI:SS.FF9 TZR TZD')` : `TO_TIMESTAMP(${p},'SYYYY-MM-DD HH24:MI:SS.FF9')`
    return p
  }
  select(table: GridTable, columns: GridColumn[], where = '', lock = false) {
    const from = `${this.table(table)}${lock && this.mssql ? ' WITH (UPDLOCK,HOLDLOCK)' : ''}`
    const order = where ? '' : ` ORDER BY ${columns.filter(c => c.primaryKey).map(c => this.q(c.name)).join(',')}`
    return `SELECT ${this.mssql ? 'TOP (201) ' : ''}${columns.map(c => this.expression(c, true)).join(',')} FROM ${from}${where ? ` WHERE ${where}` : ''}${order}${this.mssql ? '' : this.engine === 'oracle' ? (lock ? '' : ' FETCH FIRST 201 ROWS ONLY') : ' LIMIT 201'}${lock && (this.mysql || ['postgres', 'oracle'].includes(this.engine)) ? ` FOR UPDATE${this.engine === 'oracle' ? ' NOWAIT' : ''}` : ''}`
  }
}
