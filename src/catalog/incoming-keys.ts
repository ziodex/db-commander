import type { DatabaseEngine, GridTable } from '../shared/contracts'
import { GridSql } from '../driver/grid-sql'
import type { CatalogQuery } from './common'

/** One bounded native metadata read per proposed table drop. Names come from
 * the engines' catalog visibility rules. PostgreSQL hides inaccessible names. */
export async function incomingKeys(query: CatalogQuery, engine: DatabaseEngine, table: GridTable): Promise<GridTable[]> {
  const dialect = new GridSql(engine)
  const schema = dialect.p(1), name = dialect.p(2)
  const values = [table.schema, table.name]
  let sql: string
  if (engine === 'postgres') {
    const visible = "has_schema_privilege(n.oid,'USAGE') AND (has_table_privilege(child.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege(child.oid,'SELECT'))"
    sql = `SELECT DISTINCT NULL,CASE WHEN ${visible} THEN n.nspname END,CASE WHEN ${visible} THEN child.relname END
      FROM pg_catalog.pg_constraint f
      JOIN pg_catalog.pg_class parent ON parent.oid=f.confrelid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=parent.relnamespace
      JOIN pg_catalog.pg_class child ON child.oid=f.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=child.relnamespace
      WHERE f.contype='f' AND pn.nspname=${schema} AND parent.relname=${name} AND child.oid<>parent.oid LIMIT 201`
  } else if (dialect.mysql) {
    sql = `SELECT DISTINCT NULL,TABLE_SCHEMA,TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_SCHEMA=${schema} AND REFERENCED_TABLE_NAME=${name}
      AND (BINARY TABLE_SCHEMA<>BINARY REFERENCED_TABLE_SCHEMA OR BINARY TABLE_NAME<>BINARY REFERENCED_TABLE_NAME) LIMIT 201`
  } else if (dialect.mssql) {
    sql = `SELECT DISTINCT TOP (201) NULL,n.name,child.name FROM sys.foreign_keys f
      JOIN sys.tables parent ON parent.object_id=f.referenced_object_id JOIN sys.schemas pn ON pn.schema_id=parent.schema_id
      JOIN sys.tables child ON child.object_id=f.parent_object_id JOIN sys.schemas n ON n.schema_id=child.schema_id
      WHERE pn.name=${schema} AND parent.name=${name} AND child.object_id<>parent.object_id`
  } else if (engine === 'oracle') {
    sql = `SELECT DISTINCT NULL,CASE WHEN f.owner=p.owner THEN f.owner END,CASE WHEN f.owner=p.owner THEN f.table_name END
      FROM all_constraints f JOIN all_constraints p ON p.owner=f.r_owner AND p.constraint_name=f.r_constraint_name
      WHERE f.constraint_type='R' AND p.owner=${schema} AND p.table_name=${name}
      AND (f.owner<>p.owner OR f.table_name<>p.table_name) FETCH FIRST 201 ROWS ONLY`
  } else if (engine === 'sqlite') {
    // Foreign keys cannot cross attached database boundaries in SQLite.
    values.splice(0, 2, table.schema, table.schema, table.name, table.name)
    sql = `SELECT DISTINCT NULL,?,child.name FROM ${dialect.q(table.schema)}.sqlite_schema child
      JOIN pragma_foreign_key_list(child.name,?) f
      WHERE child.type='table' AND f."table"=? COLLATE NOCASE AND child.name<>? COLLATE NOCASE LIMIT 201`
  } else {
    values.push(table.catalog ?? '')
    sql = `SELECT DISTINCT c.database_name,c.schema_name,c.table_name FROM system.main.duckdb_constraints() c
      JOIN information_schema.referential_constraints r ON r.constraint_catalog=c.database_name AND r.constraint_schema=c.schema_name AND r.constraint_name=c.constraint_name
      WHERE c.constraint_type='FOREIGN KEY' AND r.unique_constraint_schema=${schema}
      AND c.referenced_table=${name} AND r.unique_constraint_catalog=${dialect.p(3)}
      AND (c.database_name<>r.unique_constraint_catalog OR c.schema_name<>r.unique_constraint_schema OR c.table_name<>c.referenced_table) LIMIT 201`
  }
  const rows = await query(sql, values)
  if (rows.length > 200) throw new Error('The table has more than 200 visible foreign-key dependents.')
  return rows.map(([catalog, schema, name]) => {
    if (!schema || !name) throw new Error('A referencing table is outside the visible catalog.')
    return { catalog: catalog ?? undefined, schema, name }
  })
}
