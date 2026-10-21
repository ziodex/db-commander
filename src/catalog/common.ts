import type { Cell } from '../shared/contracts'
import { constraintKinds, objectKey, type CatalogObject, type CatalogResponse, type CatalogSection, type CatalogSnapshot, type ObjectDetail } from '../shared/catalog'
export type CatalogQuery = (sql: string, values?: Cell[]) => Promise<Cell[][]>
export interface CatalogAdapter { list(): Promise<CatalogSnapshot>; detail(object: CatalogObject): Promise<Pick<ObjectDetail, 'sections' | 'definition'>> }
export const LIMIT = 2000
export function catalog(rows: Cell[][], notice: string): CatalogSnapshot {
  return { objects: rows.slice(0, LIMIT).map(row => ({ catalog: row[0] ?? undefined, schema: row[1]!, name: row[2]!, kind: row[3] as CatalogObject['kind'], identity: row[4]!, parent: row[5] ?? undefined, signature: row[6]?.slice(0, 2048), constraintType: row[3] === 'constraint' ? constraintKinds.find(type => type === row[7]?.toLowerCase()) ?? 'other' : undefined })), truncated: rows.length > LIMIT, notice }
}
export function section(title: string, columns: string[], rows: Cell[][]): CatalogSection {
  return { title, columns, rows: rows.slice(0, 500).map(row => row.map(value => value === null ? null : value.slice(0, 32768))), truncated: rows.length > 500 || rows.some(row => row.some(value => value !== null && value.length > 32768)) }
}
export function definition(sql: string | null | undefined, source: 'native' | 'generated' = 'native', notice?: string): ObjectDetail['definition'] {
  return sql ? { sql: sql.slice(0, 1_000_000), source, notice, truncated: sql.length > 1_000_000 } : { sql: null, source: 'unavailable', notice: notice ?? 'The server did not expose a definition. The object may be internal, encrypted, or require additional metadata privileges.' }
}
export async function inspect(adapter: CatalogAdapter, object?: CatalogObject, source: ObjectDetail['source'] = 'catalog-connection'): Promise<CatalogResponse> {
  const snapshot = await adapter.list()
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
