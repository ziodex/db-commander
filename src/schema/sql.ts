import { quoteIdentifier } from '../shared/sql/common'
import { objectKey, type ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { supportsCreateSchema, transactionalDdl, type SchemaChange, type SchemaColumnInput, type SchemaColumnType, type TableConstraint } from '../shared/schema-changes'
import { schemaExpression } from './expression'
import { nativeIdentityCompatible, nativeTypeSql } from './native-types'
import { sqlServerCurrentType } from './sqlserver-column'
import { mysqlModifiedColumn } from './mysql-column'
import { sqliteExplicitNotNullCount } from './sqlite-column'

function columnNames(detail?: ObjectDetail): string[] {
  const section = detail?.sections.find(section => section.title === 'Columns'), position = section?.columns.indexOf('Name') ?? -1
  return position < 0 ? [] : section!.rows.map(row => row[position]!).filter(Boolean)
}
export function schemaSql(change: SchemaChange, session: SessionInfo, detail?: ObjectDetail, references: ReadonlyMap<string, ObjectDetail> = new Map()) {
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
  function columnType(c: SchemaColumnType) {
    if (!c.nativeType && c.type === 'decimal' && c.scale > c.precision) throw new Error('Decimal scale cannot exceed precision.')
    return c.nativeType ? nativeTypeSql(c.nativeType, engine, q, session.version) : c.type === 'varchar' ? `${mssql ? 'NVARCHAR' : engine === 'oracle' ? 'VARCHAR2' : 'VARCHAR'}(${c.length}${engine === 'oracle' ? ' CHAR' : ''})`
      : c.type === 'decimal' ? `DECIMAL(${c.precision},${c.scale})`
      : ({ integer: 'INTEGER', bigint: engine === 'oracle' ? 'NUMBER(19)' : 'BIGINT', text: engine === 'oracle' ? 'CLOB' : mssql ? 'NVARCHAR(MAX)' : mysql ? 'LONGTEXT' : 'TEXT', boolean: engine === 'oracle' ? 'NUMBER(1)' : mssql ? 'BIT' : 'BOOLEAN', date: 'DATE', timestamp: mssql ? 'DATETIME2' : mysql ? 'DATETIME' : 'TIMESTAMP' } as Record<string,string>)[c.type]
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
    const type = mssql && generation?.kind === 'computed' ? '' : columnType(c)
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
  function columnMetadata(name: string) {
    const section = detail?.sections.find(section => section.title === 'Columns')
    const position = section?.columns.indexOf('Name') ?? -1, row = section?.rows.find(row => row[position] === name)
    if (!section || position < 0 || !row) throw new Error(`Column ${name} is no longer visible. Refresh and review again.`)
    return { section, row, get(key: string) { const i = section.columns.indexOf(key); if (i < 0) throw new Error('Column metadata is incomplete. Inspect its definition and use explicit SQL.'); return row[i] } }
  }
  function isTrue(value: string | null | undefined) { return value === '1' || value?.toLowerCase() === 'true' || value?.toUpperCase() === 'YES' || value === 'Y' }
  function isFalse(value: string | null | undefined) { return value === '0' || value?.toLowerCase() === 'false' || value?.toUpperCase() === 'NO' || value === 'N' }
  function nullableValue(value: string | null | undefined) {
    if (isTrue(value)) return true
    if (isFalse(value)) return false
    throw new Error('Column nullability metadata is incomplete. Inspect its definition and use explicit SQL.')
  }
  function isTextType(type: SchemaColumnType) { return type.nativeType?.kind === 'named' || type.nativeType?.kind === 'builtin' ? type.nativeType?.kind === 'named' || ['CHAR','VARCHAR','NCHAR','NVARCHAR','TEXT'].includes(type.nativeType.name) : ['varchar','text'].includes(type.type) }
  function renderConstraint(constraint: TableConstraint, localNames: string[], place: { schema: string; catalog?: string }, tableName: string) {
    q(constraint.name)
    if (constraint.kind === 'check') {
      if (mysql) {
        const version = engine === 'mariadb' ? /(\d+)\.(\d+)\.(\d+)(?=[^0-9]*MariaDB)/i.exec(session.version) : /^(\d+)\.(\d+)\.(\d+)/.exec(session.version)
        const actual = [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0), Number(version?.[3] ?? 0)]
        const minimum = engine === 'mysql' ? [8, 0, 16] : [10, 2, 1]
        if (actual[0] < minimum[0] || actual[0] === minimum[0] && (actual[1] < minimum[1] || actual[1] === minimum[1] && actual[2] < minimum[2])) throw new Error('This server version may ignore CHECK constraints; use a version with enforced checks.')
      }
      return `CONSTRAINT ${q(constraint.name)} CHECK (${schemaExpression(constraint.expression, engine)})`
    }
    unique(constraint.columns)
    for (const name of constraint.columns) if (!localNames.includes(name)) throw new Error(`Column ${name} is no longer visible. Refresh and review again.`)
    if (constraint.kind === 'unique') return `CONSTRAINT ${q(constraint.name)} UNIQUE (${constraint.columns.map(q).join(', ')})`
    unique(constraint.referencedColumns)
    if (constraint.columns.length !== constraint.referencedColumns.length) throw new Error('Foreign-key columns and referenced columns must have the same count and matching order.')
    const ref = constraint.reference.kind === 'self' ? undefined : constraint.reference.table
    if (ref && ref.kind !== 'table') throw new Error('A foreign key must reference a visible base table.')
    if (ref && engine !== 'duckdb' && ref.catalog) throw new Error('This engine does not accept a catalog qualifier here.')
    if (ref && mysql && ref.schema !== session.database) throw new Error('The guided foreign-key editor references tables in the current database.')
    if (ref && engine === 'oracle' && ref.schema !== session.user.toUpperCase()) throw new Error('The guided Oracle editor references tables in the connected user’s schema.')
    if (ref && engine === 'sqlite' && ref.schema !== place.schema) throw new Error('SQLite foreign keys cannot reference a different attached database.')
    if (engine === 'duckdb' && (place.catalog !== session.database || ref && ref.catalog !== place.catalog)) throw new Error('DuckDB foreign keys must use tables in the active catalog; switch to that catalog first.')
    const refNames = ref ? columnNames(references.get(objectKey(ref))) : localNames
    if (ref && !references.has(objectKey(ref))) throw new Error('Referenced-table metadata is unavailable. Refresh and review again.')
    for (const name of constraint.referencedColumns) if (!refNames.includes(name)) throw new Error(`Referenced column ${name} is no longer visible. Refresh and review again.`)
    const actions = [constraint.onDelete, constraint.onUpdate]
    if (mysql && actions.includes('set-default')) throw new Error('MySQL/MariaDB storage engines do not support SET DEFAULT foreign-key actions here.')
    if (mssql && actions.includes('restrict')) throw new Error('SQL Server uses NO ACTION instead of RESTRICT.')
    if (engine === 'oracle' && (constraint.onUpdate !== 'no-action' || !['no-action','cascade','set-null'].includes(constraint.onDelete))) throw new Error('Oracle supports NO ACTION, CASCADE or SET NULL for delete and no update action.')
    if (engine === 'duckdb' && actions.some(action => action !== 'no-action')) throw new Error('DuckDB supports only NO ACTION foreign-key rules here.')
    const refName = ref?.name ?? tableName
    const qualifiedRef = engine === 'sqlite' ? q(refName) : engine === 'duckdb' ? `${q(ref?.schema ?? place.schema)}.${q(refName)}` : ref ? [ref.schema, ref.name].map(q).join('.') : qualified(refName)
    const actionSql = (action: typeof constraint.onDelete) => action.toUpperCase().replaceAll('-', ' ')
    const rules = engine === 'oracle' ? (constraint.onDelete === 'no-action' ? '' : ` ON DELETE ${actionSql(constraint.onDelete)}`) : ` ON DELETE ${actionSql(constraint.onDelete)} ON UPDATE ${actionSql(constraint.onUpdate)}`
    return `CONSTRAINT ${q(constraint.name)} FOREIGN KEY (${constraint.columns.map(q).join(', ')}) REFERENCES ${qualifiedRef} (${constraint.referencedColumns.map(q).join(', ')})${rules}`
  }
  function requireConstraint(name: string, kind: 'check' | 'unique' | 'foreign') {
    const section = detail?.sections.find(section => section.title === 'Constraints and keys')
    const namePos = section?.columns.indexOf('Name') ?? -1, kindPos = section?.columns.indexOf('Kind') ?? -1
    const actual = section?.rows.find(row => row[namePos] === name)?.[kindPos]?.toLowerCase()
    const expected = kind === 'check' ? ['c','check','check_constraint'] : kind === 'unique' ? ['u','unique','unique_constraint'] : ['f','r','foreign key','foreign_key_constraint']
    if (namePos < 0 || kindPos < 0 || !actual || !expected.includes(actual)) throw new Error('The selected constraint is no longer visible or its kind changed. Refresh and review again.')
  }
  const commands: string[] = []
  let mysqlRestoreAbsentDefault = false, mariaImplicitNullDefault = false
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
      const constraints = change.constraints ?? []
      if (new Set(constraints.map(c => c.name.toLowerCase())).size !== constraints.length) throw new Error('Constraint names must be distinct, ignoring case.')
      commands.push(`CREATE TABLE ${qualified(change.name)} (\n  ${[...change.columns.map(c => column(c)), ...(!inlineSqliteIdentity && pk.length ? [`PRIMARY KEY (${pk.map(c => q(c.name)).join(', ')})`] : []), ...constraints.map(c => renderConstraint(c, change.columns.map(column => column.name), place, change.name))].join(',\n  ')}\n)`); break
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
    case 'alter-column': {
      const metadata = columnMetadata(change.column), alter = change.alteration, col = q(change.column)
      if (engine === 'sqlite') {
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(session.version), major = Number(version?.[1] ?? 0), minor = Number(version?.[2] ?? 0)
        if (alter.kind !== 'nullability' || major < 3 || major === 3 && minor < 53) throw new Error('SQLite cannot make this column change here. Review a separate table migration.')
        const hidden = metadata.get('Hidden / generated'), notNull = metadata.get('Not null')
        if (hidden !== '0' || !isTrue(notNull) && !isFalse(notNull)) throw new Error('This SQLite column cannot be safely altered from its available metadata.')
        const current = !isTrue(notNull)
        if (current === alter.nullable) throw new Error('The column already has the selected nullability.')
        const count = sqliteExplicitNotNullCount(detail, change.column)
        if (count !== (current ? 0 : 1)) throw new Error('The SQLite column has an implicit or redundant NOT NULL constraint. Inspect it with explicit SQL.')
        commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${alter.nullable ? 'DROP' : 'SET'} NOT NULL`); break
      }
      let identity = false, generated = false
      if (engine === 'postgres') {
        const id = metadata.get('Identity'), gen = metadata.get('Generated')
        if (id == null || gen == null) throw new Error('Identity or generated-column metadata is incomplete. Inspect the column before changing it.')
        identity = Boolean(id); generated = Boolean(gen)
      } else if (engine === 'oracle' || mssql) {
        const id = metadata.get('Identity'), gen = metadata.get(engine === 'oracle' ? 'Virtual' : 'Computed')
        if (!isTrue(id) && !isFalse(id) || !isTrue(gen) && !isFalse(gen)) throw new Error('Identity or generated-column metadata is incomplete. Inspect the column before changing it.')
        identity = isTrue(id); generated = isTrue(gen)
      } else if (mysql) {
        const extra = metadata.get('Extra')
        if (extra == null) throw new Error('Identity or generated-column metadata is incomplete. Inspect the column before changing it.')
        identity = /auto_increment/i.test(extra); generated = /(?:virtual|stored|persistent) generated/i.test(extra)
      }
      if (alter.kind !== 'type' && alter.kind !== 'nullability' && alter.kind !== 'default') {
        if (engine === 'oracle' && alter.kind === 'generated-expression') {
          if (!generated || identity) throw new Error('This column is not an editable virtual column.')
          const editions = detail?.sections.find(section => section.title === 'Virtual column editions'), nameIndex = editions?.columns.indexOf('Column') ?? -1
          const editionColumns = ['Evaluation edition','Unusable before','Unusable beginning'].map(name => editions?.columns.indexOf(name) ?? -1)
          const rows = editions?.rows.filter(row => row[nameIndex] === change.column) ?? []
          if (!editions || editions.truncated || nameIndex < 0 || editionColumns.some(index => index < 0) || rows.length !== 1 || editionColumns.some(index => rows[0][index] === undefined)) throw new Error('Oracle virtual-column edition metadata is incomplete. Inspect it with explicit SQL.')
          if (editionColumns.some(index => rows[0][index] !== null && rows[0][index] !== '')) throw new Error('Edition-dependent Oracle virtual columns require separately reviewed SQL.')
          const type = metadata.get('Type'), precision = metadata.get('Precision'), scale = metadata.get('Scale'), length = metadata.get('Length')
          let retainedType: string
          if (type === 'NUMBER') {
            if (precision === undefined || scale === undefined) throw new Error('Oracle numeric type metadata is incomplete. Inspect the virtual column with explicit SQL.')
            if (precision == null && scale == null) retainedType = 'NUMBER'
            else {
              if (precision !== null && precision !== undefined && (!/^\d+$/.test(precision) || Number(precision) < 1 || Number(precision) > 38) || scale == null || !/^-?\d+$/.test(scale) || Number(scale) < -84 || Number(scale) > 127) throw new Error('Oracle numeric type metadata is incomplete. Inspect the virtual column with explicit SQL.')
              retainedType = `NUMBER(${precision ?? '*'},${scale})`
            }
          } else if (type && ['DATE','BINARY_FLOAT','BINARY_DOUBLE'].includes(type)) retainedType = type
          else if (type === 'RAW' && length && /^\d+$/.test(length) && Number(length) >= 1 && Number(length) <= 32767) retainedType = `RAW(${length})`
          else if (type && /^TIMESTAMP\([0-9]\)(?: WITH (?:LOCAL )?TIME ZONE)?$/.test(type)) retainedType = type
          else if (type && ['CHAR','VARCHAR2','NCHAR','NVARCHAR2'].includes(type)) {
            const semantics = metadata.get('Char semantics'), charLength = metadata.get('Char length'), collation = metadata.get('Collation')
            const isNational = type === 'NCHAR' || type === 'NVARCHAR2', size = isNational || semantics === 'C' ? charLength : length
            if (!['B','C'].includes(semantics ?? '') || !size || !/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 32767 || !collation) throw new Error('Oracle character type or collation metadata is incomplete. Inspect the virtual column with explicit SQL.')
            const tableCollationIndex = editions.columns.indexOf('Table default collation'), tableCollation = rows[0][tableCollationIndex]
            if (tableCollationIndex < 0 || !tableCollation) throw new Error('Oracle table collation metadata is incomplete. Inspect the virtual column with explicit SQL.')
            if (collation !== 'USING_NLS_COMP' || tableCollation !== collation) throw new Error('A nondefault Oracle column or table collation requires separately reviewed SQL for this virtual expression change.')
            retainedType = `${type}(${size}${isNational ? '' : semantics === 'C' ? ' CHAR' : ' BYTE'})`
          }
          else throw new Error('The virtual column type cannot be safely retained here. Inspect and change it with explicit SQL.')
          commands.push(`ALTER TABLE ${full} MODIFY (${col} ${retainedType} GENERATED ALWAYS AS (${schemaExpression(alter.expression, engine)}))`)
          break
        }
        if (mysql && (alter.kind === 'identity-add' || alter.kind === 'identity-drop')) {
          if (generated) throw new Error('A generated column cannot also be AUTO_INCREMENT.')
          if (alter.kind === 'identity-add' && alter.mode !== 'auto') throw new Error('Choose the AUTO_INCREMENT identity mode for this engine.')
          if (identity === (alter.kind === 'identity-add')) throw new Error(identity ? 'This column is already AUTO_INCREMENT.' : 'This column is not AUTO_INCREMENT.')
          const oldType = metadata.get('Type'), nullable = nullableValue(metadata.get('Nullable'))
          if (!oldType || !/^(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\(\d+\))?(?: unsigned)?(?: zerofill)?$/i.test(oldType)) throw new Error('AUTO_INCREMENT needs a supported native integer column. Inspect its type with explicit SQL.')
          const retained = mysqlModifiedColumn(detail, change.column, oldType, { kind: 'identity', enabled: alter.kind === 'identity-add' }, nullable)
          commands.push(`ALTER TABLE ${full} MODIFY COLUMN ${retained.sql}`)
          break
        }
        if (mysql && alter.kind === 'generated-expression') {
          const extra = metadata.get('Extra'), oldType = metadata.get('Type'), current = nullableValue(metadata.get('Nullable'))
          const match = /\b(virtual|stored|persistent) generated\b/i.exec(extra ?? '')
          if (!generated || !match || !oldType) throw new Error('Generated column metadata is incomplete. Inspect the column before changing it.')
          const retained = mysqlModifiedColumn(detail, change.column, oldType, { kind: 'expression', sql: schemaExpression(alter.expression, engine), storage: match[1].toLowerCase() === 'virtual' ? 'virtual' : 'stored' }, current)
          commands.push(`ALTER TABLE ${full} MODIFY COLUMN ${retained.sql}`)
          break
        }
        if (engine === 'oracle' && (alter.kind === 'identity-mode' || alter.kind === 'identity-drop')) {
          if (!identity || generated) throw new Error('This column is not an editable identity column.')
          const info = detail?.sections.find(section => section.title === 'Identity columns')
          const nameIndex = info?.columns.indexOf('Column') ?? -1, modeIndex = info?.columns.indexOf('Generation') ?? -1
          const rows = info?.rows.filter(row => row[nameIndex] === change.column) ?? []
          const mode = rows[0]?.[modeIndex]
          if (!info || info.truncated || nameIndex < 0 || modeIndex < 0 || rows.length !== 1 || !['ALWAYS','BY DEFAULT','BY DEFAULT ON NULL'].includes(mode ?? '')) throw new Error('Oracle identity metadata is incomplete. Inspect the column before changing it.')
          if (alter.kind === 'identity-mode') {
            const onNull = metadata.get('Default on null')
            if (!isTrue(onNull) && !isFalse(onNull)) throw new Error('Oracle DEFAULT ON NULL metadata is unavailable. Inspect the column before changing it.')
            if (mode === 'ALWAYS' && isTrue(onNull)) throw new Error('Oracle identity mode metadata is inconsistent. Inspect the column before changing it.')
            const requested = alter.mode === 'always' ? 'ALWAYS' : 'BY DEFAULT'
            if (mode === requested && !isTrue(onNull)) throw new Error('The column already has this identity mode.')
            commands.push(`ALTER TABLE ${full} MODIFY (${col} GENERATED ${requested} AS IDENTITY)`)
          } else commands.push(`ALTER TABLE ${full} MODIFY (${col} DROP IDENTITY)`)
          break
        }
        if (engine !== 'postgres') throw new Error('This generation change requires a separately reviewed migration for this engine.')
        const id = metadata.get('Identity'), gen = metadata.get('Generated')
        if (!['', 'a', 'd'].includes(id ?? '?') || !['', 's', 'v'].includes(gen ?? '?')) throw new Error('Generation metadata is incomplete or unsupported. Inspect the column before changing it.')
        if (alter.kind === 'identity-add') {
          if (alter.mode === 'auto') throw new Error('Choose an identity mode supported by PostgreSQL.')
          if (identity || generated) throw new Error('This column is already an identity or generated column.')
          const currentDefault = metadata.get('Default / expression')
          if (currentDefault === undefined) throw new Error('Column default metadata is incomplete. Inspect its definition and use explicit SQL.')
          if (currentDefault) throw new Error('An identity column needs no existing default; review its removal separately.')
          if (nullableValue(metadata.get('Nullable'))) throw new Error('An identity column must be NOT NULL; review that change separately.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ADD GENERATED ${alter.mode === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
        } else if (alter.kind === 'identity-mode') {
          if (!identity) throw new Error('This column is not an identity column.')
          if (id === (alter.mode === 'always' ? 'a' : 'd')) throw new Error('The column already has this identity mode.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} SET GENERATED ${alter.mode === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`)
        } else if (alter.kind === 'identity-drop') {
          if (!identity) throw new Error('This column is not an identity column.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} DROP IDENTITY`)
        } else if (alter.kind === 'generated-expression') {
          const major = Number(/^PostgreSQL\s+(\d+)/i.exec(session.version)?.[1] ?? 0)
          if (!generated) throw new Error('This column is not generated.')
          if (major < 17) throw new Error('Changing a generated expression requires PostgreSQL 17 or later.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} SET EXPRESSION AS (${schemaExpression(alter.expression, engine)})`)
        } else if (alter.kind === 'generated-drop') {
          if (gen !== 's') throw new Error('Only a stored generated column can drop its expression here.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} DROP EXPRESSION`)
        }
        break
      }
      if (generated) throw new Error('Generated columns need a separately reviewed expression change; this editor will not replace their definition.')
      if (alter.kind === 'default') {
        if (identity) throw new Error('Identity columns cannot have their defaults changed here.')
        if (alter.default.kind === 'null' && !nullableValue(metadata.get('Nullable'))) throw new Error('A required column cannot default to NULL.')
        if (engine === 'oracle') {
          const onNullValue = metadata.get('Default on null')
          if (!isTrue(onNullValue) && !isFalse(onNullValue)) throw new Error('Oracle DEFAULT ON NULL metadata is unavailable. Inspect the column and use explicit SQL.')
          const onNull = isTrue(onNullValue)
          if (onNull && ['none','null'].includes(alter.default.kind)) throw new Error('Removing DEFAULT ON NULL needs a separately reviewed alteration to preserve its nullability semantics.')
          const clause = alter.default.kind === 'none' ? ' DEFAULT NULL' : defaultSql(alter.default)
          commands.push(`ALTER TABLE ${full} MODIFY (${col}${onNull ? clause.replace(' DEFAULT ', ' DEFAULT ON NULL ') : clause})`)
        } else if (mssql) {
          const defaultId = metadata.get('Default object ID'), defaultName = metadata.get('Default constraint')
          if (defaultId == null || !/^\d+$/.test(defaultId) || defaultId === '0' && defaultName) throw new Error('Default-constraint metadata is incomplete. Inspect the table before changing it.')
          if (defaultId !== '0' && !defaultName) throw new Error('This column uses a bound or unavailable default. Inspect and change it with explicit SQL.')
          if (defaultName) commands.push(`ALTER TABLE ${full} DROP CONSTRAINT ${q(defaultName)}`)
          if (alter.default.kind !== 'none') commands.push(`ALTER TABLE ${full} ADD${defaultName ? ` CONSTRAINT ${q(defaultName)}` : ''}${defaultSql(alter.default)} FOR ${col}`)
          if (!commands.length) throw new Error('This column has no default constraint to remove.')
        } else commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${alter.default.kind === 'none' ? 'DROP DEFAULT' : `SET${defaultSql(alter.default)}`}`)
      } else if (alter.kind === 'nullability') {
        const current = nullableValue(metadata.get('Nullable'))
        if (current === alter.nullable) throw new Error('The column already has the selected nullability.')
        if (engine === 'oracle') commands.push(`ALTER TABLE ${full} MODIFY (${col} ${alter.nullable ? 'NULL' : 'NOT NULL'})`)
        else if (mssql) {
          const type = sqlServerCurrentType(metadata.section, metadata.row, q)
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${type.sql}${type.collation ? ` COLLATE ${type.collation}` : ''} ${alter.nullable ? 'NULL' : 'NOT NULL'}`)
        } else if (mysql) {
          const oldType = metadata.get('Type'); if (!oldType) throw new Error('Column type metadata is incomplete.')
          const retained = mysqlModifiedColumn(detail, change.column, oldType, { kind: 'nullability', nullable: alter.nullable }, current)
          commands.push(`ALTER TABLE ${full} MODIFY COLUMN ${retained.sql}`)
          if (alter.nullable && !retained.hadDefault && !identity) { if (engine === 'mysql') { commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} DROP DEFAULT`); mysqlRestoreAbsentDefault = true } else mariaImplicitNullDefault = true }
        }
        else commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${alter.nullable ? 'DROP' : 'SET'} NOT NULL`)
      } else {
        if (alter.using && !['postgres','duckdb'].includes(engine)) throw new Error('A USING conversion expression is not supported by this engine in the guided editor.')
        const type = columnType(alter.type)
        if (engine === 'oracle') commands.push(`ALTER TABLE ${full} MODIFY (${col} ${type})`)
        else if (mssql) {
          const current = sqlServerCurrentType(metadata.section, metadata.row, q), nullable = nullableValue(metadata.get('Nullable'))
          const collation = current.collation && isTextType(alter.type) && alter.type.nativeType?.kind !== 'named' ? ` COLLATE ${current.collation}` : ''
          if (current.collation && alter.type.nativeType?.kind === 'named') throw new Error('Changing a collated column to a user-defined type requires separately reviewed SQL.')
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${type}${collation} ${nullable ? 'NULL' : 'NOT NULL'}`)
        } else if (mysql) {
          const oldType = metadata.get('Type'); if (!oldType) throw new Error('Column type metadata is incomplete.')
          const current = nullableValue(metadata.get('Nullable')), retained = mysqlModifiedColumn(detail, change.column, oldType, { kind: 'type', sql: type }, current)
          commands.push(`ALTER TABLE ${full} MODIFY COLUMN ${retained.sql}`)
          if (current && !retained.hadDefault && !identity) { if (engine === 'mysql') { commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} DROP DEFAULT`); mysqlRestoreAbsentDefault = true } else mariaImplicitNullDefault = true }
        }
        else {
          const schema = engine === 'postgres' ? metadata.get('Collation schema') : null, collation = engine === 'postgres' ? metadata.get('Collation') : null
          if (Boolean(schema) !== Boolean(collation)) throw new Error('Column collation metadata is incomplete. Inspect its definition and use explicit SQL.')
          const keepCollation = schema && collation && isTextType(alter.type) ? ` COLLATE ${q(schema)}.${q(collation)}` : ''
          commands.push(`ALTER TABLE ${full} ALTER COLUMN ${col} ${engine === 'duckdb' ? 'SET DATA TYPE' : 'TYPE'} ${type}${keepCollation}${alter.using ? ` USING ${schemaExpression(alter.using, engine)}` : ''}`)
        }
      }
      break
    }
    case 'add-constraint':
      if (engine === 'sqlite' || engine === 'duckdb') throw new Error('This engine cannot add a table constraint with ALTER TABLE. Review a separate table migration.')
      commands.push(`ALTER TABLE ${full} ADD ${renderConstraint(change.constraint, names, place, target!.name)}`); break
    case 'drop-constraint':
    case 'replace-constraint': {
      if (engine === 'sqlite' || engine === 'duckdb') throw new Error('This engine cannot alter table constraints with ALTER TABLE. Review a separate table migration.')
      requireConstraint(change.name, change.kind)
      const drop = `DROP ${mysql ? change.kind === 'foreign' ? 'FOREIGN KEY' : change.kind === 'unique' ? 'INDEX' : engine === 'mysql' ? 'CHECK' : 'CONSTRAINT' : 'CONSTRAINT'} ${q(change.name)}`
      if (change.action === 'drop-constraint') commands.push(`ALTER TABLE ${full} ${drop}`)
      else {
        const add = `ADD ${renderConstraint(change.constraint, names, place, target!.name)}`
        if (mysql) commands.push(`ALTER TABLE ${full} ${drop}, ${add}`)
        else commands.push(`ALTER TABLE ${full} ${drop}`, `ALTER TABLE ${full} ${add}`)
      }
      break
    }
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
      const descending = change.descending ?? [], include = change.include ?? [], prefixes = change.prefixes ?? [], expressions = change.expressions ?? []
      unique(change.columns); unique(descending); unique(include); unique(prefixes.map(prefix => prefix.column))
      if (change.columns.length + expressions.length < 1 || change.columns.length + expressions.length > 16) throw new Error('Select between one and sixteen index keys.')
      change.columns.forEach(requireColumn); include.forEach(requireColumn)
      if (expressions.some(key => key.after !== null && !change.columns.includes(key.after))) throw new Error('Each expression position must refer to a selected key column.')
      if (expressions.length && !['postgres','sqlite','duckdb','mysql','oracle'].includes(engine)) throw new Error('Expression index keys are not supported by this engine in the guided editor.')
      if (expressions.length && engine === 'mysql') {
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(session.version), major = Number(version?.[1] ?? 0), minor = Number(version?.[2] ?? 0), patch = Number(version?.[3] ?? 0)
        if (major < 8 || major === 8 && minor === 0 && patch < 13) throw new Error('Expression index keys require MySQL 8.0.13 or later; the server version could not establish support.')
      }
      if (expressions.length && engine === 'sqlite') {
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(session.version), major = Number(version?.[1] ?? 0), minor = Number(version?.[2] ?? 0)
        if (major < 3 || major === 3 && minor < 9) throw new Error('Expression index keys require SQLite 3.9 or later; the server version could not establish support.')
      }
      if (prefixes.length && !mysql) throw new Error('Index key prefixes are supported here only by MySQL and MariaDB.')
      if (prefixes.some(prefix => !change.columns.includes(prefix.column) || !Number.isInteger(prefix.length) || prefix.length < 1 || prefix.length > 65535)) throw new Error('Each index prefix must belong to a selected key and have a length from 1 to 65535.')
      if (descending.some(name => !change.columns.includes(name))) throw new Error('Descending order can only be selected for an index key column.')
      if ((descending.length || expressions.some(key => key.descending)) && engine === 'duckdb') throw new Error('DuckDB does not retain descending index order. Use ordinary index keys instead.')
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
      if (change.method && change.method !== 'btree' && (descending.length || expressions.some(key => key.descending))) throw new Error('Descending keys require the PostgreSQL B-tree method.')
      const prefixLengths = new Map(prefixes.map(prefix => [prefix.column, prefix.length]))
      const expressionKeys = (after: string | null) => expressions.filter(key => key.after === after).map(key => `(${schemaExpression(key.expression, engine)})${key.descending ? ' DESC' : ''}`)
      const keys = [...expressionKeys(null), ...change.columns.flatMap(name => [`${q(name)}${prefixLengths.has(name) ? `(${prefixLengths.get(name)})` : ''}${descending.includes(name) ? ' DESC' : ''}`, ...expressionKeys(name)])].join(', ')
      commands.push(`CREATE ${change.unique ? 'UNIQUE ' : ''}INDEX ${engine === 'sqlite' || engine === 'oracle' ? qualified(change.name) : q(change.name)} ON ${engine === 'sqlite' ? q(target!.name) : full}${change.method ? ` USING ${change.method.toUpperCase()}` : ''} (${keys})${include.length ? ` INCLUDE (${include.map(q).join(', ')})` : ''}${change.predicate ? ` WHERE ${schemaExpression(change.predicate, engine)}` : ''}`); break
    }
    case 'drop-index':
      if (!detail?.definition.sql) throw new Error('This index has no standalone definition. Inspect its parent constraint instead.')
      commands.push(mysql || mssql ? `DROP INDEX ${q(target!.name)} ON ${qualified(target!.parent!)}` : `DROP INDEX ${full}`); break
  }
  const transactional = transactionalDdl(engine), begin = mssql ? 'BEGIN TRANSACTION' : engine === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN'
  const sql = [...(transactional ? [begin] : []), ...commands].map(sql => sql + ';').join('\n\n')
  if (sql.length > 1_000_000) throw new Error('The generated SQL exceeds the one-million-character limit. Use fewer or shorter column defaults.')
  const constraints = change.action === 'create-table' ? change.constraints ?? [] : change.action === 'add-constraint' || change.action === 'replace-constraint' ? [change.constraint] : []
  const cascading = constraints.some(c => c.kind === 'foreign' && [c.onDelete, c.onUpdate].some(action => ['cascade','set-null','set-default'].includes(action)))
  return { commands, begin: transactional ? begin : undefined, sql,
    transaction: transactional ? 'transactional' as const : 'implicit-commit' as const, destructive: cascading || change.action === 'alter-column' && change.alteration.kind !== 'default' || ['drop-table','drop-column','drop-index','drop-constraint','replace-constraint'].includes(change.action),
    warnings: [transactional ? 'Starts a new transaction and leaves successful changes uncommitted. Close this dialog, then Commit or Rollback in this tab. Failure or cancellation rolls back this change when the connection remains usable.' : 'DDL commits implicitly and cannot be rolled back. Existing transactions and manual-commit mode must be resolved first. An error or cancellation does not prove that the DDL was undone.',
      'DDL can lock tables and affect dependent objects. Database permissions and dependency rules still apply; no automatic CASCADE or table rebuild is added.',
      ...((change.action === 'create-table' && change.columns.some(c => c.nativeType?.kind === 'named') || change.action === 'add-column' && change.column.nativeType?.kind === 'named') ? ['User-defined types are resolved by the database when the change runs. Review their definitions and permissions separately; their definitions are not locked by this plan.'] : []),
      ...((change.action === 'create-table' && change.columns.some(c => c.default.kind === 'expression') || change.action === 'add-column' && change.column.default.kind === 'expression' || change.action === 'alter-column' && change.alteration.kind === 'default' && change.alteration.default.kind === 'expression') ? ['Default expressions are SQL evaluated by the database and can call functions. Review their behavior and side effects before applying.'] : []),
      ...((change.action === 'create-table' && change.columns.some(c => c.generation?.kind === 'computed') || change.action === 'add-column' && change.column.generation?.kind === 'computed') ? ['Generated expressions are evaluated by the database; review dependencies, determinism and function effects. Generated values cannot be edited directly.'] : []),
      ...(change.action === 'add-column' && change.column.generation?.kind === 'identity' ? ['The database assigns identity values to existing rows when the column is added; their assignment order is not guaranteed.'] : []),
      ...(mssql && change.action === 'add-column' && change.column.nullable && !['none', 'null'].includes(change.column.default.kind) ? ['Existing rows remain NULL when adding a nullable column with a default. New rows use the default when no value is supplied.'] : []),
      ...(mysqlRestoreAbsentDefault ? ['MySQL requires a second implicitly committed statement to restore the absence of a default. If it fails or is interrupted after the first statement, DEFAULT NULL may remain; inspect the column before retrying.'] : []),
      ...(mariaImplicitNullDefault ? ['MariaDB represents a nullable column without a prior default as DEFAULT NULL after modification; the default metadata will change.'] : []),
      ...(change.action === 'alter-column' && mysql && change.alteration.kind !== 'default' ? [change.alteration.kind === 'type' ? 'The complete existing native column definition is carried forward. A new type replaces its type-specific attributes; review character set, collation and defaults in the SQL.' : 'The complete existing native column definition is carried forward. Review its attributes in the SQL.'] : []),
      ...(change.action === 'alter-column' && mysql && change.alteration.kind === 'type' ? ['MySQL/MariaDB may truncate values in non-strict SQL mode and may automatically shorten affected index prefixes. Review session mode and indexes.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'type' ? ['Type conversion can rewrite data, lose precision or change collation where the new type does not support it. Review conversions and dependencies before applying.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'type' && mssql ? ['SQL Server can reject a type change when a default constraint or other object depends on the column. Dependencies are not removed automatically.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'identity-add' ? [mysql ? 'Adding AUTO_INCREMENT can change existing zero values, depending on SQL mode. The column needs a suitable index; review existing data, SQL mode, keys and future generated values.' : 'The new identity sequence starts independently of existing values. Review its starting value and uniqueness before inserting; existing rows are not changed.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'identity-drop' ? [engine === 'oracle' ? 'Dropping identity removes its sequence and identity-imposed NOT NULL and NOT DEFERRABLE constraints. Existing values remain; inspect safeguards before future inserts.' : mysql ? 'Removing AUTO_INCREMENT stops automatic numbering and can affect future inserts and the table counter. Existing values are retained.' : 'Dropping identity removes its sequence. Existing values remain, but future inserts must supply values or use a separately reviewed default.'] : []),
      ...(change.action === 'alter-column' && mysql && (change.alteration.kind === 'identity-add' || change.alteration.kind === 'identity-drop') ? ['A foreign-key dependency can prevent this change. No constraints are removed automatically.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'identity-mode' ? [engine === 'oracle' ? 'Changing identity mode alters handling of explicit values and can remove BY DEFAULT ON NULL behavior. Existing rows are not changed.' : 'Changing identity mode changes whether future inserts may provide explicit values. Existing rows are not changed.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'generated-expression' ? [mysql ? 'The new SQL expression is evaluated by the database. Stored values and dependent indexes may be rebuilt; virtual values can fail on later reads if out of range. Review SQL mode, dependencies and function effects.' : engine === 'oracle' ? 'The new virtual expression is evaluated by the database. Review its type, dependencies, indexes and function effects.' : 'The new SQL expression is evaluated by the database; stored values are rewritten and statistics are removed. Review dependencies and function effects.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'generated-drop' ? ['Existing stored values remain, but future changes will no longer recompute this column.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'type' && engine === 'duckdb' ? ['DuckDB can reject a conversion because of previously deleted or updated values. No automatic cleanup or retry is performed.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'type' && change.alteration.using ? ['The conversion expression is SQL evaluated by the database; review functions and side effects.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'nullability' && engine === 'sqlite' ? ['SQLite validates the existing table definition and data. Implicit or redundant NOT NULL constraints require separate review.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'nullability' && !change.alteration.nullable && mysql ? ['In non-strict SQL mode, existing NULL values may be converted to implicit defaults. Review the data and session mode before applying.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'nullability' && change.alteration.nullable ? ['Allowing NULL removes an existing data safeguard.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'default' && engine === 'mysql' && change.alteration.default.kind === 'none' ? ['MySQL strict mode can reject inserts that omit a column after its default is dropped, even when it is nullable.'] : []),
      ...(change.action === 'alter-column' && change.alteration.kind === 'default' && engine === 'oracle' && change.alteration.default.kind === 'none' ? ['Oracle represents removal of a default as DEFAULT NULL.'] : []),
      ...(constraints.length ? ['The database checks constraints against data and may lock the table. Review referenced columns, permissions and engine enforcement settings.'] : []),
      ...(constraints.some(c => c.kind === 'check') ? ['Check expressions are SQL evaluated by the database; review functions and dependencies.'] : []),
      ...(constraints.some(c => c.kind === 'foreign') && engine === 'sqlite' ? ['SQLite foreign-key enforcement depends on PRAGMA foreign_keys for each connection.'] : []),
      ...(cascading ? ['The selected foreign-key actions can automatically modify or delete related rows in future operations.'] : []),
      ...(['drop-constraint','replace-constraint'].includes(change.action) ? ['Removing a constraint removes a database safeguard and may remove its supporting index.'] : []),
      ...(change.action === 'replace-constraint' && engine === 'oracle' ? ['Oracle commits each DDL statement. If the replacement fails after the drop, the old constraint is gone; inspect and repair it explicitly.'] : []),
      ...(change.action === 'create-index' && mysql && change.descending?.length ? ['Descending index behavior depends on the table storage engine; confirm that it supports descending key parts.'] : []),
      ...(change.action === 'create-index' && change.prefixes?.length ? ['Prefix lengths use characters for nonbinary text and bytes for binary data; limits depend on character set and storage engine. In a unique index, prefix keys compare only the specified prefixes alongside any other keys.'] : []),
      ...(change.action === 'create-index' && change.expressions?.length ? ['Index expressions are evaluated by the database during index creation and later writes. Review functions, determinism, dependencies and their effects; function definitions are not locked by this plan.'] : []),
      ...(change.action === 'create-index' && engine === 'mysql' && change.expressions?.length ? ['MySQL implements functional keys using hidden generated columns; engine and expression restrictions apply.'] : []),
      ...(change.action === 'create-index' && change.predicate ? ['The index predicate is SQL evaluated by the database. Review its scope, dependencies and function effects before applying.'] : []),
      ...(['rename-table','rename-column'].includes(change.action) ? ['Renaming may leave views, routines or application SQL referring to the old name. Review dependencies separately.'] : []),
      ...(['drop-table','drop-column'].includes(change.action) ? ['This removes data. Related objects or data can also be affected according to the engine’s dependency and foreign-key rules.'] : []),
      ...(change.action === 'drop-index' ? ['Dropping an index may remove uniqueness enforcement or affect query performance. Constraint-backed indexes can be rejected by the server.'] : [])] }
}
