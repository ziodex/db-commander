import { catalog, definition, section, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function postgresCatalog(query: CatalogQuery): CatalogAdapter {
  const q = (s: string) => quoteIdentifier(s, 'postgres')
  const visible = `substring(n.nspname from 1 for 3)<>'pg_' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege(n.oid,'USAGE')`
  return {
    async list() { return catalog(await query(`SELECT * FROM (
      SELECT NULL::text,n.nspname,c.relname,CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'i' THEN 'index' WHEN 'I' THEN 'index' WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,c.oid::text,
        (SELECT t.relname FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid=x.indrelid WHERE x.indexrelid=c.oid),NULL::text,NULL::text
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${visible} AND c.relkind IN ('r','p','v','m','f','i','I','S') AND
        (CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') WHEN c.relkind IN ('i','I') THEN EXISTS(SELECT 1 FROM pg_catalog.pg_index x WHERE x.indexrelid=c.oid AND pg_catalog.has_table_privilege(x.indrelid,'SELECT,INSERT,UPDATE,DELETE')) ELSE pg_catalog.has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE') OR pg_catalog.has_any_column_privilege(c.oid,'SELECT') END)
      UNION ALL SELECT NULL,n.nspname,p.proname,CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END,p.oid::text,NULL,pg_catalog.pg_get_function_identity_arguments(p.oid),NULL
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${visible} AND p.prokind IN ('f','p') AND pg_catalog.has_function_privilege(p.oid,'EXECUTE')
      UNION ALL SELECT NULL,n.nspname,c.conname,'constraint',c.oid::text,t.relname,NULL,CASE c.contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' WHEN 'n' THEN 'not null' ELSE 'other' END FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE ${visible} AND pg_catalog.has_table_privilege(t.oid,'SELECT,INSERT,UPDATE,DELETE')
      UNION ALL SELECT NULL,n.nspname,g.tgname,'trigger',g.oid::text,t.relname,NULL,NULL FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE ${visible} AND NOT g.tgisinternal AND pg_catalog.has_table_privilege(t.oid,'SELECT,INSERT,UPDATE,DELETE')
      ) objects ORDER BY CASE WHEN kind IN ('table','view','materialized view') THEN 0 ELSE 1 END,2,4,3,5 LIMIT 2001`), 'Visible user objects from a separate catalog connection. Uncommitted and session-temporary objects are not included.') },
    async detail(o) {
      const id = [o.identity], full = `${q(o.schema)}.${q(o.name)}`, sections: import('../shared/catalog').CatalogSection[] = []
      if (['table','view','materialized view'].includes(o.kind)) {
        const columns = await query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,pg_catalog.pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,col_description(a.attrelid,a.attnum),cn.nspname,co.collname FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 501`, id)
        sections.push(section('Columns', ['Name','Type','Nullable','Default / expression','Identity','Generated','Comment','Collation schema','Collation'], columns))
        const constraints = await query(`SELECT conname,contype,pg_catalog.pg_get_constraintdef(oid,true),convalidated FROM pg_catalog.pg_constraint WHERE conrelid=$1::oid ORDER BY conname LIMIT 501`, id)
        sections.push(section('Constraints and keys', ['Name','Kind','Definition','Validated'], constraints))
        sections.push(section('Indexes', ['Name','Definition'], await query(`SELECT c.relname,pg_catalog.pg_get_indexdef(c.oid) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::oid ORDER BY c.relname LIMIT 501`, id)))
        sections.push(section('Triggers', ['Name','Definition'], await query(`SELECT tgname,pg_catalog.pg_get_triggerdef(oid,true) FROM pg_catalog.pg_trigger WHERE tgrelid=$1::oid AND NOT tgisinternal ORDER BY tgname LIMIT 501`, id)))
        if (o.kind !== 'table') return { sections, definition: definition(`CREATE ${o.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW'} ${full} AS\n${(await query('SELECT pg_catalog.pg_get_viewdef($1::oid,true)', id))[0]?.[0] ?? ''}`, 'generated', 'View query reconstructed by PostgreSQL. Ownership, grants and storage options are omitted.') }
        const sql = `CREATE TABLE ${full} (\n${[...columns.map(c => `  ${q(c[0]!)} ${c[1]}${c[4] ? ` GENERATED ${c[4] === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : c[5] ? ` GENERATED ALWAYS AS (${c[3]}) ${c[5] === 'v' ? 'VIRTUAL' : 'STORED'}` : c[3] ? ` DEFAULT ${c[3]}` : ''}${c[2] === 'false' || c[2] === '0' ? ' NOT NULL' : ''}`), ...constraints.map(c => `  CONSTRAINT ${q(c[0]!)} ${c[2]}`)].join(',\n')}\n);`
        return { sections, definition: definition(sql, 'generated', 'Structural summary, not a migration or backup: partitioning, inheritance, storage, policies, privileges and separate indexes/triggers are omitted. See the detail sections.') }
      }
      if (o.kind === 'sequence') {
        const rows = await query(`SELECT data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_catalog.pg_sequences WHERE schemaname=$1 AND sequencename=$2`, [o.schema,o.name])
        sections.push(section('Sequence', ['Type','Start','Minimum','Maximum','Increment','Cycle','Cache'], rows))
        const r = rows[0]
        return { sections, definition: definition(r && `CREATE SEQUENCE ${full} AS ${r[0]} INCREMENT BY ${r[4]} MINVALUE ${r[2]} MAXVALUE ${r[3]} START WITH ${r[1]} CACHE ${r[6]} ${r[5] === 'true' ? 'CYCLE' : 'NO CYCLE'};`, 'generated', 'Sequence configuration only; current value, ownership and grants are omitted. Inspecting does not advance the sequence.') }
      }
      const fn = o.kind === 'index' ? 'pg_get_indexdef' : o.kind === 'trigger' ? 'pg_get_triggerdef' : o.kind === 'constraint' ? 'pg_get_constraintdef' : 'pg_get_functiondef'
      let sql = (await query(`SELECT pg_catalog.${fn}($1::oid)`, id))[0]?.[0]
      if (o.kind === 'constraint' && sql) sql = `ALTER TABLE ${q(o.schema)}.${q(o.parent!)} ADD CONSTRAINT ${q(o.name)} ${sql};`
      return { sections, definition: definition(sql) }
    }
  }
}
