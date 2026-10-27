import { z } from 'zod'
import { engineSchema, idSchema } from './contracts'

const activityActionSchema = z.enum(['cancel', 'terminate'])
export type ActivityAction = z.infer<typeof activityActionSchema>
export const prepareActivityActionSchema = z.object({ sessionId: idSchema, targetId: z.string().min(1).max(128), action: activityActionSchema }).strict()
export const applyActivityActionSchema = z.object({ sessionId: idSchema, reviewId: idSchema, confirmation: z.string().max(160), acknowledge: z.literal(true) }).strict()
export type PrepareActivityAction = z.infer<typeof prepareActivityActionSchema>
export type ApplyActivityAction = z.infer<typeof applyActivityActionSchema>
export interface ActivityActionReview {
  id: string; sessionId: string; engine: z.infer<typeof engineSchema>; connection: string; database: string
  action: ActivityAction; targetId: string; user: string; client: string; targetDatabase: string
  identity: string[]; statement: string[] | null; transaction: string | null
  sql: string; confirmation: string; warnings: string[]; expiresAt: string
}
export interface ActivityActionResult { status: 'requested' | 'not-applied' | 'rejected' | 'unknown'; message: string; rollback?:import('./rollback').RollbackSnapshot }
export function activityControlLimit(engine: z.infer<typeof engineSchema>, action: ActivityAction): string | undefined {
  if (engine === 'sqlite' || engine === 'duckdb') return 'Embedded connections have no server administration API. Use Stop, Commit/Rollback and Disconnect in the owning tab.'
  if (action === 'cancel' && (engine === 'sqlserver' || engine === 'azure-sql')) return 'This engine has no remote query-only cancellation API. Use Stop in the owning tab, or separately review session termination.'
}
