import type { CatalogObject } from '../shared/catalog'
import type { SchemaTable } from '../shared/contracts'

const relationKinds = new Set(['table', 'view', 'materialized view'])
const childKinds = new Set(['index', 'constraint', 'trigger'])
const keyKinds = new Set(['primary key', 'foreign key', 'unique'])
const titles: Record<string, string> = { index: 'Indexes', constraint: 'Constraints', trigger: 'Triggers', function: 'Functions', procedure: 'Procedures', sequence: 'Sequences', macro: 'Macros', package: 'Packages', type: 'Types' }
export interface ObjectCollection { title: string; objects: CatalogObject[] }
interface ExplorerRelation { key: string; table: SchemaTable; object?: CatalogObject; collections: ObjectCollection[] }
export interface ExplorerGroup { key: string; label: string; relations: ExplorerRelation[]; collections: ObjectCollection[] }
const schemaKey = (object: SchemaTable) => JSON.stringify([object.catalog ?? '', object.schema])
const relationKey = (object: SchemaTable) => JSON.stringify([object.catalog ?? '', object.schema, object.name])
function collections(objects: CatalogObject[]): ObjectCollection[] {
  const groups = new Map<string, CatalogObject[]>()
  for (const object of objects) {
    const title = object.kind === 'constraint' && keyKinds.has(object.constraintType ?? '') ? 'Keys' : titles[object.kind] ?? object.kind
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title)!.push(object)
  }
  const order = ['Indexes', 'Keys', 'Constraints', 'Triggers']
  return [...groups].map(([title, objects]) => ({ title, objects: objects.sort((a, b) => a.name.localeCompare(b.name) || a.identity.localeCompare(b.identity)) }))
    .sort((a, b) => (order.includes(a.title) ? order.indexOf(a.title) : 4) - (order.includes(b.title) ? order.indexOf(b.title) : 4) || a.title.localeCompare(b.title))
}

/** Match full namespaces, retaining parent context when a child matches a filter. */
export function explorerTree(objects: CatalogObject[], fallback: SchemaTable[], search = '', kind = 'all'): ExplorerGroup[] {
  const relations = new Map<string, ExplorerRelation>(), children = new Map<string, CatalogObject[]>()
  for (const table of fallback) if (relationKinds.has(table.kind)) relations.set(relationKey(table), { key: relationKey(table), table, collections: [] })
  for (const object of objects) if (relationKinds.has(object.kind)) relations.set(relationKey(object), { key: relationKey(object), table: object, object, collections: [] })
  const needle = search.trim().toLowerCase()
  const matches = (object: SchemaTable & { parent?: string; signature?: string; constraintType?: string }) =>
    (kind === 'all' || kind === object.kind) && [object.catalog, object.schema, object.name, object.parent, object.signature, object.constraintType].filter(Boolean).join('.').toLowerCase().includes(needle)
  const groups = new Map<string, ExplorerGroup>(), standalone: CatalogObject[] = []
  function group(object: SchemaTable) {
    const key = schemaKey(object)
    if (!groups.has(key)) groups.set(key, { key, label: object.catalog ? `${object.catalog}.${object.schema}` : object.schema, relations: [], collections: [] })
    return groups.get(key)!
  }
  for (const object of objects) {
    if (relationKinds.has(object.kind) || !matches(object)) continue
    const parent = object.parent !== undefined && childKinds.has(object.kind) ? relationKey({ ...object, name: object.parent }) : undefined
    if (parent && relations.has(parent)) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent)!.push(object)
    } else standalone.push(object) // A bounded or permission-limited catalog may omit the owner.
  }
  for (const relation of relations.values()) {
    relation.collections = collections(children.get(relation.key) ?? [])
    if (matches(relation.table) || relation.collections.length) group(relation.table).relations.push(relation)
  }
  for (const object of standalone) group(object)
  for (const value of groups.values()) {
    value.relations.sort((a, b) => a.table.name.localeCompare(b.table.name))
    value.collections = collections(standalone.filter(object => schemaKey(object) === value.key))
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}
