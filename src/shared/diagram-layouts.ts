import { z } from 'zod'
import type { CatalogObject } from './catalog'
import type { ConnectionProfile, GridTable, SessionInfo } from './contracts'
import { DIAGRAM_TABLE_LIMIT, tableKey } from './diagram'
import { tableLayoutKey } from './table-layouts'

export const DIAGRAM_LAYOUT_LIMIT = 20
const DIAGRAM_LAYOUT_BYTES = 512_000
const pointSchema = z.object({ x: z.number().min(0).max(50_000), y: z.number().min(0).max(50_000) }).strict()
const layoutTableSchema = z.object({
  table: z.object({ catalog: z.string().max(255).optional(), schema: z.string().min(1).max(255), name: z.string().min(1).max(255) }).strict(),
  position: pointSchema
}).strict()
export const diagramLayoutSchema = z.object({
  scope: z.string().min(1).max(16_384),
  name: z.string().trim().min(1).max(80),
  tables: z.array(layoutTableSchema).min(1).max(DIAGRAM_TABLE_LIMIT),
  showColumns: z.boolean(),
  zoom: z.number().min(.001).max(2.5)
}).strict().refine(layout => new Set(layout.tables.map(({ table }) => tableKey(table))).size === layout.tables.length,
  'Diagram layout table identities must be unique.')
export type SavedDiagramLayout = z.infer<typeof diagramLayoutSchema>
export const diagramLayoutId = (layout: Pick<SavedDiagramLayout, 'scope' | 'name'>) => JSON.stringify([layout.scope, layout.name])
export const diagramLayoutsSchema = z.array(diagramLayoutSchema).max(DIAGRAM_LAYOUT_LIMIT)
  .refine(layouts => new Set(layouts.map(diagramLayoutId)).size === layouts.length, 'Saved diagram layout names must be unique within their connection scope.')
  .refine(layouts => new TextEncoder().encode(JSON.stringify(layouts)).length <= DIAGRAM_LAYOUT_BYTES, 'Saved diagram layouts exceed the workspace storage limit.')

export function diagramLayoutScope(profile: ConnectionProfile, session: SessionInfo, connectionDatabase?: string) {
  return tableLayoutKey(profile, session, {
    catalog: session.engine === 'duckdb' ? session.database : undefined, schema: 'main', name: ''
  }, connectionDatabase)
}

export function resolveLayoutTables(layout: SavedDiagramLayout, objects: CatalogObject[]) {
  const tables = layout.tables.map(({ table }) => {
    const matches = objects.filter(object => object.kind === 'table' && tableKey(object) === tableKey(table))
    if (matches.length !== 1) throw new Error('A saved table is unavailable in this catalog. Refresh the diagram or select a different layout.')
    return matches[0]
  })
  return tables
}

export function layoutHasTables(layout: SavedDiagramLayout, tables: GridTable[]) {
  const keys = new Set(tables.map(tableKey))
  return keys.size === layout.tables.length && layout.tables.every(({ table }) => keys.has(tableKey(table)))
}

export function recoverDiagramLayouts(value: unknown): SavedDiagramLayout[] {
  if (!Array.isArray(value)) return []
  const layouts = new Map<string, SavedDiagramLayout>()
  for (const candidate of value.slice(0, DIAGRAM_LAYOUT_LIMIT)) {
    const parsed = diagramLayoutSchema.safeParse(candidate)
    if (parsed.success) layouts.set(diagramLayoutId(parsed.data), parsed.data)
  }
  const checked = diagramLayoutsSchema.safeParse([...layouts.values()])
  return checked.success ? checked.data : []
}
