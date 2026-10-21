import { createHash } from 'node:crypto'
import type { GridTable } from '../shared/contracts'
import type { ForeignKey } from '../shared/inspection'
import type { GridQuery } from './table-editor'
import { GridSql } from './grid-sql'

/** Ordered, native column mappings; never parse constraint display SQL. */
export async function foreignKeys(d: GridSql, table: GridTable, query: GridQuery): Promise<ForeignKey[]> {
  const a = d.p(1), b = d.p(2), values = [table.schema, table.name]
  let sql: string
  if (d.engine === 'postgres') sql = `SELECT c.oid::text,c.conname,sa.attname,rn.nspname,r.relname,ra.attname FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_class r ON r.oid=c.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid=r.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(src,dst,pos) JOIN pg_catalog.pg_attribute sa ON sa.attrelid=t.oid AND sa.attnum=k.src JOIN pg_catalog.pg_attribute ra ON ra.attrelid=r.oid AND ra.attnum=k.dst WHERE n.nspname=${a} AND t.relname=${b} AND c.contype='f' ORDER BY c.oid,k.pos LIMIT 201`
  else if (d.mysql) sql = `SELECT CONSTRAINT_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=${a} AND TABLE_NAME=${b} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION LIMIT 201`
  else if (d.mssql) sql = `SELECT TOP (201) CAST(f.object_id AS varchar),f.name,c.name,rs.name,r.name,rc.name FROM sys.foreign_keys f JOIN sys.foreign_key_columns k ON k.constraint_object_id=f.object_id JOIN sys.objects o ON o.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id AND c.column_id=k.parent_column_id JOIN sys.objects r ON r.object_id=f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=r.schema_id JOIN sys.columns rc ON rc.object_id=r.object_id AND rc.column_id=k.referenced_column_id WHERE s.name=${a} AND o.name=${b} ORDER BY f.object_id,k.constraint_column_id`
  else if (d.engine === 'oracle') sql = `SELECT c.constraint_name,c.constraint_name,k.column_name,r.owner,r.table_name,rk.column_name FROM all_constraints c JOIN all_cons_columns k ON k.owner=c.owner AND k.constraint_name=c.constraint_name JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name JOIN all_cons_columns rk ON rk.owner=r.owner AND rk.constraint_name=r.constraint_name AND rk.position=k.position WHERE c.owner=${a} AND c.table_name=${b} AND c.constraint_type='R' ORDER BY c.constraint_name,k.position FETCH FIRST 201 ROWS ONLY`
  else if (d.engine === 'sqlite') {
    values.splice(0,2,table.name,table.schema)
    sql = `SELECT id,'Foreign key '||id,"from",?,"table","to" FROM pragma_foreign_key_list(?,?) ORDER BY id,seq LIMIT 201`
    values.unshift(table.schema)
  } else {
    values.push(table.catalog ?? '')
    sql = `SELECT c.constraint_name,c.constraint_name,unnest(c.constraint_column_names),r.unique_constraint_schema,c.referenced_table,unnest(c.referenced_column_names) FROM system.main.duckdb_constraints() c JOIN information_schema.referential_constraints r ON r.constraint_catalog=c.database_name AND r.constraint_schema=c.schema_name AND r.constraint_name=c.constraint_name WHERE c.schema_name=${a} AND c.table_name=${b} AND c.database_name=${d.p(3)} AND c.constraint_type='FOREIGN KEY' ORDER BY c.constraint_index LIMIT 201`
  }
  const { rows } = await query(sql, values)
  if (rows.length > 200) throw new Error('This table exceeds the 200-column foreign-key metadata limit. Use the object inspector or SQL.')
  const groups = new Map<string, Omit<ForeignKey,'id'>>()
  for (const row of rows) {
    const key = row[0]!, existing = groups.get(key) ?? { name: row[1]!, columns: [], target: { schema: row[3]!, name: row[4]!, ...(table.catalog ? { catalog: table.catalog } : {}) }, targetColumns: [] }
    if(existing.target.schema!==row[3]||existing.target.name!==row[4]||existing.columns.includes(row[2]!))throw new Error('The server returned an ambiguous foreign-key mapping. Inspect its definition using SQL.')
    existing.columns.push(row[2]!); existing.targetColumns.push(row[5] ?? '')
    groups.set(key,existing)
  }
  const result: ForeignKey[] = []
  for (const ref of groups.values()) {
    // SQLite REFERENCES parent without a column list means the ordered parent PK.
    if (d.engine === 'sqlite' && ref.targetColumns.every(name => !name)) {
      const keys = (await query('SELECT name FROM pragma_table_info(?,?) WHERE pk>0 ORDER BY pk LIMIT 101',[ref.target.name,ref.target.schema])).rows.map(row => row[0]!)
      if (keys.length !== ref.columns.length) throw new Error('The referenced SQLite primary key is unavailable or mismatched.')
      ref.targetColumns = keys
    }
    if (!ref.target.schema || !ref.target.name || ref.columns.some(c => !c) || ref.targetColumns.some(c => !c)) throw new Error('The server returned an incomplete foreign-key mapping.')
    result.push({ ...ref, id: createHash('sha256').update(JSON.stringify(ref)).digest('hex') })
  }
  return result
}
