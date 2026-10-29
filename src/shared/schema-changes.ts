import { z } from 'zod'
import { catalogObjectSchema } from './catalog'
import { idSchema, type DatabaseEngine, type SessionInfo } from './contracts'

const name = z.string().min(1).max(255).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Names must not contain control characters.')
const location = z.object({ schema: name, catalog: name.optional() }).strict()
export const columnTypes = ['integer', 'bigint', 'varchar', 'text', 'decimal', 'boolean', 'date', 'timestamp'] as const
export const defaultSchema = z.discriminatedUnion('kind', [
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
const nativeTypeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: z.string().min(1).max(64), length: z.number().int().min(1).max(10485760).optional(), precision: z.number().int().min(1).max(1000).optional(), scale: z.number().int().min(-1000).max(1000).optional(), fractional: z.number().int().min(0).max(9).optional(), array: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('named'), catalog: name.optional(), schema: name, name, array: z.boolean().optional() }).strict()
])
export const schemaColumnSchema = z.object({ name, type: z.enum(columnTypes), nativeType: nativeTypeSchema.optional(), length: z.number().int().min(1).max(4000).default(255), precision: z.number().int().min(1).max(38).default(18), scale: z.number().int().min(0).max(38).default(2), nullable: z.boolean(), primaryKey: z.boolean().default(false), default: defaultSchema.default({ kind: 'none' }), generation: generationSchema.optional() }).strict()
export type SchemaColumnInput = z.infer<typeof schemaColumnSchema>
const columnTypeSchema = schemaColumnSchema.pick({ type: true, nativeType: true, length: true, precision: true, scale: true })
export type SchemaColumnType = z.infer<typeof columnTypeSchema>
const columnAlterationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('type'), type: columnTypeSchema, using: z.string().min(1).max(4000).optional() }).strict(),
  z.object({ kind: z.literal('nullability'), nullable: z.boolean() }).strict(),
  z.object({ kind: z.literal('default'), default: defaultSchema }).strict(),
  z.object({ kind: z.literal('identity-add'), mode: z.enum(['always', 'by-default']) }).strict(),
  z.object({ kind: z.literal('identity-mode'), mode: z.enum(['always', 'by-default']) }).strict(),
  z.object({ kind: z.literal('identity-drop') }).strict(),
  z.object({ kind: z.literal('generated-expression'), expression: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('generated-drop') }).strict()
])
export type ColumnAlteration = z.infer<typeof columnAlterationSchema>
const referenceAction = z.enum(['no-action', 'restrict', 'cascade', 'set-null', 'set-default'])
export const tableConstraintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('check'), name, expression: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('unique'), name, columns: z.array(name).min(1).max(16) }).strict(),
  z.object({ kind: z.literal('foreign'), name, columns: z.array(name).min(1).max(16), reference: z.discriminatedUnion('kind', [z.object({ kind: z.literal('self') }).strict(), z.object({ kind: z.literal('table'), table: catalogObjectSchema }).strict()]), referencedColumns: z.array(name).min(1).max(16), onDelete: referenceAction, onUpdate: referenceAction }).strict()
])
export type TableConstraint = z.infer<typeof tableConstraintSchema>
const schemaChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-schema'), location }).strict(),
  z.object({ action: z.literal('create-table'), location, name, columns: z.array(schemaColumnSchema).min(1).max(100), constraints: z.array(tableConstraintSchema).max(16).optional() }).strict(),
  z.object({ action: z.literal('add-column'), target: catalogObjectSchema, column: schemaColumnSchema }).strict(),
  z.object({ action: z.literal('alter-column'), target: catalogObjectSchema, column: name, alteration: columnAlterationSchema }).strict(),
  z.object({ action: z.literal('add-constraint'), target: catalogObjectSchema, constraint: tableConstraintSchema }).strict(),
  z.object({ action: z.literal('drop-constraint'), target: catalogObjectSchema, name, kind: z.enum(['check', 'unique', 'foreign']) }).strict(),
  z.object({ action: z.literal('replace-constraint'), target: catalogObjectSchema, name, kind: z.enum(['check', 'unique', 'foreign']), constraint: tableConstraintSchema }).strict(),
  z.object({ action: z.literal('rename-column'), target: catalogObjectSchema, column: name, name }).strict(),
  z.object({ action: z.literal('drop-column'), target: catalogObjectSchema, column: name }).strict(),
  z.object({ action: z.literal('rename-table'), target: catalogObjectSchema, name }).strict(),
  z.object({ action: z.literal('drop-table'), target: catalogObjectSchema }).strict(),
  z.object({ action: z.literal('create-index'), target: catalogObjectSchema, name, columns: z.array(name).min(1).max(16), unique: z.boolean(), descending: z.array(name).max(16).optional(), include: z.array(name).max(16).optional(), predicate: z.string().min(1).max(4000).optional(), method: z.enum(['btree', 'hash', 'gist', 'gin', 'brin']).optional() }).strict(),
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
  'create-schema': 'Create schema', 'create-table': 'Create table', 'add-column': 'Add column', 'alter-column': 'Alter column',
  'add-constraint': 'Add constraint', 'drop-constraint': 'Drop constraint', 'replace-constraint': 'Replace constraint',
  'rename-column': 'Rename column', 'drop-column': 'Drop column', 'rename-table': 'Rename table',
  'drop-table': 'Drop table', 'create-index': 'Create index', 'drop-index': 'Drop index'
}
export function transactionalDdl(engine: DatabaseEngine) { return !['mysql', 'mariadb', 'oracle'].includes(engine) }
export function supportsCreateSchema(engine: DatabaseEngine) { return ['postgres', 'sqlserver', 'azure-sql', 'duckdb'].includes(engine) }
