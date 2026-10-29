import { z } from 'zod'
import { catalogObjectSchema } from './catalog'
import { idSchema, type DatabaseEngine, type SessionInfo } from './contracts'

const name = z.string().min(1).max(255).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Names must not contain control characters.')
const location = z.object({ schema: name, catalog: name.optional() }).strict()
export const columnTypes = ['integer', 'bigint', 'varchar', 'text', 'decimal', 'boolean', 'date', 'timestamp'] as const
const defaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(), z.object({ kind: z.literal('null') }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().max(4000).refine(value => !value.includes('\0'), 'NUL is not supported in defaults.') }).strict(),
  z.object({ kind: z.literal('number'), value: z.string().max(100).regex(/^-?\d+(?:\.\d+)?$/) }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('expression'), value: z.string().min(1).max(4000) }).strict()
])
const generationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('identity'), mode: z.enum(['always', 'by-default', 'auto']), unique: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('computed'), expression: z.string().min(1).max(4000), storage: z.enum(['virtual', 'stored']) }).strict()
])
export const schemaColumnSchema = z.object({ name, type: z.enum(columnTypes), length: z.number().int().min(1).max(4000).default(255), precision: z.number().int().min(1).max(38).default(18), scale: z.number().int().min(0).max(38).default(2), nullable: z.boolean(), primaryKey: z.boolean().default(false), default: defaultSchema.default({ kind: 'none' }), generation: generationSchema.optional() }).strict()
export type SchemaColumnInput = z.infer<typeof schemaColumnSchema>
const schemaChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-schema'), location }).strict(),
  z.object({ action: z.literal('create-table'), location, name, columns: z.array(schemaColumnSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal('add-column'), target: catalogObjectSchema, column: schemaColumnSchema }).strict(),
  z.object({ action: z.literal('rename-column'), target: catalogObjectSchema, column: name, name }).strict(),
  z.object({ action: z.literal('drop-column'), target: catalogObjectSchema, column: name }).strict(),
  z.object({ action: z.literal('rename-table'), target: catalogObjectSchema, name }).strict(),
  z.object({ action: z.literal('drop-table'), target: catalogObjectSchema }).strict(),
  z.object({ action: z.literal('create-index'), target: catalogObjectSchema, name, columns: z.array(name).min(1).max(16), unique: z.boolean() }).strict(),
  z.object({ action: z.literal('drop-index'), target: catalogObjectSchema }).strict()
])
export type SchemaChange = z.infer<typeof schemaChangeSchema>
export const prepareSchemaChangeSchema = z.object({ sessionId: idSchema, change: schemaChangeSchema }).strict()
export type PrepareSchemaChange = z.infer<typeof prepareSchemaChangeSchema>
export const applySchemaChangeSchema = z.object({ sessionId: idSchema, planId: idSchema, confirmed: z.literal(true), implicitCommitApproved: z.boolean(), destructiveApproved: z.boolean() }).strict()
export type ApplySchemaChange = z.infer<typeof applySchemaChangeSchema>
export interface SchemaChangePlan {
  migrationSourceId?: string;
  id: string; sessionId: string; engine: DatabaseEngine; database: string; connection: string;
  sql: string; transaction: 'transactional' | 'implicit-commit'; destructive: boolean;
  warnings: string[]; expiresAt: string
}
export interface SchemaChangeResult {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'; message: string; session: SessionInfo;
  executedSql: string; durationMs: number
}
export const schemaActions: Record<SchemaChange['action'], string> = {
  'create-schema': 'Create schema', 'create-table': 'Create table', 'add-column': 'Add column',
  'rename-column': 'Rename column', 'drop-column': 'Drop column', 'rename-table': 'Rename table',
  'drop-table': 'Drop table', 'create-index': 'Create index', 'drop-index': 'Drop index'
}
export function transactionalDdl(engine: DatabaseEngine) { return !['mysql', 'mariadb', 'oracle'].includes(engine) }
export function supportsCreateSchema(engine: DatabaseEngine) { return ['postgres', 'sqlserver', 'azure-sql', 'duckdb'].includes(engine) }
