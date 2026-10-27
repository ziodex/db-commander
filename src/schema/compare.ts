import type { DatabaseDriver } from '../driver/driver'
import { quoteIdentifier } from '../shared/sql/common'
import { objectKey, type CatalogObject, type ObjectDetail } from '../shared/catalog'
import type { DatabaseEngine, SessionInfo } from '../shared/contracts'
import { compareSchemaSchema, type CompareScope, type CompareSchemaRequest, type ComparedObject, type SchemaComparison } from '../shared/schema-compare'

type Reader = Pick<DatabaseDriver, 'getSession' | 'explore'>
const key = (o: CatalogObject) => JSON.stringify([o.kind,o.name,o.parent ?? '',o.signature ?? ''])
const signature = (detail: ObjectDetail) => JSON.stringify([detail.sections, detail.definition.sql])
const complete = (d?: ObjectDetail) => Boolean(d && d.definition.sql && !d.definition.truncated && !d.sections.some(s => s.truncated))
const inScope = (o: CatalogObject, scope: CompareScope) => o.schema === scope.schema && (o.catalog ?? '') === (scope.catalog ?? '')
function ready(session: SessionInfo) {
  if (session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Commit or roll back and enable autocommit in both tabs before comparing schemas.')
  if (!session.database) throw new Error('Select a database in both tabs before comparing schemas.')
}
function columns(d: ObjectDetail) {
  const section = d.sections.find(s => s.title === 'Columns')
  return section?.rows.map(row => Object.fromEntries(section.columns.map((name,i) => [name,row[i]]))) ?? []
}
// Only nullable scalar columns whose complete type is represented in catalog metadata.
// Text/collation, defaults, identities, generated values and existing-column conversions need manual review.
function additiveType(c: ReturnType<typeof columns>[number], engine: DatabaseEngine): string | null {
  if (!(c.Nullable === 'true' || c.Nullable === '1' || c.Nullable === 'YES' || c.Nullable === 'Y' || c['Not null'] === '0')) return null
  if (['Default','Default / expression','Extra','Computed expression','Comment'].some(k => c[k] != null && c[k] !== '' && !(k === 'Default' && ['mysql','mariadb'].includes(engine) && c[k] === 'NULL'))) return null
  if (['Identity','Generated','Virtual','Hidden / generated','Primary key position'].some(k => c[k] && !['0','NO'].includes(c[k]!))) return null
  let type = c.Type?.toUpperCase() ?? ''
  if (engine === 'oracle' && type === 'NUMBER') type += c.Precision ? `(${c.Precision},${c.Scale ?? '0'})` : c.Scale != null ? `(*,${c.Scale})` : ''
  if (['sqlserver','azure-sql'].includes(engine) && ['DECIMAL','NUMERIC'].includes(type)) type += `(${c.Precision},${c.Scale})`
  if (engine === 'oracle' && /^NUMBER\(\*,\d{1,3}\)$/.test(type)) return type
  if (['mysql','mariadb'].includes(engine) && /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\(\d{1,3}\)$/.test(type)) return type
  return /^(?:SMALLINT|INTEGER|INT|BIGINT|TINYINT|REAL|DOUBLE|DOUBLE PRECISION|BOOLEAN|BOOL|BIT|DATE|NUMBER|(?:NUMERIC|DECIMAL|NUMBER)\(\d{1,2},\d{1,2}\))$/.test(type) ? type : null
}
function suggestions(item: ComparedObject, engine: DatabaseEngine, target: CompareScope) {
  const q = (v: string) => quoteIdentifier(v,engine), full = [...(target.catalog ? [q(target.catalog)] : []),q(target.schema),q(item.name)].join('.')
  if (item.status === 'unknown' || item.status === 'matching') return
  if (target.schema === 'temp' && engine === 'sqlite' || target.catalog === 'temp' && engine === 'duckdb') { item.notices.push('Temporary objects belong to the original session. Review reference SQL manually in that session.'); return }
  item.notices.push('Review dependencies, permissions and engine options manually. Renames are not inferred; name changes appear as two objects.')
  if (item.kind !== 'table') { item.notices.push('Definition changes require manual SQL; reference definitions are commented out.'); return }
  if (item.status === 'target-only') { item.destructiveSql.push(`DROP TABLE ${full};`); item.notices.push('Dropping this table removes its data. Check all dependencies first.'); return }
  if (!item.source || !item.target) { item.notices.push('Creating a missing table requires reviewing its full definition, dependencies and storage options. The source definition is provided as commented reference SQL.'); return }
  const source = columns(item.source), dest = columns(item.target), destNames = new Set(dest.map(c => c.Name))
  for (const column of source.filter(c => !destNames.has(c.Name))) {
    const type = additiveType(column,engine)
    if (type && column.Name) item.sql.push(`ALTER TABLE ${full} ADD ${q(column.Name)} ${type}${['sqlserver','azure-sql'].includes(engine) ? ' NULL' : ''};`)
    else item.notices.push(`Column ${column.Name}: review its native type, default, collation and constraints manually.`)
  }
  item.notices.push('Suggestions cover only missing nullable scalar columns. Column removal/conversion, keys, indexes, triggers and remaining definition differences require manual SQL.')
}
export async function compareSchemas(input: CompareSchemaRequest, source: Reader, target: Reader): Promise<SchemaComparison> {
  const request = compareSchemaSchema.parse(input), a = source.getSession(request.source.sessionId), b = target.getSession(request.target.sessionId)
  if (a.engine !== b.engine) throw new Error('Schema comparison requires the same engine in both tabs (including the same SQL Server/Azure SQL profile type).')
  ready(a); ready(b)
  if (JSON.stringify(request.source) === JSON.stringify(request.target)) throw new Error('Choose different tabs or namespaces for source and target.')
  let bytes = 0
  const started=performance.now()
  const budget=()=>{if(performance.now()-started>45_000)throw new Error('Schema comparison exceeded its 45-second collection budget. Narrow the scope and retry.')}
  const read = async (driver: Reader, scope: CompareScope) => {
    const snapshot = (await driver.explore(scope.sessionId)).catalog
    if (!snapshot || snapshot.truncated) throw new Error('The catalog is unavailable or truncated; a complete object inventory is required for comparison.')
    const objects = snapshot.objects.filter(o => inScope(o,scope) && request.kinds.includes(o.kind) && o.name.toLowerCase().includes(request.filter.toLowerCase()))
    if (objects.length > 40) throw new Error('Comparison is limited to 40 objects per side. Narrow the name filter or object kinds.')
    const entries = new Map<string,{object: CatalogObject; detail?: ObjectDetail; error?: string}>()
    for (const object of objects) {
      budget()
      if (entries.has(key(object))) throw new Error('Ambiguous object names or overloads in this scope; narrow the comparison.')
      let detail: ObjectDetail | undefined, error: string | undefined
      try { detail = (await driver.explore(scope.sessionId, object)).detail } catch (e) { error = (e as Error).message }
      budget()
      bytes += JSON.stringify(detail ?? '').length
      if (bytes > 4_000_000) throw new Error('Comparison metadata exceeds 4 MB. Narrow the comparison.')
      entries.set(key(object), {object,detail,error})
    }
    budget()
    const after = (await driver.explore(scope.sessionId)).catalog
    if (!after || after.truncated || JSON.stringify(after.objects.filter(o=>inScope(o,scope)).map(objectKey).sort()) !== JSON.stringify(snapshot.objects.filter(o=>inScope(o,scope)).map(objectKey).sort())) throw new Error('The catalog changed during comparison. Refresh and compare again.')
    return {entries,notice:snapshot.notice}
  }
  const left = await read(source,request.source), right = await read(target,request.target)
  const objects: ComparedObject[] = [...new Set([...left.entries.keys(),...right.entries.keys()])].sort().map(k => {
    const l = left.entries.get(k), r = right.entries.get(k), o = (l ?? r)!.object
    const unknown = l && !complete(l.detail) || r && !complete(r.detail)
    const item: ComparedObject = {key:k,name:o.name,kind:o.kind,parent:o.parent,signature:o.signature,status:unknown ? 'unknown' : !l ? 'target-only' : !r ? 'source-only' : signature(l.detail!) === signature(r.detail!) ? 'matching' : 'changed',source:l?.detail,target:r?.detail,notices:[],sql:[],destructiveSql:[]}
    if (unknown) item.notices.push('Unreadable or incomplete definition/metadata; no SQL suggestions are generated.',...[l?.error,r?.error].filter((s):s is string=>Boolean(s)))
    if (item.status === 'changed' && item.source && item.target) {
      const sourceSections=new Map(item.source.sections.map(s=>[s.title,s])),targetSections=new Map(item.target.sections.map(s=>[s.title,s]))
      const changed=[...new Set([...sourceSections.keys(),...targetSections.keys()])].filter(title=>JSON.stringify(sourceSections.get(title))!==JSON.stringify(targetSections.get(title)))
      if(changed.length)item.notices.push(`Different metadata sections: ${changed.join(', ')}.`)
      if(item.source.definition.sql!==item.target.definition.sql)item.notices.push('Definition text differs; review both definitions, including namespace qualifiers and formatting.')
    }
    suggestions(item,a.engine,request.target)
    return item
  })
  return {engine:a.engine,source:request.source,target:request.target,sourceLabel:`${a.name} / ${a.host}${a.port ? ':'+a.port : ''} / ${a.database} / ${request.source.catalog ? request.source.catalog+'.' : ''}${request.source.schema}`,targetLabel:`${b.name} / ${b.host}${b.port ? ':'+b.port : ''} / ${b.database} / ${request.target.catalog ? request.target.catalog+'.' : ''}${request.target.schema}`,objects,fetchedAt:new Date().toISOString(),notices:[
    'Comparison covers visible catalog metadata and exact definition text, not data or a complete migration. Matching does not certify database equivalence. Whitespace, namespace qualifiers and generated names can appear as differences. SQL text is never rewritten to remap namespaces.',
    'Metadata is read sequentially, not in a cross-database snapshot. Refresh before using SQL; no changes are executed by comparison.',
    ...(!left.entries.size?['No source objects matched. Verify the namespace, filter and permissions before considering target-only drops.']:[]),
    ...(['sqlite','duckdb'].includes(a.engine)?['Attached databases and temporary objects belong to the original sessions. A new query tab does not replay ATTACH or recreate temporary objects; establish that context explicitly before using exported SQL.']:[]),
    `Source: ${left.notice}`,`Target: ${right.notice}`]}
}
