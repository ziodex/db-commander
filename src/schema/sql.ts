import { quoteIdentifier } from '../shared/sql/common'
import type { ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { supportsCreateSchema, transactionalDdl, type SchemaChange, type SchemaColumnInput } from '../shared/schema-changes'
import { schemaExpression } from './expression'
import { nativeIdentityCompatible, nativeTypeSql } from './native-types'

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
    const generation = c.generation
    if (!c.nativeType && c.scale > c.precision && c.type === 'decimal' && !(mssql && generation?.kind === 'computed')) throw new Error('Decimal scale cannot exceed precision.')
    if ((!c.nullable || c.primaryKey) && c.default.kind === 'null') throw new Error('A required column cannot default to NULL.')
    if (generation && c.default.kind !== 'none') throw new Error('Generated and identity columns cannot also have a default.')
    if (generation?.kind === 'identity') {
      if (engine === 'duckdb') throw new Error('DuckDB does not support identity columns. Use a reviewed sequence default instead.')
      if (c.nativeType ? !nativeIdentityCompatible(c.nativeType, engine) : !['integer', 'bigint'].includes(c.type) && !((mssql || engine === 'oracle') && c.type === 'decimal' && c.scale === 0)) throw new Error('Identity columns require an integer type or an engine-supported zero-scale decimal.')
      if (c.nullable) throw new Error('Identity columns are not nullable.')
      if (['postgres', 'oracle'].includes(engine) ? generation.mode === 'auto' : generation.mode !== 'auto') throw new Error('Choose an identity mode supported by this engine.')
      if (generation.unique && !mysql) throw new Error('An inline identity unique key is supported here only for MySQL/MariaDB.')
      if (engine === 'sqlite' && ((!c.nativeType && c.type !== 'integer') || !c.primaryKey)) throw new Error('SQLite AUTOINCREMENT requires an INTEGER PRIMARY KEY.')
      if (mysql && !c.primaryKey && !generation.unique) throw new Error('MySQL/MariaDB AUTO_INCREMENT must be indexed. Choose the unique key or make it the first primary-key column.')
    }
    if (generation?.kind === 'computed') {
      const generatedPrimary = generation.storage === 'stored' && (engine === 'postgres' || engine === 'mysql' || mssql) || engine === 'oracle' && generation.storage === 'virtual'
      if (c.primaryKey && !generatedPrimary) throw new Error('A generated primary key is not supported for this engine and storage mode.')
      if (['duckdb', 'oracle'].includes(engine) && generation.storage !== 'virtual') throw new Error(`${engine === 'duckdb' ? 'DuckDB' : 'Oracle'} supports virtual generated columns here, not stored columns.`)
      if (engine === 'postgres' && generation.storage === 'virtual') {
        const major = /^PostgreSQL\s+(\d+)/i.exec(session.version)?.[1]
        if (!major || Number(major) < 18) throw new Error('Virtual generated columns require PostgreSQL 18 or later; use stored for this server.')
      }
      if ((engine === 'duckdb' || mssql && generation.storage === 'virtual') && !c.nullable) throw new Error('This generated column has database-inferred nullability. Leave Nullable selected.')
    }
    if (mssql && generation?.kind === 'computed' && c.nativeType) throw new Error('SQL Server infers computed-column types; remove the native type selection.')
    const type = c.nativeType ? nativeTypeSql(c.nativeType, engine, q, session.version) : c.type === 'varchar' ? `${mssql ? 'NVARCHAR' : engine === 'oracle' ? 'VARCHAR2' : 'VARCHAR'}(${c.length}${engine === 'oracle' ? ' CHAR' : ''})`
      : c.type === 'decimal' ? `DECIMAL(${c.precision},${c.scale})`
      : ({ integer: 'INTEGER', bigint: engine === 'oracle' ? 'NUMBER(19)' : 'BIGINT', text: engine === 'oracle' ? 'CLOB' : mssql ? 'NVARCHAR(MAX)' : mysql ? 'LONGTEXT' : 'TEXT', boolean: engine === 'oracle' ? 'NUMBER(1)' : mssql ? 'BIT' : 'BOOLEAN', date: 'DATE', timestamp: mssql ? 'DATETIME2' : mysql ? 'DATETIME' : 'TIMESTAMP' } as Record<string,string>)[c.type]
    if (generation?.kind === 'computed') {
      const expression = schemaExpression(generation.expression, engine)
      if (mssql) return `${q(c.name)} AS (${expression})${generation.storage === 'stored' ? ' PERSISTED' : ''}${!c.nullable || c.primaryKey ? ' NOT NULL' : ''}`
      return `${q(c.name)} ${type} GENERATED ALWAYS AS (${expression}) ${generation.storage === 'stored' ? 'STORED' : 'VIRTUAL'}${!omitNotNull && (!c.nullable || c.primaryKey) ? ' NOT NULL' : ''}`
    }
    if (generation?.kind === 'identity') {
      if (engine === 'sqlite') return `${q(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
      const clause = mysql ? ' AUTO_INCREMENT' : mssql ? ' IDENTITY(1,1)' : ` GENERATED ${generation.mode === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
      return `${q(c.name)} ${type}${clause} NOT NULL${generation.unique ? ' UNIQUE' : ''}`
    }
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
      const identities = change.columns.filter(c => c.generation?.kind === 'identity')
      if (identities.length > 1 && (mysql || mssql || engine === 'oracle' || engine === 'sqlite')) throw new Error('This engine permits only one identity column per table.')
      if (['sqlite', 'duckdb', 'oracle'].includes(engine) && change.columns.every(c => c.generation?.kind === 'computed')) throw new Error('This engine needs at least one ordinary or identity column.')
      if (engine === 'sqlite' && identities.length && pk.length !== 1) throw new Error('SQLite AUTOINCREMENT cannot be combined with a composite primary key.')
      if (mysql && identities.length && !(identities[0].generation?.kind === 'identity' && identities[0].generation.unique) && pk[0] !== identities[0]) throw new Error('The AUTO_INCREMENT column must be first in the primary key or have its own unique key.')
      const inlineSqliteIdentity = engine === 'sqlite' && identities.length > 0
      commands.push(`CREATE TABLE ${qualified(change.name)} (\n  ${[...change.columns.map(c => column(c)), ...(!inlineSqliteIdentity && pk.length ? [`PRIMARY KEY (${pk.map(c => q(c.name)).join(', ')})`] : [])].join(',\n  ')}\n)`); break
    }
    case 'add-column':
      if (change.column.primaryKey) throw new Error('Adding a primary key is not supported by Add column.')
      if (names.includes(change.column.name)) throw new Error('This column already exists.')
      if (engine === 'sqlite' && change.column.default.kind === 'expression') throw new Error('SQLite cannot add a column with an expression default. Use a literal default or review a separate table migration.')
      if (change.column.generation?.kind === 'identity' && engine === 'sqlite') throw new Error('SQLite cannot add an AUTOINCREMENT primary key. Use a reviewed table migration.')
      if (change.column.generation?.kind === 'computed' && (engine === 'duckdb' || engine === 'sqlite' && change.column.generation.storage === 'stored')) throw new Error('This engine cannot add this generated column to an existing table. Review a separate table migration.')
      if (!change.column.generation && !change.column.nullable && ['none','null'].includes(change.column.default.kind)) throw new Error('Adding a required column needs a non-NULL default for existing rows.')
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
    case 'create-index': {
      const descending = change.descending ?? [], include = change.include ?? []
      unique(change.columns); unique(descending); unique(include)
      change.columns.forEach(requireColumn); include.forEach(requireColumn)
      if (descending.some(name => !change.columns.includes(name))) throw new Error('Descending order can only be selected for an index key column.')
      if (descending.length && engine === 'duckdb') throw new Error('DuckDB does not retain descending index order. Use ordinary index keys instead.')
      if (descending.length && mysql) {
        const version = engine === 'mariadb' ? /(\d+)\.(\d+)\.\d+(?=[^0-9]*MariaDB)/i.exec(session.version) : /^(\d+)\.(\d+)/.exec(session.version)
        const major = Number(version?.[1] ?? 0), minor = Number(version?.[2] ?? 0)
        if (engine === 'mysql' ? major < 8 : major < 10 || major === 10 && minor < 8) throw new Error(`Descending index keys require ${engine === 'mysql' ? 'MySQL 8' : 'MariaDB 10.8'} or later; the server version could not establish support.`)
      }
      if (include.some(name => change.columns.includes(name))) throw new Error('Included columns must be distinct from index key columns.')
      if (include.length && !['postgres', 'sqlserver', 'azure-sql'].includes(engine)) throw new Error('Included index columns are not supported by this engine.')
      if (include.length && engine === 'postgres' && Number(/^PostgreSQL\s+(\d+)/i.exec(session.version)?.[1] ?? 0) < 11) throw new Error('Included index columns require PostgreSQL 11 or later.')
      if (change.predicate && !['postgres', 'sqlite', 'sqlserver', 'azure-sql'].includes(engine)) throw new Error('Partial or filtered indexes are not supported here for this engine.')
      if (change.method && engine !== 'postgres') throw new Error('Index methods are only offered for PostgreSQL here.')
      if (change.method && change.method !== 'btree' && change.unique) throw new Error('PostgreSQL unique indexes require the B-tree method.')
      if (change.method === 'gist' && include.length && Number(/^PostgreSQL\s+(\d+)/i.exec(session.version)?.[1] ?? 0) < 12) throw new Error('Included columns in GiST indexes require PostgreSQL 12 or later.')
      if (change.method && !['btree', 'gist'].includes(change.method) && include.length) throw new Error('Included columns require PostgreSQL B-tree or GiST indexes here.')
      if (change.method && change.method !== 'btree' && descending.length) throw new Error('Descending keys require the PostgreSQL B-tree method.')
      const keys = change.columns.map(name => `${q(name)}${descending.includes(name) ? ' DESC' : ''}`).join(', ')
      commands.push(`CREATE ${change.unique ? 'UNIQUE ' : ''}INDEX ${engine === 'sqlite' || engine === 'oracle' ? qualified(change.name) : q(change.name)} ON ${engine === 'sqlite' ? q(target!.name) : full}${change.method ? ` USING ${change.method.toUpperCase()}` : ''} (${keys})${include.length ? ` INCLUDE (${include.map(q).join(', ')})` : ''}${change.predicate ? ` WHERE ${schemaExpression(change.predicate, engine)}` : ''}`); break
    }
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
      ...((change.action === 'create-table' && change.columns.some(c => c.nativeType?.kind === 'named') || change.action === 'add-column' && change.column.nativeType?.kind === 'named') ? ['User-defined types are resolved by the database when the change runs. Review their definitions and permissions separately; their definitions are not locked by this plan.'] : []),
      ...((change.action === 'create-table' && change.columns.some(c => c.default.kind === 'expression') || change.action === 'add-column' && change.column.default.kind === 'expression') ? ['Default expressions are SQL evaluated by the database and can call functions. Review their behavior and side effects before applying.'] : []),
      ...((change.action === 'create-table' && change.columns.some(c => c.generation?.kind === 'computed') || change.action === 'add-column' && change.column.generation?.kind === 'computed') ? ['Generated expressions are evaluated by the database; review dependencies, determinism and function effects. Generated values cannot be edited directly.'] : []),
      ...(change.action === 'add-column' && change.column.generation?.kind === 'identity' ? ['The database assigns identity values to existing rows when the column is added; their assignment order is not guaranteed.'] : []),
      ...(mssql && change.action === 'add-column' && change.column.nullable && !['none', 'null'].includes(change.column.default.kind) ? ['Existing rows remain NULL when adding a nullable column with a default. New rows use the default when no value is supplied.'] : []),
      ...(change.action === 'create-index' && mysql && change.descending?.length ? ['Descending index behavior depends on the table storage engine; confirm that it supports descending key parts.'] : []),
      ...(change.action === 'create-index' && change.predicate ? ['The index predicate is SQL evaluated by the database. Review its scope, dependencies and function effects before applying.'] : []),
      ...(['rename-table','rename-column'].includes(change.action) ? ['Renaming may leave views, routines or application SQL referring to the old name. Review dependencies separately.'] : []),
      ...(['drop-table','drop-column'].includes(change.action) ? ['This removes data. Related objects or data can also be affected according to the engine’s dependency and foreign-key rules.'] : []),
      ...(change.action === 'drop-index' ? ['Dropping an index may remove uniqueness enforcement or affect query performance. Constraint-backed indexes can be rejected by the server.'] : [])] }
}
