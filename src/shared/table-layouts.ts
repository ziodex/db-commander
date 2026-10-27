import { z } from 'zod'
import type { ConnectionProfile, GridSnapshot, GridTable, SessionInfo } from './contracts'
import { tableColumnLayoutSchema } from './column-layout'

export const MAX_TABLE_LAYOUTS = 100
export const MAX_TABLE_LAYOUT_CHARACTERS = 1_000_000
export const savedTableLayoutSchema = z.object({
  key: z.string().min(1).max(16384),
  columns: z.array(z.object({ name: z.string().min(1).max(255), type: z.string().max(2048) }).strict()).min(1).max(100),
  layout: tableColumnLayoutSchema
}).strict().refine(entry => entry.columns.length === entry.layout.order.length, 'The column layout must match its table metadata.')
export type SavedTableLayout = z.infer<typeof savedTableLayoutSchema>
export const tableLayoutsSchema = z.array(savedTableLayoutSchema).max(MAX_TABLE_LAYOUTS).superRefine((entries, context) => {
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) context.addIssue({ code: 'custom', message: 'Saved table layout keys must be unique.' })
  if (JSON.stringify(entries).length > MAX_TABLE_LAYOUT_CHARACTERS) context.addIssue({ code: 'custom', message: 'Saved table layouts exceed the storage budget.' })
})

/** Build identity from explicit non-secret fields, never from a whole connection object. */
export function tableLayoutKey(profile: ConnectionProfile, session: SessionInfo, table: GridTable, connectionDatabase?: string): string | undefined {
  if (profile.engine !== session.engine) return
  const embedded = session.engine === 'sqlite' || session.engine === 'duckdb'
  if (embedded) {
    if (session.host === ':memory:' || (session.engine === 'sqlite' ? profile.sqliteMode : profile.duckdbMode) === 'memory') return
    // An attachment alias does not identify its file reliably across connections.
    if (session.engine === 'sqlite' && table.schema !== 'main') return
    if (session.engine === 'duckdb' && (!connectionDatabase || (table.catalog ?? session.database) !== connectionDatabase)) return
  }
  const ssh = profile.ssh
  return JSON.stringify([1, session.engine,
    embedded ? ['file', session.host] : ['server', profile.host, profile.port, session.user, profile.authentication ?? 'sql-password',
      ssh ? [ssh.host, ssh.port, ssh.user, ssh.fingerprint, ssh.destinationHost ?? profile.host] : null],
    embedded ? connectionDatabase ?? session.database : session.database,
    table.catalog ?? null, table.schema, table.name])
}

export const tableColumns = (grid: Pick<GridSnapshot, 'columns'>) => grid.columns.map(({ name, type }) => ({ name, type }))
export const tableColumnViewKey = (session: SessionInfo | null, grid: GridSnapshot) => `table:${JSON.stringify([session?.id, session?.database, [grid.table.catalog ?? null, grid.table.schema, grid.table.name], tableColumns(grid)])}`
export function matchingTableLayout(entry: SavedTableLayout | undefined, grid: Pick<GridSnapshot, 'columns'>) {
  return entry && JSON.stringify(entry.columns) === JSON.stringify(tableColumns(grid)) ? entry.layout : undefined
}
export function saveTableLayout(entries: SavedTableLayout[] = [], value: SavedTableLayout): SavedTableLayout[] {
  const clean = savedTableLayoutSchema.parse(value)
  const next = [...entries.filter(entry => entry.key !== clean.key), clean].slice(-MAX_TABLE_LAYOUTS)
  while (JSON.stringify(next).length > MAX_TABLE_LAYOUT_CHARACTERS) next.shift()
  return next
}
/** Only disk recovery is tolerant; IPC writes validate every entry strictly. */
export function recoverTableLayouts(value: unknown): SavedTableLayout[] {
  if (!Array.isArray(value)) return []
  let entries: SavedTableLayout[] = []
  for (const candidate of value.slice(-MAX_TABLE_LAYOUTS)) {
    const parsed = savedTableLayoutSchema.safeParse(candidate)
    if (parsed.success) entries = saveTableLayout(entries, parsed.data)
  }
  return entries
}
