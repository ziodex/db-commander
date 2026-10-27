import { catalog, definition, section, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function mysqlCatalog(query: CatalogQuery, database: string): CatalogAdapter {
  const q = (s: string) => quoteIdentifier(s, 'mysql')
  return {
    async list() { return catalog(await query(`SELECT * FROM (
      SELECT NULL AS catalog_name,TABLE_SCHEMA AS schema_name,TABLE_NAME AS object_name,CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' WHEN 'SEQUENCE' THEN 'sequence' ELSE 'table' END AS kind,TABLE_NAME AS identity_name,NULL AS parent_name,NULL AS signature_name,NULL AS constraint_type FROM information_schema.TABLES WHERE TABLE_SCHEMA=?
      UNION ALL SELECT NULL,ROUTINE_SCHEMA,ROUTINE_NAME,LOWER(ROUTINE_TYPE),SPECIFIC_NAME,NULL,NULL,NULL FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?
      UNION ALL SELECT NULL,TRIGGER_SCHEMA,TRIGGER_NAME,'trigger',TRIGGER_NAME,EVENT_OBJECT_TABLE,NULL,NULL FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?
      UNION ALL SELECT NULL,TABLE_SCHEMA,INDEX_NAME,'index',CONCAT(TABLE_NAME,':',INDEX_NAME),TABLE_NAME,NULL,NULL FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? GROUP BY TABLE_SCHEMA,TABLE_NAME,INDEX_NAME
      UNION ALL SELECT NULL,CONSTRAINT_SCHEMA,CONSTRAINT_NAME,'constraint',CONCAT(TABLE_NAME,':',CONSTRAINT_NAME),TABLE_NAME,NULL,LOWER(CONSTRAINT_TYPE) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=?
      ) objects ORDER BY CASE WHEN kind IN ('table','view') THEN 0 ELSE 1 END,schema_name,kind,object_name,identity_name LIMIT 2001`, Array(5).fill(database)), 'Objects visible in the active database, read using a separate connection. MySQL has no standalone sequences; MariaDB sequences appear when available. Temporary objects are not included.') },
    async detail(o) {
      const sections = [], table = o.parent ?? o.name, params = [o.schema,table]
      if (['table','view','index','constraint'].includes(o.kind)) {
        sections.push(section('Columns', ['Name','Type','Nullable','Default','Extra','Comment'], await query('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 501', params)))
        sections.push(section('Indexes', ['Name','Unique','Position','Column','Prefix length','Order','Method'], await query('SELECT INDEX_NAME,1-NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,COLLATION,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 501', params)))
        sections.push(section('Constraints and keys', ['Name','Kind','Position','Column','Referenced schema','Referenced table','Referenced column'], await query(`SELECT t.CONSTRAINT_NAME,t.CONSTRAINT_TYPE,k.ORDINAL_POSITION,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND k.TABLE_NAME=t.TABLE_NAME AND k.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME=? ORDER BY t.CONSTRAINT_NAME,k.ORDINAL_POSITION LIMIT 501`, params)))
        sections.push(section('Triggers', ['Name','Timing','Event','Statement'], await query('SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_NAME LIMIT 501', params)))
      } else if (['function','procedure'].includes(o.kind)) {
        sections.push(section('Parameters', ['Name','Mode','Type','Position'], await query('SELECT PARAMETER_NAME,PARAMETER_MODE,DTD_IDENTIFIER,ORDINAL_POSITION FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=? AND SPECIFIC_NAME=? ORDER BY ORDINAL_POSITION LIMIT 501', [o.schema,o.identity])))
      }
      try {
        const kind = ['index','constraint','sequence'].includes(o.kind) ? 'TABLE' : o.kind.toUpperCase()
        const rows = await query(`SHOW CREATE ${kind} ${q(o.schema)}.${q(['index','constraint'].includes(o.kind) ? table : o.name)}`)
        const sql = rows[0]?.[kind === 'FUNCTION' || kind === 'PROCEDURE' || kind === 'TRIGGER' ? 2 : 1]
        return { sections, definition: definition(sql, 'native', ['index','constraint'].includes(o.kind) ? 'Native parent-table definition, including this index or constraint.' : undefined) }
      } catch (error) { return { sections, definition: definition(null, 'native', `Definition unavailable: ${(error as Error).message}`) } }
    }
  }
}
