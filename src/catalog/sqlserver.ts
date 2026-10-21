import { catalog, definition, section, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function sqlServerCatalog(query: CatalogQuery): CatalogAdapter {
  const q = (s: string) => quoteIdentifier(s, 'sqlserver')
  return {
    async list() { return catalog(await query(`SELECT TOP (2001) * FROM (
      SELECT NULL AS catalog_name,s.name AS schema_name,o.name AS object_name,CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure' WHEN 'PC' THEN 'procedure' WHEN 'TR' THEN 'trigger' WHEN 'TA' THEN 'trigger' WHEN 'SO' THEN 'sequence' WHEN 'C' THEN 'constraint' WHEN 'D' THEN 'constraint' WHEN 'F' THEN 'constraint' WHEN 'PK' THEN 'constraint' WHEN 'UQ' THEN 'constraint' ELSE 'function' END AS kind,CONVERT(varchar(30),o.object_id) AS identity_name,OBJECT_NAME(NULLIF(o.parent_object_id,0)) AS parent_name,NULL AS signature_name,CASE o.type WHEN 'PK' THEN 'primary key' WHEN 'F' THEN 'foreign key' WHEN 'UQ' THEN 'unique' WHEN 'C' THEN 'check' WHEN 'D' THEN 'default' END AS constraint_type
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND o.type IN ('U','V','P','PC','TR','TA','SO','C','D','F','PK','UQ','FN','IF','TF','FS','FT')
      UNION ALL SELECT NULL,s.name,i.name,'index',CONCAT(i.object_id,':',i.index_id),o.name,NULL,NULL FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND i.name IS NOT NULL AND o.type IN ('U','V')
      ) objects ORDER BY CASE WHEN kind IN ('table','view') THEN 0 ELSE 1 END,schema_name,kind,object_name,identity_name`), 'Visible user objects from a separate catalog connection. Definition access follows SQL Server metadata permissions; encrypted modules have no readable definition.') },
    async detail(o) {
      const sections = [], table = o.parent ?? o.name, params = [o.schema,table]
      if (['table','view','index','constraint','trigger'].includes(o.kind)) {
        const columns = await query(`SELECT TOP (501) c.name,t.name,CONVERT(varchar(20),c.max_length),c.precision,c.scale,c.is_nullable,c.is_identity,cc.definition,dc.definition,dc.name FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.types t ON t.user_type_id=c.user_type_id LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE s.name=@p1 AND o.name=@p2 ORDER BY c.column_id`, params)
        sections.push(section('Columns', ['Name','Type','Length (bytes)','Precision','Scale','Nullable','Identity','Computed expression','Default','Default constraint'], columns))
        sections.push(section('Indexes', ['Name','Method','Unique','Position','Column','Descending','Included','Filter'], await query(`SELECT TOP (501) i.name,i.type_desc,i.is_unique,ic.key_ordinal,c.name,ic.is_descending_key,ic.is_included_column,i.filter_definition FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE s.name=@p1 AND o.name=@p2 AND i.name IS NOT NULL ORDER BY i.name,ic.index_column_id`, params)))
        sections.push(section('Constraints and keys', ['Name','Kind','Definition'], await query(`SELECT TOP (501) x.name,x.type_desc,OBJECT_DEFINITION(x.object_id) FROM sys.objects x JOIN sys.objects o ON o.object_id=x.parent_object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=@p1 AND o.name=@p2 AND x.type IN ('C','D','F','PK','UQ') ORDER BY x.name`, params)))
        sections.push(section('Foreign keys', ['Name','Column','Referenced schema','Referenced table','Referenced column','On update','On delete'], await query(`SELECT TOP (501) f.name,c.name,rs.name,r.name,rc.name,f.update_referential_action_desc,f.delete_referential_action_desc FROM sys.foreign_keys f JOIN sys.foreign_key_columns k ON k.constraint_object_id=f.object_id JOIN sys.objects o ON o.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id AND c.column_id=k.parent_column_id JOIN sys.objects r ON r.object_id=f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=r.schema_id JOIN sys.columns rc ON rc.object_id=r.object_id AND rc.column_id=k.referenced_column_id WHERE s.name=@p1 AND o.name=@p2 ORDER BY f.name,k.constraint_column_id`, params)))
        sections.push(section('Triggers', ['Name','Disabled','Definition'], await query(`SELECT TOP (501) t.name,t.is_disabled,OBJECT_DEFINITION(t.object_id) FROM sys.triggers t JOIN sys.objects o ON o.object_id=t.parent_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=@p1 AND o.name=@p2 ORDER BY t.name`, params)))
        if (o.kind === 'table') {
          const parts = columns.map(c => `  ${q(c[0]!)} ${c[7] ? `AS ${c[7]}` : `${q(c[1]!)}${/^(n?varchar|n?char|varbinary|binary)$/.test(c[1]!) ? `(${c[2] === '-1' ? 'MAX' : Number(c[2]) / (c[1]!.startsWith('n') ? 2 : 1)})` : /^(decimal|numeric)$/.test(c[1]!) ? `(${c[3]},${c[4]})` : ''}${c[8] ? ` DEFAULT ${c[8]}` : ''}${c[5] === '0' ? ' NOT NULL' : ' NULL'}`}`)
          return { sections, definition: definition(`CREATE TABLE ${q(o.schema)}.${q(o.name)} (\n${parts.join(',\n')}\n);`, 'generated', 'Column outline only. Identity seed/increment, keys, indexes, computed persistence, temporal/storage options and grants are omitted. Review the metadata sections; use native backup for faithful recreation.') }
        }
        if (o.kind === 'index') {
          const idx = sections.find(s => s.title === 'Indexes')!.rows.filter(r => r[0] === o.name)
          const r = idx[0]
          const sql = r && ['CLUSTERED','NONCLUSTERED'].includes(r[1]!) ? `CREATE ${r[2] === '1' ? 'UNIQUE ' : ''}${r[1]} INDEX ${q(o.name)} ON ${q(o.schema)}.${q(table)} (${idx.filter(r => r[6] === '0').sort((a,b) => Number(a[3])-Number(b[3])).map(r => `${q(r[4]!)} ${r[5] === '1' ? 'DESC' : 'ASC'}`).join(', ')})${idx.some(r=>r[6]==='1') ? ` INCLUDE (${idx.filter(r=>r[6]==='1').map(r=>q(r[4]!)).join(', ')})` : ''}${r[7] ? ` WHERE ${r[7]}` : ''};` : null
          return { sections, definition: definition(sql, 'generated', 'Index structure from catalog metadata; filegroup and physical options are omitted. Constraint-backed indexes should be created through their constraint. Specialized index types are shown in the metadata only.') }
        }
      }
      if (o.kind === 'sequence') {
        const rows = await query('SELECT name,TYPE_NAME(user_type_id),CONVERT(varchar(100),start_value),CONVERT(varchar(100),minimum_value),CONVERT(varchar(100),maximum_value),CONVERT(varchar(100),increment),is_cycling,is_cached,CONVERT(varchar(100),cache_size) FROM sys.sequences WHERE object_id=CONVERT(int,@p1)', [o.identity])
        sections.push(section('Sequence', ['Name','Type','Start','Minimum','Maximum','Increment','Cycle','Cached','Cache size'], rows))
        const r = rows[0]
        return { sections, definition: definition(r && `CREATE SEQUENCE ${q(o.schema)}.${q(o.name)} AS ${r[1]} START WITH ${r[2]} INCREMENT BY ${r[5]} MINVALUE ${r[3]} MAXVALUE ${r[4]} ${r[6] === '1' ? 'CYCLE' : 'NO CYCLE'} ${r[7] === '1' ? `CACHE ${r[8] ?? ''}` : 'NO CACHE'};`, 'generated', 'Configuration only; reading does not advance the sequence. Current value and grants are omitted.') }
      }
      if (['function','procedure'].includes(o.kind)) sections.push(section('Parameters', ['Name','Type','Length','Output','Position'], await query('SELECT TOP (501) name,TYPE_NAME(user_type_id),max_length,is_output,parameter_id FROM sys.parameters WHERE object_id=CONVERT(int,@p1) ORDER BY parameter_id', [o.identity])))
      if (o.kind === 'constraint') {
        const prefix = `ALTER TABLE ${q(o.schema)}.${q(table)} ADD CONSTRAINT ${q(o.name)} `
        const key = await query('SELECT TOP (501) k.type,i.type_desc,c.name,ic.is_descending_key FROM sys.key_constraints k JOIN sys.indexes i ON i.object_id=k.parent_object_id AND i.index_id=k.unique_index_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE k.object_id=CONVERT(int,@p1) AND ic.key_ordinal>0 ORDER BY ic.key_ordinal', [o.identity])
        if (key.length) return { sections, definition: definition(prefix + `${key[0][0] === 'PK' ? 'PRIMARY KEY' : 'UNIQUE'} ${key[0][1]} (${key.map(r => `${q(r[2]!)} ${r[3] === '1' ? 'DESC' : 'ASC'}`).join(', ')});`, 'generated', 'Key structure; storage and index options are omitted.') }
        const fk = sections.find(s => s.title === 'Foreign keys')?.rows.filter(r => r[0] === o.name)
        if (fk?.length) return { sections, definition: definition(prefix + `FOREIGN KEY (${fk.map(r=>q(r[1]!)).join(', ')}) REFERENCES ${q(fk[0][2]!)}.${q(fk[0][3]!)} (${fk.map(r=>q(r[4]!)).join(', ')}) ON UPDATE ${fk[0][5]!.replaceAll('_',' ')} ON DELETE ${fk[0][6]!.replaceAll('_',' ')};`, 'generated', 'Foreign-key structure; trust, replication and enabled state are not reproduced.') }
      }
      const sql = (await query('SELECT OBJECT_DEFINITION(CONVERT(int,@p1))', [o.identity]))[0]?.[0]
      return { sections, definition: definition(sql, 'native', o.kind === 'constraint' ? 'Check/default expressions are exposed directly. Key and foreign-key structure is available in the parent-table metadata sections.' : undefined) }
    }
  }
}
