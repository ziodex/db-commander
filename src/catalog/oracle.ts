import { catalog, definition, section, type CatalogAdapter, type CatalogQuery } from './common'
import { quoteIdentifier } from '../shared/sql/common'
export function oracleCatalog(query: CatalogQuery, definitionQuery?: CatalogQuery): CatalogAdapter {
  async function nativeDefinition(o: Parameters<CatalogAdapter['detail']>[0]) {
    try {
      let kind = o.kind.toUpperCase().replaceAll(' ', '_')
      if (o.kind === 'package' || o.kind === 'type') kind += '_SPEC'
      if (o.kind === 'constraint') { const type = (await query('SELECT constraint_type FROM user_constraints WHERE USER=:1 AND constraint_name=:2', [o.schema,o.name]))[0]?.[0]; kind = type === 'R' ? 'REF_CONSTRAINT' : 'CONSTRAINT' }
      return definition((await (definitionQuery ?? query)('SELECT DBMS_METADATA.GET_DDL(:1,:2,:3) FROM dual', [kind,o.name,o.schema]))[0]?.[0], 'native', 'Native Oracle object DDL. Dependent objects, grants and package bodies are not automatically included.')
    } catch (error) { return definition(null, 'native', `Definition unavailable: ${(error as Error).message}`) }
  }
  return {
    // Scope is deliberately the login's own objects. USER_* avoids the broad
    // privilege expansion in ALL_*; one scan identifies MV backing tables.
    async list() { return catalog(await query(`SELECT * FROM (
      SELECT NULL AS catalog_name,USER AS schema_name,o.object_name AS name,LOWER(o.object_type) AS kind,TO_CHAR(o.object_id) AS identity_name,CASE WHEN i.table_owner=USER THEN i.table_name WHEN t.table_owner=USER THEN t.table_name END AS parent_name,CAST(NULL AS VARCHAR2(128)) AS signature_name,CAST(NULL AS VARCHAR2(32)) AS constraint_type FROM (
        SELECT object_name,object_type,object_id,MAX(CASE WHEN object_type='MATERIALIZED VIEW' THEN 1 ELSE 0 END) OVER (PARTITION BY object_name) AS materialized
        FROM user_objects WHERE object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','INDEX','FUNCTION','PROCEDURE','TRIGGER','SEQUENCE','PACKAGE','TYPE')
      ) o LEFT JOIN user_indexes i ON o.object_type='INDEX' AND i.index_name=o.object_name
      LEFT JOIN user_triggers t ON o.object_type='TRIGGER' AND t.trigger_name=o.object_name
      WHERE o.object_type<>'TABLE' OR o.materialized=0
      UNION ALL SELECT NULL,USER,constraint_name,'constraint',constraint_name,table_name,NULL,CASE constraint_type WHEN 'P' THEN 'primary key' WHEN 'R' THEN 'foreign key' WHEN 'U' THEN 'unique' WHEN 'C' THEN 'check' ELSE 'other' END FROM user_constraints
      ) objects ORDER BY CASE WHEN kind IN ('table','view','materialized view') THEN 0 ELSE 1 END,schema_name,kind,name,identity_name FETCH FIRST 2001 ROWS ONLY`), 'Objects owned by the current Oracle user, from a separate catalog connection. Package/type specifications are included. Materialized-view definitions are generated logical summaries; other definitions use GET_DDL with Oracle metadata privileges; other owners and package bodies are outside this view.') },
    async detail(o) {
      // Only overlap reads when the driver supplies a separate connection.
      // Inspect validates the object against the owned catalog before this.
      const pendingDefinition = definitionQuery && !['constraint', 'materialized view'].includes(o.kind) ? nativeDefinition(o) : undefined
      try {
        const sections = [], table = o.parent ?? o.name, params = [o.schema,table]
        if (['table','view','materialized view','constraint'].includes(o.kind)) {
          let columns: (string | null)[][]
          try { columns = await query('SELECT column_name,data_type,data_length,data_precision,data_scale,nullable,data_default,identity_column,virtual_column,default_on_null,char_used,char_length,collation FROM user_tab_cols WHERE USER=:1 AND table_name=:2 AND hidden_column=\'NO\' ORDER BY column_id FETCH FIRST 501 ROWS ONLY', params) }
          catch {
            try { columns = (await query('SELECT column_name,data_type,data_length,data_precision,data_scale,nullable,data_default,identity_column,virtual_column,default_on_null FROM user_tab_cols WHERE USER=:1 AND table_name=:2 AND hidden_column=\'NO\' ORDER BY column_id FETCH FIRST 501 ROWS ONLY', params)).map(row => [...row, null, null, null]) }
            catch { columns = (await query('SELECT column_name,data_type,data_length,data_precision,data_scale,nullable,data_default,identity_column,virtual_column FROM user_tab_cols WHERE USER=:1 AND table_name=:2 AND hidden_column=\'NO\' ORDER BY column_id FETCH FIRST 501 ROWS ONLY', params)).map(row => [...row, null, null, null, null]) }
          }
          sections.push(section('Columns', ['Name','Type','Length','Precision','Scale','Nullable','Default','Identity','Virtual','Default on null','Char semantics','Char length','Collation'], columns))
          // Identity metadata may be unavailable on older servers. Keep object
          // browsing usable and require this section when altering identity.
          try { sections.push(section('Identity columns', ['Column','Generation','Sequence options'], await query('SELECT column_name,generation_type,identity_options FROM user_tab_identity_cols WHERE USER=:1 AND table_name=:2 ORDER BY column_name FETCH FIRST 501 ROWS ONLY', params))) } catch { /* optional metadata */ }
          try { sections.push(section('Virtual column editions', ['Column','Evaluation edition','Unusable before','Unusable beginning','Table default collation'], await query('SELECT c.column_name,c.evaluation_edition,c.unusable_before,c.unusable_beginning,(SELECT t.default_collation FROM user_tables t WHERE t.table_name=c.table_name) FROM user_tab_cols c WHERE USER=:1 AND c.table_name=:2 AND c.virtual_column=\'YES\' AND c.hidden_column=\'NO\' ORDER BY c.column_id FETCH FIRST 501 ROWS ONLY', params))) } catch { /* optional metadata */ }
          const constraints = section('Constraints and keys', ['Name','Kind','Status','Deferrable','Validated','Referenced owner','Referenced constraint','Delete rule'], await query('SELECT constraint_name,constraint_type,status,deferrable,validated,r_owner,r_constraint_name,delete_rule FROM user_constraints WHERE USER=:1 AND table_name=:2 ORDER BY constraint_name FETCH FIRST 501 ROWS ONLY', params))
          sections.push(constraints)
          const keyColumns = section('Key columns', ['Constraint','Column','Position'], await query('SELECT constraint_name,column_name,position FROM user_cons_columns WHERE USER=:1 AND table_name=:2 ORDER BY constraint_name,position FETCH FIRST 501 ROWS ONLY', params))
          sections.push(keyColumns)
          // Reuse complete local metadata for self-referencing keys instead of
          // expanding Oracle's cross-owner dictionary views again. Unknown,
          // external or truncated references retain the full lookup below.
          const references = constraints.rows.filter(row => row[1] === 'R')
          const localReferences = !constraints.truncated && (!references.length || !keyColumns.truncated) ? references.map(reference => {
            if (reference[5] !== o.schema || !constraints.rows.some(row => row[0] === reference[6] && ['P', 'U'].includes(row[1]!))) return undefined
            const from = keyColumns.rows.filter(row => row[0] === reference[0]), to = keyColumns.rows.filter(row => row[0] === reference[6])
            const pairs = from.map(source => ({ source, target: to.find(target => target[2] === source[2]) }))
            if (!from.length || from.length !== to.length || new Set(from.map(row => row[2])).size !== from.length || new Set(to.map(row => row[2])).size !== to.length || pairs.some(({ source, target }) => source[1] === null || source[2] === null || !target || target[1] === null)) return undefined
            return pairs.map(({ source, target }) => [reference[0], source[1], reference[5], table, target![1], reference[7]])
          }) : undefined
          const foreignKeys = localReferences?.every(rows => rows !== undefined)
            ? localReferences.flatMap(rows => rows!)
            : await query('SELECT c.constraint_name,k.column_name,r.owner,r.table_name,rk.column_name,c.delete_rule FROM user_constraints c JOIN user_cons_columns k ON k.constraint_name=c.constraint_name JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name JOIN all_cons_columns rk ON rk.owner=r.owner AND rk.constraint_name=r.constraint_name AND rk.position=k.position WHERE USER=:1 AND c.table_name=:2 AND c.constraint_type=\'R\' ORDER BY c.constraint_name,k.position FETCH FIRST 501 ROWS ONLY', params)
          sections.push(section('Foreign keys', ['Name','Column','Referenced owner','Referenced table','Referenced column','On delete'], foreignKeys))
          sections.push(section('Indexes', ['Name','Type','Uniqueness','Status'], await query('SELECT index_name,index_type,uniqueness,status FROM user_indexes WHERE table_owner=:1 AND table_name=:2 ORDER BY index_name FETCH FIRST 501 ROWS ONLY', params)))
          sections.push(section('Triggers', ['Name','Type','Event','Status'], await query('SELECT trigger_name,trigger_type,triggering_event,status FROM user_triggers WHERE table_owner=:1 AND table_name=:2 ORDER BY trigger_name FETCH FIRST 501 ROWS ONLY', params)))
        }
        if (o.kind === 'index') sections.push(section('Index columns', ['Table','Column','Position','Order'], await query('SELECT table_name,column_name,column_position,descend FROM user_ind_columns WHERE USER=:1 AND index_name=:2 ORDER BY column_position FETCH FIRST 501 ROWS ONLY', [o.schema,o.name])))
        if (['function','procedure','package'].includes(o.kind)) sections.push(section('Arguments', ['Routine','Overload','Argument','Mode','Type','Position'], await query('SELECT object_name,overload,argument_name,in_out,data_type,position FROM user_arguments WHERE USER=:1 AND NVL(package_name,object_name)=:2 ORDER BY subprogram_id,sequence FETCH FIRST 501 ROWS ONLY', [o.schema,o.name])))
        if (o.kind === 'sequence') sections.push(section('Sequence', ['Minimum','Maximum','Increment','Cycle','Cache'], await query('SELECT min_value,max_value,increment_by,cycle_flag,cache_size FROM user_sequences WHERE USER=:1 AND sequence_name=:2', [o.schema,o.name])))
        try {
          if (o.kind === 'materialized view') {
            // GET_DDL's materialized-view XML expansion can take minutes even on
            // a tiny schema. Read the stored query instead of blocking inspection
            // on that path. This is deliberately labeled as a logical summary.
            const rows = await query('SELECT query,build_mode,refresh_method,refresh_mode,rewrite_enabled FROM user_mviews WHERE USER=:1 AND mview_name=:2', [o.schema,o.name])
            const [text,build,method,mode,rewrite] = rows[0] ?? []
            sections.push(section('Materialized view', ['Build','Refresh method','Refresh mode','Query rewrite'], rows.map(row => row.slice(1))))
            const columns = sections.find(s => s.title === 'Columns')!
            if (!text || !['IMMEDIATE','DEFERRED','PREBUILT'].includes(build!) || !['COMPLETE','FAST','FORCE','NEVER'].includes(method!) || !['COMMIT','DEMAND','STATEMENT','NEVER'].includes(mode!) || !['Y','N'].includes(rewrite!) || columns.truncated || !columns.rows.length) {
              return { sections, definition: definition(text, 'generated', 'Only the stored defining query is available. The catalog did not expose enough supported metadata to generate a CREATE summary.') }
            }
            const q = (name: string) => quoteIdentifier(name, 'oracle')
            const refresh = method === 'NEVER' || mode === 'NEVER' ? 'NEVER REFRESH' : `REFRESH ${method} ON ${mode}`
            const sql = `-- Logical summary, not full native DDL. Review before use.\n-- Storage, indexes, grants, refresh schedules and advanced clauses are omitted.\nCREATE MATERIALIZED VIEW ${q(o.schema)}.${q(o.name)} (${columns.rows.map(row => q(row[0]!)).join(', ')})\n${build === 'PREBUILT' ? 'ON PREBUILT TABLE' : `BUILD ${build}`}\n${refresh}\n${rewrite === 'Y' ? 'ENABLE' : 'DISABLE'} QUERY REWRITE\nAS\n${text}`
            return { sections, definition: definition(sql, 'generated', 'Logical summary from Oracle catalog metadata, not full native DDL. Storage, indexes, grants, refresh schedules, refresh-key options, updatability and other advanced clauses are omitted. Review before use; prebuilt views require their existing table.') }
          }
          return { sections, definition: await (pendingDefinition ?? nativeDefinition(o)) }
        } catch (error) { return { sections, definition: definition(null, 'native', `Definition unavailable: ${(error as Error).message}`) } }
      // A section failure must not abandon the other connection's query.
      } finally { await pendingDefinition }
    }
  }
}
