import type { Cell, DatabaseEngine, GridTable } from '../shared/contracts'
import type { CatalogObject, CatalogPageRequest } from '../shared/catalog'
import type { CatalogQuery } from './common'

/** Internal reads may retain the old bounded completion/diagram preview. */
export type CatalogRead = Omit<CatalogPageRequest, 'sessionId' | 'search' | 'rootsOnly'> & {
  search?: string; rootsOnly?: boolean; limit?: number; object?: CatalogObject; relations?: GridTable[]
  inventory?: boolean
  incoming?: CatalogObject
  namespace?: Pick<GridTable, 'schema' | 'catalog'>
  kinds?: CatalogObject['kind'][]
  nameContains?: string
}
const names = ['catalog_name', 'schema_name', 'kind', 'object_name', 'identity_name', 'parent_name']
const rank = (o: CatalogObject) => ['table', 'view', 'materialized view'].includes(o.kind) ? '0' : '1'

/** Every filter is bound; only fixed metadata expressions enter the SQL. The
 * cursor is a position, never object authority or a retained database snapshot. */
export async function catalogRows(query: CatalogQuery, engine: DatabaseEngine, sql: string, parameters: Cell[], read: CatalogRead = {}): Promise<Cell[][]> {
  const values = [...parameters], predicates: string[] = [], limit = read.object ? 1 : read.limit ?? 2000
  const bind = (value: Cell) => {
    values.push(value)
    return engine === 'postgres' ? `$${values.length}` : engine === 'oracle' ? `:${values.length}` : ['sqlserver', 'azure-sql'].includes(engine) ? `@p${values.length}` : '?'
  }
  const equal = (field: string, value: string | undefined) => value === undefined ? `${field} IS NULL` : `${field}=${bind(value)}`
  if (read.object) {
    const o = read.object
    predicates.push(...names.map((name, i) => equal(name, [o.catalog, o.schema, o.kind, o.name, o.identity, o.parent][i])))
  } else {
    if (read.relations) {
      predicates.push("kind IN ('table','view','materialized view')", '(' + read.relations.map(o => '(' + [equal('catalog_name', o.catalog), equal('schema_name', o.schema), equal('object_name', o.name)].join(' AND ') + ')').join(' OR ') + ')')
    }
    if (read.namespace) predicates.push(equal('catalog_name', read.namespace.catalog), equal('schema_name', read.namespace.schema))
    if (read.kinds?.length) predicates.push(`kind IN (${read.kinds.map(bind).join(',')})`)
    if (read.kind) predicates.push(`kind=${bind(read.kind)}`)
    if (read.rootsOnly) predicates.push('parent_name IS NULL')
    if (read.parent) {
      const o = read.parent
      predicates.push(equal('catalog_name', o.catalog), equal('schema_name', o.schema), equal('parent_name', o.name))
    }
    if (read.search || read.nameContains) {
      const wildcards = ['sqlserver', 'azure-sql'].includes(engine) ? /[!%_\[]/g : /[!%_]/g
      const search = '%' + (read.nameContains ?? read.search!).toLowerCase().replace(wildcards, c => '!' + c) + '%'
      const namespace = ['mysql', 'mariadb', 'sqlserver', 'azure-sql'].includes(engine)
        ? "CONCAT(COALESCE(CONCAT(catalog_name,'.'),''),schema_name,'.',object_name)"
        : "(CASE WHEN catalog_name IS NULL THEN '' ELSE catalog_name||'.' END)||schema_name||'.'||object_name"
      const fields = read.nameContains ? ['object_name'] : ['catalog_name', 'schema_name', 'object_name', 'parent_name', 'signature_name', 'constraint_type', namespace]
      predicates.push('(' + fields.map(name => `LOWER(${name}) LIKE ${bind(search)} ESCAPE '!'`).join(' OR ') + ')')
    }
  }
  const fill = engine === 'oracle' ? ' ' : ''
  // Binary ordering makes names differing only in case distinct on CI collations.
  const binary = (name: string) => ['sqlserver', 'azure-sql'].includes(engine) ? `${name} COLLATE Latin1_General_100_BIN2` : ['mysql', 'mariadb'].includes(engine) ? `BINARY ${name}` : name
  const order = ["CASE WHEN kind IN ('table','view','materialized view') THEN 0 ELSE 1 END", 'CASE WHEN catalog_name IS NULL THEN 0 ELSE 1 END', ...names.map(name => binary(`COALESCE(${name},'${fill}')`))]
  if (read.cursor && !read.object) {
    const o = read.cursor.object, position = [rank(o), o.catalog === undefined ? '0' : '1', o.catalog ?? fill, o.schema, o.kind, o.name, o.identity, o.parent ?? fill]
    const comparison = read.cursor.direction === 'before' ? '<' : '>'
    // These two values are fixed numeric ranks. Binding them as cell strings
    // would compare SQLite storage classes rather than numeric positions.
    const at = (index: number) => index < 2 ? position[index] : bind(position[index])
    predicates.push('(' + order.map((expression, index) => '(' + [...order.slice(0, index).map((field, i) => `${field}=${at(i)}`), `${expression}${comparison}${at(index)}`].join(' AND ') + ')').join(' OR ') + ')')
  }
  const reverse = read.cursor?.direction === 'before' && !read.object
  const top = ['sqlserver', 'azure-sql'].includes(engine) ? `TOP (${limit + 1}) ` : ''
  const tail = top ? '' : engine === 'oracle' ? ` FETCH FIRST ${limit + 1} ROWS ONLY` : ` LIMIT ${limit + 1}`
  return query(`SELECT ${top}* FROM (${sql}) objects${predicates.length ? ' WHERE ' + predicates.join(' AND ') : ''} ORDER BY ${order.map(field => field + (reverse ? ' DESC' : ' ASC')).join(',')}${tail}`, values)
}
