import type { SchemaObject, SchemaSnapshot } from '../shared/contracts'

export const SCHEMA_ROW_LIMIT = 10000
/** Catalog rows only: catalog, schema, object, kind, column, type, nullable, ordinal. */
export function schemaSnapshot(rows: unknown[][], database: string, source: SchemaSnapshot['source']): SchemaSnapshot {
  const objects = new Map<string, SchemaObject>()
  let truncated = rows.length > SCHEMA_ROW_LIMIT
  for (const row of rows.slice(0, SCHEMA_ROW_LIMIT)) {
    const catalog = row[0] == null ? undefined : String(row[0]), schema = String(row[1]), name = String(row[2])
    const key = JSON.stringify([catalog, schema, name])
    let object = objects.get(key)
    if (!object) {
      if (objects.size >= 2000) { truncated = true; break }
      object = { catalog, schema, name, kind: String(row[3]).toLowerCase().includes('view') ? 'view' : 'table', columns: [] }
      objects.set(key, object)
    }
    if (row[4] != null) object.columns.push({ name: String(row[4]), type: String(row[5] ?? '').slice(0, 512), nullable: ['YES', 'true', '1'].includes(String(row[6])), ordinal: Number(row[7]) })
  }
  return { objects: [...objects.values()], database, source, fetchedAt: new Date().toISOString(), truncated }
}
