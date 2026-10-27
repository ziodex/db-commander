import { z } from 'zod'
import type { Cell, DatabaseEngine, SessionInfo } from './contracts'
import { parametersSchema } from './parameters'

export const explainRequestSchema = z.object({ sessionId: z.string().uuid(), sql: z.string().trim().min(1).max(1_000_000), mode: z.enum(['estimated', 'analyze']), executionConfirmed: z.boolean().default(false), parameters: parametersSchema.optional() }).strict()
export type ExplainRequest = z.infer<typeof explainRequestSchema>
export const PLAN_LIMIT = 1_000_000
export interface PlanOutput { columns: string[]; rows: Cell[][] }
export interface ExplainResult {
  capturedAt: string; engine: DatabaseEngine; mode: ExplainRequest['mode']; sql: string; submittedSql: string[]
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'; message: string; durationMs: number; session: SessionInfo
  source: 'session' | 'separate-connection'; format: 'json' | 'xml' | 'text' | 'table'; raw: string; output: PlanOutput
}
export const planFormat = (engine: DatabaseEngine): ExplainResult['format'] => ['postgres','mysql','mariadb'].includes(engine) ? 'json' : ['sqlserver','azure-sql'].includes(engine) ? 'xml' : engine === 'sqlite' ? 'table' : 'text'
export const separatePlanConnection = (engine: DatabaseEngine) => ['sqlserver','azure-sql','oracle'].includes(engine)

interface PgPlanNode { id: number; parent?: number; depth: number; type: string; relation?: string; estimatedRows?: number; cost?: number; actualRows?: number; loops?: number; time?: number; details: Record<string, unknown> }
interface PgPlan { nodes: PgPlanNode[]; planningTime?: number; executionTime?: number; notice?: string }
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
/** Bounded, iterative extraction. Unknown server fields remain inspectable. */
export function postgresPlan(raw: string): PgPlan {
  if (raw.length > PLAN_LIMIT) throw new Error('Plan exceeds the display limit.')
  const parsed = JSON.parse(raw), document = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined
  if (!document?.Plan || typeof document.Plan !== 'object' || Array.isArray(document.Plan)) throw new Error('Unrecognized PostgreSQL JSON plan. Use Raw plan to inspect it.')
  const nodes: PgPlanNode[] = [], pending = [{ value: document.Plan, parent: undefined as number | undefined, depth: 0 }]
  let limited = false
  while (pending.length) {
    const { value, parent, depth } = pending.pop()!
    if (nodes.length >= 1000 || depth > 100) { limited = true; continue }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value['Node Type'] !== 'string') throw new Error('Unrecognized plan node. Use Raw plan to inspect it.')
    const { Plans, ...details } = value, id = nodes.length
    nodes.push({ id, parent, depth, type: value['Node Type'], relation: typeof value['Relation Name'] === 'string' ? value['Relation Name'] : undefined,
      estimatedRows: numeric(value['Plan Rows']), cost: numeric(value['Total Cost']), actualRows: numeric(value['Actual Rows']), loops: numeric(value['Actual Loops']), time: numeric(value['Actual Total Time']), details })
    if (Plans !== undefined && !Array.isArray(Plans)) throw new Error('Unrecognized child plans. Use Raw plan to inspect them.')
    if (Plans) for (let i = Plans.length - 1; i >= 0; i--) pending.push({ value: Plans[i], parent: id, depth: depth + 1 })
  }
  return { nodes, planningTime: numeric(document['Planning Time']), executionTime: numeric(document['Execution Time']), notice: limited ? 'Tree display limited to 1,000 nodes and 100 levels. Raw plan contains the complete captured output.' : undefined }
}
