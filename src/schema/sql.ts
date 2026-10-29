import { quoteIdentifier } from '../shared/sql/common'
import type { ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { supportsCreateSchema, transactionalDdl, type SchemaChange, type SchemaColumnInput } from '../shared/schema-changes'
import { schemaExpression } from './expression'

function columnNames(detail?: ObjectDetail): string[] {
  const section = detail?.sections.find(section => section.title === 'Columns'), position = section?.columns.indexOf('Name') ?? -1
  return position < 0 ? [] : section!.rows.map(row => row[position]!).filter(Boolean)
}
export function schemaSql(change: SchemaChange, session: SessionInfo, detail?: ObjectDetail) {
  const engine = session.engine, mssql = ['sqlserver','azure-sql'].includes(engine), mysql = ['mysql','mariadb'].includes(engine)
  const q = (name: string) => {
    const limit = engine === 'postgres' ? 63 : mysql ? 64 : engine === 'oracle' || mssql ? 128 : 255
    const length = engine === 'postgres' || engine === 'oracle' ? Buffer.byteLength(name) : name.length
    if (length > limit) throw new Error(`Identifiers are limited to ${limit} ${engine === 'postgres' || engine === 'oracle' ? 'UTF-8 bytes' : 'characters'} for this engine.`)
    return quoteIdentifier(name, engine)
  }
  const literal = (value: string) => engine === 'postgres' ? `E'${value.replaceAll('\\','\\\\').replaceAll("'","''")}'` : `${mssql || engine === 'oracle' ? 'N' : ''}'${value.replaceAll("'","''")}'`
  const defaultSql = (value: SchemaColumnInput['default']) => {
    if (value.kind === 'none') return ''
    if (value.kind === 'null') return ' DEFAULT NULL'
    if (value.kind === 'number') return ` DEFAULT ${value.value}`
    if (value.kind === 'boolean') return ` DEFAULT ${mssql || engine === 'oracle' ? (value.value ? '1' : '0') : value.value ? 'TRUE' : 'FALSE'}`
    if (value.kind === 'expression') return ` DEFAULT (${schemaExpression(value.value, engine)})`
    // Hex encoding is independent of the server's NO_BACKSLASH_ESCAPES setting.
    return ` DEFAULT ${mysql ? `(CONVERT(X'${Buffer.from(value.value).toString('hex')}' USING utf8mb4))` : literal(value.value)}`
  }
  function column(c: SchemaColumnInput, omitNotNull = false) {
    if (c.scale > c.precision && c.type === 'decimal') throw new Error('Decimal scale cannot exceed precision.')
    if ((!c.nullable || c.primaryKey) && c.default.kind === 'null') throw new Error('A required column cannot default to NULL.')
    const type = c.type === 'varchar' ? `${mssql ? 'NVARCHAR' : engine === 'oracle' ? 'VARCHAR2' : 'VARCHAR'}(${c.length}${engine === 'oracle' ? ' CHAR' : ''})`
      : c.type === 'decimal' ? `DECIMAL(${c.precision},${c.scale})`
      : ({ integer: 'INTEGER', bigint: engine === 'oracle' ? 'NUMBER(19)' : 'BIGINT', text: engine === 'oracle' ? 'CLOB' : mssql ? 'NVARCHAR(MAX)' : mysql ? 'LONGTEXT' : 'TEXT', boolean: engine === 'oracle' ? 'NUMBER(1)' : mssql ? 'BIT' : 'BOOLEAN', date: 'DATE', timestamp: mssql ? 'DATETIME2' : mysql ? 'DATETIME' : 'TIMESTAMP' } as Record<string,string>)[c.type]
    return `${q(c.name)} ${type}${defaultSql(c.default)}${!omitNotNull && (!c.nullable || c.primaryKey) ? ' NOT NULL' : ''}`
  }
  const place = 'target' in change ? change.target : change.location
  if (engine !== 'duckdb' && place.catalog) throw new Error('This engine does not accept a catalog qualifier here.')
  if (mysql && place.schema !== session.database) throw new Error('Select this database in the sidebar before changing its schema.')
  if (engine === 'oracle' && place.schema !== session.user.toUpperCase()) throw new Error('The guided Oracle editor is limited to the connected user’s schema.')
  if (engine === 'sqlite' && place.schema === 'temp' || engine === 'duckdb' && place.catalog === 'temp') throw new Error('Temporary objects are edited through the SQL console.')
  const namespace = [engine === 'duckdb' ? place.catalog : undefined, place.schema].filter((value): value is string => Boolean(value)).map(q).join('.')
  const qualified = (name: string) => `${namespace}.${q(name)}`
  const target = 'target' in change ? change.target : undefined
  if (target && target.kind !== (change.action === 'drop-index' ? 'index' : 'table')) throw new Error('Select a base table for table changes, or an index for Drop index.')
  const full = target ? qualified(target.name) : '', names = columnNames(detail)
  function requireColumn(name: string) { if (!names.includes(name)) throw new Error(`Column ${name} is no longer visible. Refresh and review again.`) }
  function unique(names: string[]) { if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Column names must be distinct, ignoring case.') }
  const commands: string[] = []
  switch (change.action) {
    case 'create-schema':
      if (!supportsCreateSchema(engine)) throw new Error('Namespace creation is not supported here. MySQL/MariaDB schemas are databases, Oracle schemas are users, and SQLite namespaces are attachments. Use explicit SQL or an existing namespace.')
      commands.push(`CREATE SCHEMA ${namespace}`); break
    case 'create-table': {
      unique(change.columns.map(c => c.name))
      const pk = change.columns.filter(c => c.primaryKey)
      commands.push(`CREATE TABLE ${qualified(change.name)} (\n  ${[...change.columns.map(c => column(c)), ...(pk.length ? [`PRIMARY KEY (${pk.map(c => q(c.name)).join(', ')})`] : [])].join(',\n  ')}\n)`); break
    }
    case 'add-column':
      if (change.column.primaryKey) throw new Error('Adding a primary key is not supported by Add column.')
      if (names.includes(change.column.name)) throw new Error('This column already exists.')
      if (engine === 'sqlite' && change.column.default.kind === 'expression') throw new Error('SQLite cannot add a column with an expression default. Use a literal default or review a separate table migration.')
      if (!change.column.nullable && ['none','null'].includes(change.column.default.kind)) throw new Error('Adding a required column needs a non-NULL default for existing rows.')
      commands.push(`ALTER TABLE ${full} ADD ${engine === 'oracle' ? `(${column(change.column)})` : `${mssql ? '' : 'COLUMN '}${column(change.column, engine === 'duckdb')}`}`)
      if (engine === 'duckdb' && !change.column.nullable) commands.push(`ALTER TABLE ${full} ALTER COLUMN ${q(change.column.name)} SET NOT NULL`)
      break
    case 'rename-column':
      requireColumn(change.column)
      q(change.name)
      if (names.includes(change.name)) throw new Error('The destination column already exists.')
      commands.push(mssql ? `EXEC sys.sp_rename @objname=${literal(`${full}.${q(change.column)}`)}, @newname=${literal(change.name)}, @objtype=N'COLUMN'` : `ALTER TABLE ${full} RENAME COLUMN ${q(change.column)} TO ${q(change.name)}`); break
    case 'drop-column': {
      requireColumn(change.column)
      if (mssql) {
        const columns = detail!.sections.find(s => s.title === 'Columns')!, defaultName = columns.rows.find(row => row[columns.columns.indexOf('Name')] === change.column)?.[columns.columns.indexOf('Default constraint')]
        if (defaultName) commands.push(`ALTER TABLE ${full} DROP CONSTRAINT ${q(defaultName)}`)
      }
      commands.push(`ALTER TABLE ${full} DROP COLUMN ${q(change.column)}`); break
    }
    case 'rename-table':
      q(change.name)
      commands.push(mssql ? `EXEC sys.sp_rename @objname=${literal(full)}, @newname=${literal(change.name)}, @objtype=N'OBJECT'` : `ALTER TABLE ${full} RENAME TO ${mysql ? qualified(change.name) : q(change.name)}`); break
    case 'drop-table': commands.push(`DROP TABLE ${full}`); break
    case 'create-index':
      unique(change.columns); change.columns.forEach(requireColumn)
      commands.push(`CREATE ${change.unique ? 'UNIQUE ' : ''}INDEX ${engine === 'sqlite' || engine === 'oracle' ? qualified(change.name) : q(change.name)} ON ${engine === 'sqlite' ? q(target!.name) : full} (${change.columns.map(q).join(', ')})`); break
    case 'drop-index':
      if (!detail?.definition.sql) throw new Error('This index has no standalone definition. Inspect its parent constraint instead.')
      commands.push(mysql || mssql ? `DROP INDEX ${q(target!.name)} ON ${qualified(target!.parent!)}` : `DROP INDEX ${full}`); break
  }
  const transactional = transactionalDdl(engine), begin = mssql ? 'BEGIN TRANSACTION' : engine === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN'
  const sql = [...(transactional ? [begin] : []), ...commands].map(sql => sql + ';').join('\n\n')
  if (sql.length > 1_000_000) throw new Error('The generated SQL exceeds the one-million-character limit. Use fewer or shorter column defaults.')
  return { commands, begin: transactional ? begin : undefined, sql,
    transaction: transactional ? 'transactional' as const : 'implicit-commit' as const, destructive: ['drop-table','drop-column','drop-index'].includes(change.action),
    warnings: [transactional ? 'Starts a new transaction and leaves successful changes uncommitted. Close this dialog, then Commit or Rollback in this tab. Failure or cancellation rolls back this change when the connection remains usable.' : 'DDL commits implicitly and cannot be rolled back. Existing transactions and manual-commit mode must be resolved first. An error or cancellation does not prove that the DDL was undone.',
      'DDL can lock tables and affect dependent objects. Database permissions and dependency rules still apply; no automatic CASCADE or table rebuild is added.',
      ...((change.action === 'create-table' && change.columns.some(c => c.default.kind === 'expression') || change.action === 'add-column' && change.column.default.kind === 'expression') ? ['Default expressions are SQL evaluated by the database and can call functions. Review their behavior and side effects before applying.'] : []),
      ...(mssql && change.action === 'add-column' && change.column.nullable && !['none', 'null'].includes(change.column.default.kind) ? ['Existing rows remain NULL when adding a nullable column with a default. New rows use the default when no value is supplied.'] : []),
      ...(['rename-table','rename-column'].includes(change.action) ? ['Renaming may leave views, routines or application SQL referring to the old name. Review dependencies separately.'] : []),
      ...(['drop-table','drop-column'].includes(change.action) ? ['This removes data. Related objects or data can also be affected according to the engine’s dependency and foreign-key rules.'] : []),
      ...(change.action === 'drop-index' ? ['Dropping an index may remove uniqueness enforcement or affect query performance. Constraint-backed indexes can be rejected by the server.'] : [])] }
}
