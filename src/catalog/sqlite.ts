import type { Cell } from '../shared/contracts'
import { catalog, definition, section, LIMIT, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function sqliteCatalog(query: CatalogQuery): CatalogAdapter {
  const q = (s: string) => quoteIdentifier(s, 'sqlite')
  return {
    async list() {
      const databases = await query('PRAGMA database_list')
      let rows: Cell[][] = []
      const rank = (row: Cell[]) => ['table','view'].includes(row[3] ?? '') ? 0 : 1
      for (const [,schema] of databases) {
        const objects = await query(`SELECT * FROM (
          SELECT NULL AS catalog_name,? AS schema_name,name,type AS kind,CAST(rowid AS TEXT) AS identity_name,CASE WHEN type IN ('index','trigger') THEN tbl_name END AS parent_name,NULL AS signature_name,NULL AS constraint_type FROM ${q(schema!)}.sqlite_schema WHERE type IN ('table','view','index','trigger') AND (substr(name,1,7)<>'sqlite_' OR type='index')
          UNION ALL SELECT NULL,?,'Foreign key '||f.id,'constraint','fk:'||t.rowid||':'||f.id,t.name,NULL,'foreign key'
          FROM ${q(schema!)}.sqlite_schema t JOIN pragma_foreign_key_list(t.name,?) f WHERE t.type='table' AND substr(t.name,1,7)<>'sqlite_' AND f.seq=0
        ) ORDER BY CASE WHEN kind IN ('table','view') THEN 0 ELSE 1 END,kind,name,identity_name LIMIT 2001`, [schema,schema,schema])
        // Check every attached schema: early stopping can hide all of its
        // relations behind another database's indexes/foreign keys. Keep only
        // one overflow sentinel while merging the bounded per-schema reads.
        rows = [...rows, ...objects].sort((a,b) => rank(a)-rank(b) || [1,3,2,4].reduce((order,index) => order || (a[index] ?? '').localeCompare(b[index] ?? ''), 0)).slice(0, LIMIT + 1)
      }
      return catalog(rows, 'Includes main, temp and attached databases in this tab. Foreign keys use SQLite IDs because PRAGMA does not expose constraint names; other keys/checks remain in table details and stored CREATE SQL. SQLite has no stored routines or standalone sequences.')
    },
    async detail(o) {
      const sections = [], table = o.parent ?? o.name
      if (['table','view','index','trigger','constraint'].includes(o.kind)) {
        sections.push(section('Columns', ['Position','Name','Type','Not null','Default','Primary key position','Hidden / generated'], await query('SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?,?) ORDER BY cid LIMIT 501', [table,o.schema])))
        sections.push(section('Indexes', ['Position','Name','Unique','Origin','Partial'], await query('SELECT seq,name,"unique",origin,partial FROM pragma_index_list(?,?) ORDER BY seq LIMIT 501', [table,o.schema])))
        sections.push(section('Foreign keys', ['ID','Position','Referenced table','Column','Referenced column','On update','On delete','Match'], await query(`SELECT id,seq,"table","from","to",on_update,on_delete,match FROM pragma_foreign_key_list(?,?) ${o.kind === 'constraint' ? 'WHERE id=CAST(? AS INTEGER)' : ''} ORDER BY id,seq LIMIT 501`, [table,o.schema,...(o.kind === 'constraint' ? [o.identity.split(':').at(-1)!] : [])])))
      }
      if (o.kind === 'index') sections.push(section('Index columns', ['Position','Column ID','Name','Descending','Collation','Key'], await query('SELECT seqno,cid,name,"desc",coll,"key" FROM pragma_index_xinfo(?,?) ORDER BY seqno LIMIT 501', [o.name,o.schema])))
      if (o.kind === 'constraint') {
        const rows = await query(`SELECT sql FROM ${q(o.schema)}.sqlite_schema WHERE name=? AND type='table' AND rowid=?`, [table,o.identity.split(':')[1]])
        return { sections, definition: definition(rows[0]?.[0], 'native', 'Stored parent-table SQL. SQLite does not expose foreign-key constraint names; this entry uses the PRAGMA foreign-key ID.') }
      }
      const rows = await query(`SELECT sql FROM ${q(o.schema)}.sqlite_schema WHERE name=? AND type=? AND rowid=?`, [o.name,o.kind,o.identity])
      return { sections, definition: definition(rows[0]?.[0], 'native', rows[0]?.[0] ? 'Stored SQL from sqlite_schema. Referenced objects and separately created indexes/triggers are not included.' : 'SQLite generates this internal index for a table constraint; inspect the parent table definition.') }
    }
  }
}
