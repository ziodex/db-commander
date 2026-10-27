import type { Cell } from '../shared/contracts'
import type { MysqlTransport } from './mysql-transport'
import { SCHEMA_ROW_LIMIT, schemaSnapshot } from './schema'

/** Bind a bounded list of visible names before reading column metadata.
 * Joining INFORMATION_SCHEMA pseudo-tables makes MariaDB repeatedly scan
 * column definitions across the catalog even when the final rows are limited.
 */
export async function mysqlSchema(query:MysqlTransport['query'],database:string) {
  const tables=await query('SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME LIMIT 2001',[database])
  if(!tables.length)return schemaSnapshot([],database,'catalog-connection')
  const columns=await query(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${tables.map(()=>'?').join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 10001`,[database,...tables.map(row=>row[1])])
  const byTable=new Map<string,Cell[][]>()
  for(const [name,...column] of columns) {
    if(!byTable.has(name!))byTable.set(name!,[])
    byTable.get(name!)!.push(column)
  }
  const rows:Cell[][]=[]
  for(const [schema,name,kind] of tables) {
    // Preserve visible objects with no exposed columns, like the former LEFT JOIN.
    for(const column of byTable.get(name!)??[[null,null,null,null]]) {
      rows.push([null,schema,name,kind,...column])
      if(rows.length>SCHEMA_ROW_LIMIT)return schemaSnapshot(rows,database,'catalog-connection')
    }
  }
  return schemaSnapshot(rows,database,'catalog-connection')
}
