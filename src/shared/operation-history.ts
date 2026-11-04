import type { DatabaseEngine } from './database-engines'

export const operationLabels = {
  query: 'Query execution', explain: 'Query plan', schema: 'Schema change', grid: 'Table edit',
  'principal-change': 'Security principal change', administration: 'Database administration',
  'session-control': 'Session control', scheduler: 'Scheduler change', backup: 'Backup', restore: 'Restore',
  import: 'Import data', export: 'Export data', capture: 'Capture database copy', copy: 'Copy database rows'
} as const

export type OperationKind = keyof typeof operationLabels
export type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'not-applied' | 'requested' | 'partial' | 'issues'
export interface OperationEntry {
  id: string
  kind: OperationKind
  engine?: DatabaseEngine
  status: OperationStatus
  startedAt: string
  finishedAt?: string
  rows?: number
  destinationTransaction?: 'open' | 'unknown'
  cancellationRequested?: boolean
  journalWarning?: boolean
}
