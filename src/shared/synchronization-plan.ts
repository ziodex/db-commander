import type { DataComparison, DataDifference } from './data-compare'

export const SYNCHRONIZATION_LIMIT = 200

export function synchronizationBlocker(result: DataComparison, row: DataDifference): string | undefined {
  if (row.status === 'matching') return 'This row already matches.'
  if (!result.synchronization.primaryKey) return 'Compare using the full declared primary key on both tables to plan changes.'
  const { source, target, columns } = result.request
  if (row.status !== 'changed' && (source.filters.length || target.filters.length || columns.length)) {
    return 'Inserts and deletes require unfiltered comparisons of all columns on both tables.'
  }
  const generated = result.synchronization.generatedTargetColumns
  if (row.status === 'source-only' && generated.length || row.changedColumns.some(name => generated.includes(name))) {
    return 'This change includes a generated target column. Review it manually.'
  }
}

export function synchronizationPlan(result: DataComparison, selected: Set<string>) {
  if (!selected.size || selected.size > SYNCHRONIZATION_LIMIT) throw new Error(`Select 1–${SYNCHRONIZATION_LIMIT} changes.`)
  const rows = result.rows.filter(row => selected.has(JSON.stringify(row.key)))
  if (rows.length !== selected.size) throw new Error('The selection changed. Review the comparison again.')
  const operations = rows.map(row => {
    const blocked = synchronizationBlocker(result, row)
    if (blocked) throw new Error(blocked)
    const action = row.status === 'source-only' ? 'insert' : row.status === 'target-only' ? 'delete' : 'update'
    return {
      action,
      key: row.key,
      expectedTarget: row.target ?? null,
      proposedRow: row.source ?? null,
      columnsToWrite: action === 'update' ? row.changedColumns : action === 'insert' ? result.columns.map(column => column.name) : []
    }
  })
  const scope = (side: 'source' | 'target') => ({
    label: result[`${side}Label`],
    table: result.request[side].table,
    filters: result.request[side].filters
  })
  return {
    format: 'dbcommander-synchronization-plan',
    version: 1,
    engine: result.engine,
    capturedAt: result.capturedAt,
    source: scope('source'),
    target: scope('target'),
    consistency: 'Sequential live reads. Each filtered capture fit the selected limits.',
    keys: result.keys,
    columns: result.columns.map(({ name, type }) => ({ name, type })),
    operations,
    reviewBeforeApplying: [
      'Re-read both tables. Check the key and every captured target value inside the write transaction. A null expectedTarget means verify absence using the target database’s key semantics.',
      'Use native types and bound values. Review collation, generated columns, triggers, permissions and foreign keys before deciding execution order.',
      'This file contains captured values and proposes changes for manual review. It has no executable SQL or apply authority.',
      ...result.notices
    ]
  }
}
