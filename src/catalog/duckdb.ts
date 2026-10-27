import { catalog, definition, section, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function duckdbCatalog(query: CatalogQuery): CatalogAdapter {
  return {
    async list() { return catalog(await query(`SELECT * FROM (
      SELECT database_name,schema_name,table_name AS name,'table' AS kind,CAST(table_oid AS VARCHAR) AS identity_name,NULL::VARCHAR AS parent_name,NULL::VARCHAR AS signature_name,NULL::VARCHAR AS constraint_type FROM system.main.duckdb_tables() WHERE NOT internal
      UNION ALL SELECT database_name,schema_name,view_name,'view',CAST(view_oid AS VARCHAR),NULL,NULL,NULL FROM system.main.duckdb_views() WHERE NOT internal
      UNION ALL SELECT database_name,schema_name,index_name,'index',CAST(index_oid AS VARCHAR),table_name,NULL,NULL FROM system.main.duckdb_indexes()
      UNION ALL SELECT database_name,schema_name,sequence_name,'sequence',CAST(sequence_oid AS VARCHAR),NULL,NULL,NULL FROM system.main.duckdb_sequences()
      UNION ALL SELECT database_name,schema_name,function_name,'macro',CAST(function_oid AS VARCHAR),NULL,CAST(parameters AS VARCHAR),NULL FROM system.main.duckdb_functions() WHERE NOT internal AND function_type IN ('macro','table_macro')
      UNION ALL SELECT database_name,schema_name,constraint_name,'constraint',CAST(table_oid AS VARCHAR)||':'||CAST(constraint_index AS VARCHAR),table_name,NULL,LOWER(constraint_type) FROM system.main.duckdb_constraints()
      ) objects ORDER BY CASE WHEN kind IN ('table','view') THEN 0 ELSE 1 END,1,2,4,3,5 LIMIT 2001`), 'Includes this tab’s attached catalogs and temporary objects. DuckDB macros and sequences are supported; stored procedures and triggers are not available.') },
    async detail(o) {
      const sections = [], table = o.parent ?? o.name, params = [o.catalog!,o.schema,table]
      if (['table','view','index','constraint'].includes(o.kind)) {
        sections.push(section('Columns', ['Name','Type','Nullable','Default'], await query('SELECT column_name,data_type,is_nullable,column_default FROM system.main.duckdb_columns() WHERE database_name=? AND schema_name=? AND table_name=? ORDER BY column_index LIMIT 501', params)))
        sections.push(section('Constraints and keys', ['Name','Kind','Columns','Definition','Referenced table','Referenced columns'], await query('SELECT constraint_name,constraint_type,CAST(constraint_column_names AS VARCHAR),constraint_text,referenced_table,CAST(referenced_column_names AS VARCHAR) FROM system.main.duckdb_constraints() WHERE database_name=? AND schema_name=? AND table_name=? ORDER BY constraint_index LIMIT 501', params)))
        sections.push(section('Indexes', ['Name','Unique','Primary','Expressions','Definition'], await query('SELECT index_name,is_unique,is_primary,expressions,sql FROM system.main.duckdb_indexes() WHERE database_name=? AND schema_name=? AND table_name=? ORDER BY index_name LIMIT 501', params)))
      }
      if (o.kind === 'constraint') {
        const [sql, columns, referencedTable, referencedColumns] = (await query(`SELECT constraint_text,to_json(constraint_column_names),referenced_table,to_json(referenced_column_names) FROM system.main.duckdb_constraints() WHERE database_name=? AND schema_name=? AND table_name=? AND CAST(table_oid AS VARCHAR)||':'||CAST(constraint_index AS VARCHAR)=?`, [...params,o.identity]))[0] ?? []
        // DuckDB can omit constraint_text for self-referencing foreign keys.
        if (!sql && o.constraintType === 'foreign key' && columns && referencedTable && referencedColumns) {
          const from: unknown = JSON.parse(columns), to: unknown = JSON.parse(referencedColumns)
          if (Array.isArray(from) && Array.isArray(to) && from.length > 0 && from.length === to.length && [...from, ...to].every(name => typeof name === 'string')) {
            const q = (name: string) => quoteIdentifier(name, 'duckdb')
            return { sections, definition: definition(`FOREIGN KEY (${from.map(q).join(', ')}) REFERENCES ${q(referencedTable)} (${to.map(q).join(', ')})`, 'generated', 'Foreign-key clause reconstructed from DuckDB catalog columns; not a standalone executable statement.') }
          }
        }
        return { sections, definition: definition(sql, 'native', 'Constraint clause supplied by DuckDB; not a standalone executable statement.') }
      }
      if (o.kind === 'macro') {
        const rows = await query('SELECT macro_definition,parameters,function_type,return_type FROM system.main.duckdb_functions() WHERE database_name=? AND schema_name=? AND function_name=? AND CAST(function_oid AS VARCHAR)=? LIMIT 1', [o.catalog!,o.schema,o.name,o.identity])
        sections.push(section('Macro', ['Body','Parameters','Kind','Return type'], rows))
        return { sections, definition: definition(rows[0]?.[0], 'native', 'Macro body supplied by DuckDB; inspect its parameters above. Not a standalone CREATE statement.') }
      }
      const fn = o.kind === 'table' ? 'tables' : o.kind === 'view' ? 'views' : o.kind === 'index' ? 'indexes' : 'sequences'
      const column = o.kind === 'table' ? 'table' : o.kind
      const sql = (await query(`SELECT sql FROM system.main.duckdb_${fn}() WHERE database_name=? AND schema_name=? AND ${column}_name=? AND CAST(${column}_oid AS VARCHAR)=?`, [o.catalog!,o.schema,o.name,o.identity]))[0]?.[0]
      if (o.kind === 'sequence') sections.push(section('Sequence', ['Start','Minimum','Maximum','Increment','Cycle'], await query('SELECT start_value,min_value,max_value,increment_by,cycle FROM system.main.duckdb_sequences() WHERE database_name=? AND schema_name=? AND sequence_name=?', [o.catalog!,o.schema,o.name])))
      return { sections, definition: definition(sql, 'native', 'SQL reconstructed by DuckDB. This is an object definition, not a complete database backup.') }
    }
  }
}
