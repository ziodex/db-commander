import { z } from 'zod'
import { gridTableSchema, idSchema, type Cell, type GridColumn, type GridRequest, type SessionInfo } from './contracts'
import { parametersSchema } from './parameters'

const file = z.string().min(1).max(4096)
const identifier = z.string().min(1).max(255).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Use a nonempty identifier without control characters.')
export const insertTargetSchema = z.object({ name: identifier, schema: identifier.optional() }).strict()
export type InsertTarget = z.infer<typeof insertTargetSchema>
const exportFormatSchema = z.enum(['csv', 'tsv', 'json', 'sql'])
export type ExportFormat = z.infer<typeof exportFormatSchema>
export const importSourceSchema = z.object({ sessionId: idSchema, table: gridTableSchema, file, format: z.enum(['csv', 'tsv', 'json']) }).strict()
export const transferRequestSchema = z.discriminatedUnion('action', [
  importSourceSchema.extend({ action: z.literal('import'), mapping: z.array(z.string().min(1).max(255).nullable()).min(1).max(100), signature: z.string().length(64), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('export'), sessionId: idSchema, sql: z.string().trim().min(1).max(1_000_000), parameters: parametersSchema.optional(), file, format: exportFormatSchema, insertTarget: insertTargetSchema.optional(), confirmed: z.literal(true) }).strict().refine(value => value.format === 'sql' ? Boolean(value.insertTarget) : !value.insertTarget, 'SQL INSERT export requires a destination table; other formats do not accept one.')
])
export type ImportSource = z.infer<typeof importSourceSchema>
export type TransferRequest = z.infer<typeof transferRequestSchema>
export type ImportRequest = Extract<TransferRequest, { action: 'import' }>
export interface ImportPreview { headers: string[]; rows: Cell[][]; columns: GridColumn[]; signature: string }
// These operations are private to the driver host, never accepted by editGrid IPC.
export type GridOperation = GridRequest | (ImportSource & { action: 'inspect-import' }) | ImportRequest | import('./data-compare').DataCaptureRequest
export interface ImportContext { signal: AbortSignal; progress(rows: number): void }
export interface TransferJob {
  id: string; sessionId: string; action: 'import' | 'export'; file: string; rows: number
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; phase: string
  cancellationRequested?: boolean; session?: SessionInfo
}
