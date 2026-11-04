import { z } from 'zod'
import { idSchema } from './id-schema'
import type { DatabaseEngine } from './database-engines'

const identifier = z.string().min(1).max(255).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'Enter a non-empty identifier without control characters.')
export const administrationChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-database'), database: identifier }).strict(),
  z.object({ action: z.literal('rename-database'), database: identifier, destination: identifier }).strict(),
  z.object({ action: z.literal('drop-database'), database: identifier }).strict(),
  z.object({ action: z.literal('checkpoint-database'), database: identifier }).strict(),
  z.object({ action: z.enum(['analyze-table', 'vacuum-table', 'reindex-table', 'optimize-table', 'check-table']), schema: identifier, table: identifier }).strict()
])
export const prepareAdministrationSchema = z.object({ sessionId: idSchema, change: administrationChangeSchema }).strict()
export const applyAdministrationSchema = z.object({
  sessionId: idSchema, reviewId: idSchema, confirmation: z.string().max(600), acknowledge: z.literal(true)
}).strict()

export type AdministrationChange = z.infer<typeof administrationChangeSchema>
export type AdministrationTarget = { database: string } | { schema: string; table: string }
export type PrepareAdministration = z.infer<typeof prepareAdministrationSchema>
export type ApplyAdministration = z.infer<typeof applyAdministrationSchema>

export const administrationLabels = {
  'create-database': 'Create database',
  'rename-database': 'Rename database',
  'drop-database': 'Drop database',
  'checkpoint-database': 'Checkpoint database file',
  'analyze-table': 'Update table statistics',
  'vacuum-table': 'Vacuum table',
  'reindex-table': 'Rebuild table indexes',
  'optimize-table': 'Optimize table and indexes',
  'check-table': 'Check table integrity'
} satisfies Record<AdministrationChange['action'], string>

const postgresLifecycle = ['create-database', 'rename-database', 'drop-database'] as const
const postgresMaintenance = ['analyze-table', 'vacuum-table', 'reindex-table'] as const
const mysqlLifecycle = ['create-database', 'drop-database'] as const
const sqlServerMaintenance = ['analyze-table', 'reindex-table'] as const
const azureLifecycle = ['create-database'] as const
const sqliteMaintenance = ['analyze-table', 'reindex-table', 'check-table'] as const
const duckdbMaintenance = ['checkpoint-database'] as const
const mysqlMaintenance = ['analyze-table', 'optimize-table', 'check-table'] as const

export function administrationActions(engine: DatabaseEngine, target: 'database' | 'table'): readonly AdministrationChange['action'][] {
  if (engine === 'postgres') return target === 'database' ? postgresLifecycle : postgresMaintenance
  if (engine === 'mysql' || engine === 'mariadb') return target === 'database' ? mysqlLifecycle : mysqlMaintenance
  if (engine === 'sqlserver') return target === 'database' ? postgresLifecycle : sqlServerMaintenance
  if (engine === 'azure-sql') return target === 'database' ? azureLifecycle : sqlServerMaintenance
  if (engine === 'oracle' && target === 'table') return sqlServerMaintenance
  if (engine === 'sqlite' && target === 'table') return sqliteMaintenance
  if (engine === 'duckdb' && target === 'database') return duckdbMaintenance
  return []
}

export interface AdministrationReview {
  id: string
  database: string
  observer: string
  scope: string
  target: string
  sql: string
  notes: string[]
  confirmation: string
  expiresAt: string
}

export interface AdministrationResult {
  status: 'applied' | 'rejected' | 'partial' | 'issues' | 'unknown'
  message: string
}
