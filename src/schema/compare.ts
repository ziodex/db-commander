import type { DatabaseDriver } from '../driver/driver'
import { quoteIdentifier } from '../shared/sql/common'
import { objectKey, type CatalogObject, type ObjectDetail } from '../shared/catalog'
import type { DatabaseEngine, SessionInfo } from '../shared/contracts'
import { SCHEMA_DETAIL_LIMIT, SCHEMA_INVENTORY_LIMIT, compareSchemaSchema, type CompareScope, type CompareSchemaRequest, type ComparedObject, type SchemaComparison } from '../shared/schema-compare'

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
  const request = compareSchemaSchema.parse(input)
  const a = source.getSession(request.source.sessionId), b = target.getSession(request.target.sessionId)
  if (a.engine !== b.engine) throw new Error('Schema comparison requires the same engine in both tabs (including the same SQL Server/Azure SQL profile type).')
  ready(a)
  ready(b)
  if (JSON.stringify(request.source) === JSON.stringify(request.target)) throw new Error('Choose different tabs or namespaces for source and target.')
  let bytes = 0
  const started = performance.now()
  const budget = () => {
    if (performance.now() - started > 45_000) throw new Error('Schema comparison exceeded its 45-second collection budget. Narrow the scope and retry.')
  }
  async function inventory(driver: Reader, scope: CompareScope) {
    budget()
    const snapshot = (await driver.explore(scope.sessionId, undefined, undefined, {
      inventory: true,
      namespace: { schema: scope.schema, catalog: scope.catalog || undefined },
      kinds: request.kinds,
      nameContains: request.filter,
      limit: SCHEMA_INVENTORY_LIMIT
    })).catalog
    budget()
    if (!snapshot) throw new Error('The visible catalog is unavailable. Refresh and compare again.')
    if (snapshot.truncated) throw new Error(`The scoped inventory is truncated at ${SCHEMA_INVENTORY_LIMIT} objects per side. Narrow the name filter or object kinds. No partial comparison was produced.`)
    const entries = new Map<string, CatalogObject>()
    for (const object of snapshot.objects) {
      if (!inScope(object, scope) || !request.kinds.includes(object.kind)) continue
      if (entries.has(key(object))) throw new Error('Ambiguous object names or overloads in this scope. Narrow the comparison.')
      entries.set(key(object), object)
    }
    return { entries, notice: snapshot.notice }
  }
  const left = await inventory(source, request.source)
  const right = await inventory(target, request.target)
  const keys = [...new Set([...left.entries.keys(), ...right.entries.keys()])].sort()
  const inventoryOnly = request.mode === 'inventory'
  const selected = new Set(request.selection ?? keys)
  if (request.selection?.some(id => !left.entries.has(id) && !right.entries.has(id))) {
    throw new Error('A selected object is no longer visible. Refresh the inventory and select it again.')
  }
  if (!inventoryOnly && [left, right].some(side => [...side.entries.keys()].filter(id => selected.has(id)).length > SCHEMA_DETAIL_LIMIT)) {
    throw new Error(`Definition comparison is limited to ${SCHEMA_DETAIL_LIMIT} objects per side. Compare the inventory first and select definitions, or narrow the scope.`)
  }
  async function detail(driver: Reader, scope: CompareScope, object?: CatalogObject) {
    if (!object || inventoryOnly) return {}
    budget()
    let detail: ObjectDetail | undefined
    let error: string | undefined
    try { detail = (await driver.explore(scope.sessionId, object)).detail }
    catch (cause) { error = (cause as Error).message }
    budget()
    bytes += Buffer.byteLength(JSON.stringify(detail ?? ''))
    if (bytes > 4_000_000) throw new Error('Comparison metadata exceeds 4 MB. Select fewer definitions.')
    return { detail, error }
  }
  const objects: ComparedObject[] = []
  for (const id of keys) {
    if (!selected.has(id)) continue
    const l = left.entries.get(id), r = right.entries.get(id), object = (l ?? r)!
    const from = await detail(source, request.source, l)
    const to = await detail(target, request.target, r)
    const unknown = !inventoryOnly && (l && !complete(from.detail) || r && !complete(to.detail))
    const status = unknown ? 'unknown' : !l ? 'target-only' : !r ? 'source-only' :
      inventoryOnly ? 'unchecked' : signature(from.detail!) === signature(to.detail!) ? 'matching' : 'changed'
    const item: ComparedObject = {
      key: id, name: object.name, kind: object.kind, parent: object.parent, signature: object.signature,
      status, source: from.detail, target: to.detail, notices: [], sql: [], destructiveSql: []
    }
    if (inventoryOnly) item.notices.push('Inventory only. Compare this object’s definition before planning changes.')
    else {
      if (unknown) item.notices.push('Unreadable or incomplete definition or metadata. No SQL suggestions are generated.', ...[from.error, to.error].filter((value): value is string => Boolean(value)))
      if (status === 'changed' && from.detail && to.detail) {
        const before = new Map(from.detail.sections.map(section => [section.title, section]))
        const after = new Map(to.detail.sections.map(section => [section.title, section]))
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(title => JSON.stringify(before.get(title)) !== JSON.stringify(after.get(title)))
        if (changed.length) item.notices.push(`Different metadata sections: ${changed.join(', ')}.`)
        if (from.detail.definition.sql !== to.detail.definition.sql) item.notices.push('Definition text differs. Review both definitions, including namespace qualifiers and formatting.')
      }
      suggestions(item, a.engine, request.target)
    }
    if (item.destructiveSql.length && r) {
      budget()
      try {
        const refs = (await target.explore(request.target.sessionId, undefined, undefined, { incoming: r })).incoming
        if (!refs) throw new Error('Foreign-key metadata is unavailable.')
        item.requiredDrops = refs.map(reference => ({
          key: inScope({ ...r, ...reference }, request.target) ?
            JSON.stringify(['table', reference.name, '', '']) : 'outside:' + JSON.stringify(reference),
          name: [reference.catalog, reference.schema, reference.name].filter(Boolean).join('.')
        }))
      } catch (cause) {
        item.destructiveSql = []
        item.notices.push(`Drop withheld because referencing tables could not be verified. ${(cause as Error).message}`)
      }
      budget()
    }
    objects.push(item)
  }
  const identities = (entries: Map<string, CatalogObject>) => JSON.stringify([...entries.values()].map(objectKey).sort())
  if (identities((await inventory(source, request.source)).entries) !== identities(left.entries) ||
      identities((await inventory(target, request.target)).entries) !== identities(right.entries)) {
    throw new Error('The catalog changed during comparison. Refresh and compare again.')
  }
  const label = (session: SessionInfo, scope: CompareScope) =>
    `${session.name} / ${session.host}${session.port ? ':' + session.port : ''} / ${session.database} / ${scope.catalog ? scope.catalog + '.' : ''}${scope.schema}`
  return {
    engine: a.engine, mode: inventoryOnly ? 'inventory' : 'definitions', source: request.source, target: request.target,
    sourceLabel: label(a, request.source), targetLabel: label(b, request.target), objects, fetchedAt: new Date().toISOString(),
    notices: [
      inventoryOnly ? 'Presence is based on complete visible inventories for the selected scope. Objects on both sides still need definition review.' : 'Matching means the exposed metadata and definition text agree. Whitespace, namespace qualifiers and generated names can appear as differences.',
      'Metadata comes from sequential live reads. Permissions and concurrent DDL affect what each connection sees. Refresh before acting on a result.',
      ...(!inventoryOnly ? ['Drop ordering uses visible foreign keys read from the target. Check privileges, hidden references, views and triggers before running SQL. SQLite can apply foreign-key actions to rows when dropping a table.'] : []),
      ...(!left.entries.size ? ['No source objects matched. Verify the namespace, filter and permissions before considering target-only drops.'] : []),
      ...(['sqlite', 'duckdb'].includes(a.engine) ? ['Attached databases and temporary objects belong to the original sessions. Establish that context explicitly before running exported SQL.'] : []),
      `Source: ${left.notice}`, `Target: ${right.notice}`
    ]
  }
}
