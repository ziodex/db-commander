import { incomingKeys } from './incoming-keys'
import type { Cell, DatabaseEngine } from '../shared/contracts'
import { CATALOG_PAGE_SIZE, constraintKinds, objectKey, type CatalogObject, type CatalogPage, type CatalogResponse, type CatalogSection, type CatalogSnapshot, type ObjectDetail } from '../shared/catalog'
import type { CatalogRead } from './paging'
export type CatalogQuery = (sql: string, values?: Cell[]) => Promise<Cell[][]>
export interface CatalogAdapter { list(read?: CatalogRead): Promise<CatalogSnapshot>; detail(object: CatalogObject): Promise<Pick<ObjectDetail, 'sections' | 'definition'>> }
export const LIMIT = 2000
export function catalog(rows: Cell[][], notice: string, limit = LIMIT): CatalogSnapshot {
  return { objects: rows.slice(0, limit).map(row => ({ catalog: row[0] ?? undefined, schema: row[1]!, name: row[2]!, kind: row[3] as CatalogObject['kind'], identity: row[4]!, parent: row[5] ?? undefined, signature: row[6]?.slice(0, 2048), constraintType: row[3] === 'constraint' ? constraintKinds.find(type => type === row[7]?.toLowerCase()) ?? 'other' : undefined })), truncated: rows.length > limit, notice }
}
/** Internal comparisons can request a bounded inventory without public pager context. */
export async function readCatalog(adapter: CatalogAdapter, query: CatalogQuery, engine: DatabaseEngine, read: CatalogRead, source: ObjectDetail['source']): Promise<CatalogResponse> {
  if (read.incoming) {
    const object = (await adapter.list({ object: read.incoming })).objects.find(item => objectKey(item) === objectKey(read.incoming!))
    if (object?.kind !== 'table') throw new Error('The table is no longer visible. Refresh the comparison.')
    return { incoming: await incomingKeys(query, engine, object) }
  }
  if (read.inventory) return { catalog: await adapter.list(read) }
  return { page: await catalogPage(adapter, read, source) }
}
export async function catalogPage(adapter: CatalogAdapter, read: CatalogRead, source: ObjectDetail['source']): Promise<CatalogPage> {
  if (read.parent) {
    if (!['table', 'view', 'materialized view'].includes(read.parent.kind) || !(await adapter.list({ object: read.parent })).objects.some(o => objectKey(o) === objectKey(read.parent!))) throw new Error('The parent object is no longer visible. Refresh the catalog and select it again.')
  }
  const snapshot = await adapter.list({ ...read, limit: CATALOG_PAGE_SIZE })
  const objects = read.cursor?.direction === 'before' ? snapshot.objects.reverse() : snapshot.objects
  const moreBefore = read.cursor?.direction === 'before' ? snapshot.truncated : Boolean(read.cursor)
  const moreAfter = read.cursor?.direction === 'before' ? Boolean(read.cursor) : snapshot.truncated
  const parents = new Map(objects.filter(o => o.parent && ['index', 'constraint', 'trigger'].includes(o.kind)).map(o => [JSON.stringify([o.catalog, o.schema, o.parent]), { catalog: o.catalog, schema: o.schema, name: o.parent! }]))
  const context = !read.parent && parents.size ? (await adapter.list({ relations: [...parents.values()], limit: CATALOG_PAGE_SIZE })).objects : undefined
  return { objects, parents: context, previous: moreBefore ? objects[0] : undefined, next: moreAfter ? objects.at(-1) : undefined, notice: snapshot.notice, source, fetchedAt: new Date().toISOString() }
}
export function section(title: string, columns: string[], rows: Cell[][]): CatalogSection {
  return { title, columns, rows: rows.slice(0, 500).map(row => row.map(value => value === null ? null : value.slice(0, 32768))), truncated: rows.length > 500 || rows.some(row => row.some(value => value !== null && value.length > 32768)) }
}
export function definition(sql: string | null | undefined, source: 'native' | 'generated' = 'native', notice?: string): ObjectDetail['definition'] {
  return sql ? { sql: sql.slice(0, 1_000_000), source, notice, truncated: sql.length > 1_000_000 } : { sql: null, source: 'unavailable', notice: notice ?? 'The server did not expose a definition. The object may be internal, encrypted, or require additional metadata privileges.' }
}
export async function inspect(adapter: CatalogAdapter, object?: CatalogObject, source: ObjectDetail['source'] = 'catalog-connection'): Promise<CatalogResponse> {
  const snapshot = await adapter.list(object ? { object } : undefined)
  if (!object) return { catalog: snapshot }
  const current = snapshot.objects.find(candidate => objectKey(candidate) === objectKey(object))
  if (!current) throw new Error('This object is no longer visible in the catalog. Refresh schema and select it again.')
  const detail = await adapter.detail(current)
  let remaining = 2_000_000
  for (const section of detail.sections) {
    const rows: Cell[][] = []
    for (const row of section.rows) {
      const size = row.reduce((total, cell) => total + (cell?.length ?? 0), 0)
      if (size > remaining) { section.truncated = true; break }
      rows.push(row); remaining -= size
    }
    section.rows = rows
  }
  if (detail.definition.source === 'generated' && detail.sections.some(section => section.truncated)) detail.definition.truncated = true
  return { detail: { object: current, ...detail, fetchedAt: new Date().toISOString(), source } }
}
