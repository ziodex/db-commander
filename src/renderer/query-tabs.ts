import type { DatabaseCatalog, DatabaseEvent, ResultSet, SchemaTable, SchemaSnapshot, SessionInfo, GridSnapshot, GridChange } from '../shared/contracts'

export interface QueryTabState {
  execution?: import('../shared/execution').ExecutionSource
  failure?: import('../shared/execution').FailureSource
  columnViews?: Record<string,import('../shared/column-layout').ColumnLayout>
  connectionDatabase?: string
  gridBack?: {table:import('../shared/contracts').GridTable;query:import('../shared/contracts').GridQueryOptions}[]
  plan?: import('../shared/explain').ExplainResult
  databases: DatabaseCatalog | null
  databasesLoading: boolean
  databasesError: string
  switching: boolean
  grid: GridSnapshot | null
  gridChanges: GridChange[]
  backupBusy: boolean
  transferBusy: boolean
  gridBusy: boolean
  gridExpired: boolean
  session: SessionInfo | null
  tables: SchemaTable[]
  schema: SchemaSnapshot | null
  schemaLoading: boolean
  schemaError: string
  schemaStale: boolean
  tableSearch: string
  results: ResultSet[]
  activeResult: number
  queryId: string
  running: boolean
  connecting: boolean
  closing: boolean
  error: string
  messages: string[]
  showMessages: boolean
  status: string
  duration: number | null
}
export function emptyTabState(): QueryTabState {
  return { execution: undefined, failure: undefined, columnViews: {}, connectionDatabase: undefined, gridBack: [], databases: null, databasesLoading: false, databasesError: '', switching: false, grid: null, gridChanges: [], gridBusy: false, backupBusy: false, transferBusy: false, gridExpired: false, session: null, tables: [], schema: null, schemaLoading: false, schemaError: '', schemaStale: false, tableSearch: '', results: [], activeResult: 0, queryId: '', running: false, connecting: false, closing: false,
    error: '', messages: [], showMessages: false, status: 'Ready', duration: null }
}
/** Shared operation availability; transaction and staged-edit policies stay explicit. */
export function tabOperationBusy(state: QueryTabState): boolean {
  return state.running || state.connecting || state.closing || state.schemaLoading || state.backupBusy
    || state.transferBusy || state.gridBusy || state.switching || state.databasesLoading
}
export function canCloseTab(state: QueryTabState): string | undefined {
  if (state.transferBusy) return 'Wait for this tab’s data transfer to finish.'
  if (state.backupBusy) return 'Wait for this tab’s backup or restore job to finish.'
  if (state.switching || state.databasesLoading) return 'Wait for this tab’s database operation to finish.'
  if (state.gridChanges.length) return 'Apply or discard this tab’s staged table edits before closing it.'
  if (state.gridBusy) return 'Wait for this tab’s table operation to finish.'
  if (state.connecting || state.closing || state.schemaLoading) return 'Wait for this tab’s connection operation to finish.'
  if (state.running) return 'Stop this tab’s running query before closing it.'
  if (state.session && state.session.transaction !== 'idle') return 'Commit or roll back this tab’s transaction before closing it.'
}
/** Session and execution identity, never the active tab, owns incoming data. */
export function applyDatabaseEvent(state: QueryTabState, event: DatabaseEvent): QueryTabState {
  if (event.type === 'host-lost') return state.session || state.connecting ? { ...state, databases: null, databasesLoading: false, databasesError: '', switching: false, gridBusy: false, backupBusy: false, transferBusy: false, gridExpired: true, session: null, tables: [], schema: null, schemaLoading: false, schemaError: '', schemaStale: false, running: false, connecting: false, closing: false, queryId: '', failure: undefined, error: event.message, status: 'Disconnected' } : state
  if (event.sessionId !== state.session?.id) return state
  if (event.type === 'session-lost') return { ...state, databases: null, databasesLoading: false, databasesError: '', switching: false, gridBusy: false, backupBusy: false, transferBusy: false, gridExpired: true, session: null, tables: [], schema: null, schemaLoading: false, schemaError: '', schemaStale: false, running: false, queryId: '', failure: undefined, error: event.message, status: 'Disconnected' }
  if (event.queryId !== state.queryId) return state
  if (event.type === 'result') {
    const results = [...state.results]
    results[event.result.index] = { ...event.result, rows: results[event.result.index]?.rows ?? [] }
    return { ...state, results }
  }
  if (event.type === 'rows') {
    if (!state.results[event.index]) return state
    const results = [...state.results], result = results[event.index]
    results[event.index] = { ...result, rows: [...result.rows, ...event.rows] }
    return { ...state, results }
  }
  if (event.type === 'notice') return { ...state, messages: [...state.messages.slice(-99), event.message] }
  return { ...state, failure: event.status === 'failed' ? event.failure ?? (state.execution ? { start: 0, end: state.execution.sql.length, scope: 'script' } : undefined) : undefined, running: false, duration: event.durationMs,
    showMessages: state.showMessages || !state.results.length && (state.messages.length > 0 || Boolean(event.error)),
    status: event.status === 'completed' ? 'Completed' : event.status === 'cancelled' ? 'Cancelled' : event.status === 'unknown' ? 'Outcome unknown' : 'Failed',
    session: { ...state.session!, transaction: event.transaction, autocommit: event.autocommit, database: event.database ?? state.session!.database, mysqlSqlMode: event.mysqlSqlMode ?? state.session!.mysqlSqlMode },
    messages: event.error ? [...state.messages.slice(-99), event.error] : state.messages,
    error: event.error && event.status !== 'cancelled' ? event.error : state.error }
}

export function canSwitchDatabase(state: QueryTabState): string | undefined {
  if (state.gridChanges.length) return 'Apply or discard staged table edits before switching databases.'
  if (state.running) return 'Stop the running query before switching databases.'
  if (state.session?.transaction !== 'idle' || state.session.autocommit === false) return 'Commit or roll back and enable autocommit before switching databases.'
  return canCloseTab(state)
}
