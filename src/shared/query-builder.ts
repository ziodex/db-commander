import { z } from 'zod'
import { gridTableSchema, idSchema, type DatabaseEngine } from './contracts'

const name = z.string().min(1).max(255).refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'Names cannot contain control characters.')
const builderColumnSchema = z.object({ source: z.number().int().min(0).max(4), column: name }).strict()
export type BuilderColumn = z.infer<typeof builderColumnSchema>
export const aggregates = ['none','count-all','count','count-distinct','sum','avg','min','max'] as const
export const builderOperators = ['eq','ne','lt','lte','gt','gte','like','is-null','not-null'] as const
const predicate = { operator: z.enum(builderOperators), parameter: z.string().max(64).default('') }
export const builderQuerySchema = z.object({
  sources: z.array(z.object({ table: gridTableSchema, join: z.object({ type: z.enum(['inner','left']), on: z.array(z.object({ left: builderColumnSchema, right: name }).strict()).min(1).max(8) }).strict().optional() }).strict()).min(1).max(5),
  projections: z.array(z.object({ column: builderColumnSchema.optional(), aggregate: z.enum(aggregates), alias: name }).strict()).min(1).max(32),
  filters: z.array(z.object({ column: builderColumnSchema, ...predicate }).strict()).max(16),
  filterLogic: z.enum(['and','or']),
  having: z.array(z.object({ projection: z.number().int().min(0).max(31), ...predicate }).strict()).max(8),
  havingLogic: z.enum(['and','or']),
  order: z.array(z.object({ projection: z.number().int().min(0).max(31), direction: z.enum(['asc','desc']) }).strict()).max(8),
  distinct: z.boolean(), limit: z.number().int().min(1).max(1000)
}).strict()
export type BuilderQuery = z.infer<typeof builderQuerySchema>
export const prepareBuilderSchema = z.object({ sessionId: idSchema, query: builderQuerySchema }).strict()
export type PrepareBuilder = z.infer<typeof prepareBuilderSchema>
export interface BuilderPreview { sql: string; parameters: string[]; warnings: string[]; engine: DatabaseEngine; database: string; fetchedAt: string }
export const emptyBuilder = (): BuilderQuery => ({ sources: [], projections: [], filters: [], filterLogic: 'and', having: [], havingLogic: 'and', order: [], distinct: false, limit: 1000 })
export const builderTableKey = (table: {catalog?:string;schema:string;name:string}) => JSON.stringify([table.catalog ?? '',table.schema,table.name])
