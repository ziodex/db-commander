import type { ResultSet } from '../shared/contracts'
import type { ColumnLayout } from '../shared/column-layout'
import type { ResultExploration } from './result-exploration'

export const MAX_RESULT_SNAPSHOTS = 12
export const MAX_RESULT_SNAPSHOT_BYTES = 32 * 1024 * 1024
export interface ResultSnapshot {
  id: string; name: string; capturedAt: string; source: string; partial: boolean; bytes: number
  result: ResultSet; columns?: ColumnLayout; exploration: ResultExploration
}
export function resultSnapshotBytes(result: ResultSet) {
  return 256 + result.statement.length * 2 + result.columns.reduce((bytes, column) => bytes + 48 + (column.name.length + (column.typeName?.length ?? 0)) * 2, 0)
    + result.rows.reduce((bytes, row) => bytes + 24 + row.reduce((size, value) => size + 16 + (value?.length ?? 0) * 2, 0), 0)
}
export function pinResultSnapshot(existing: ResultSnapshot[], input: Omit<ResultSnapshot, 'bytes'>) {
  const bytes = resultSnapshotBytes(input.result)
  if (existing.length >= MAX_RESULT_SNAPSHOTS) throw new Error(`Keep up to ${MAX_RESULT_SNAPSHOTS} pinned results in this window. Remove a snapshot before pinning another.`)
  if (existing.reduce((sum, snapshot) => sum + snapshot.bytes, 0) + bytes > MAX_RESULT_SNAPSHOT_BYTES) throw new Error('Pinned results would exceed this window’s 32 MB capture budget. Remove a snapshot or capture fewer rows; no existing result was changed.')
  // Strings are immutable; clone the mutable containers before the next run
  // replaces its cache or a view changes its filters, columns or sort keys.
  const snapshot: ResultSnapshot = {
    ...input, bytes,
    result: { ...input.result, columns: input.result.columns.map(column => ({ ...column })), rows: input.result.rows.map(row => [...row]) },
    columns: input.columns ? { ...input.columns, order: [...input.columns.order], hidden: [...input.columns.hidden], pinned: [...input.columns.pinned], widths: { ...input.columns.widths } } : undefined,
    exploration: { ...input.exploration, filters: input.exploration.filters.map(filter => ({ ...filter })), sort: input.exploration.sort.map(sort => ({ ...sort })) }
  }
  return [...existing, snapshot]
}
