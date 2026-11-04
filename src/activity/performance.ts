import type { SessionInfo } from '../shared/contracts'
import { performanceSnapshotSchema, type PerformanceSnapshot } from '../shared/performance'
import type { ActivityObserver } from './control'

type Metric = PerformanceSnapshot['metrics'][number]
type Counter = readonly [key: string, label: string, unit: Metric['unit'], basis: Metric['basis']]
type Scope = Pick<PerformanceSnapshot, 'scope' | 'note'>
const numeric = /^\d+(?:\.\d+)?$/

function snapshot(engine: SessionInfo['engine'], database: string, scope: Scope, metrics: Metric[], reference?: string): PerformanceSnapshot {
  return performanceSnapshotSchema.parse({
    engine, database: database.slice(0, 512), capturedAt: new Date().toISOString(),
    ...scope, status: metrics.length ? 'available' : 'unavailable', metrics, reference
  })
}

function metrics(definitions: readonly Counter[], values: Map<string, string | null>): Metric[] {
  return definitions.flatMap(([key, label, unit, basis]) => {
    const value = values.get(key)
    return value && value.length <= 64 && numeric.test(value) ? [{ label, value, unit, basis }] : []
  })
}

const postgres = [
  ['numbackends', 'Connected backends', 'count', 'current'],
  ['xact_commit', 'Transactions committed', 'count', 'cumulative'],
  ['xact_rollback', 'Transactions rolled back', 'count', 'cumulative'],
  ['blks_read', 'Blocks read', 'count', 'cumulative'],
  ['blks_hit', 'PostgreSQL buffer hits', 'count', 'cumulative'],
  ['temp_bytes', 'Temporary file bytes', 'bytes', 'cumulative'],
  ['deadlocks', 'Deadlocks', 'count', 'cumulative']
] as const satisfies readonly Counter[]

const mysql = [
  ['threads_connected', 'Connections open', 'count', 'current'],
  ['threads_running', 'Threads running', 'count', 'current'],
  ['slow_queries', 'Slow queries', 'count', 'cumulative'],
  ['created_tmp_disk_tables', 'Internal disk temporary tables', 'count', 'cumulative'],
  ['innodb_buffer_pool_reads', 'InnoDB buffer pool reads from disk', 'count', 'cumulative'],
  ['innodb_buffer_pool_read_requests', 'InnoDB logical buffer requests', 'count', 'cumulative']
] as const satisfies readonly Counter[]

const sqlServer = [
  ['num_of_reads', 'File reads', 'count', 'cumulative'],
  ['num_of_writes', 'File writes', 'count', 'cumulative'],
  ['num_of_bytes_read', 'File bytes read', 'bytes', 'cumulative'],
  ['num_of_bytes_written', 'File bytes written', 'bytes', 'cumulative'],
  ['io_stall_read_ms', 'File read stalls', 'ms', 'cumulative'],
  ['io_stall_write_ms', 'File write stalls', 'ms', 'cumulative']
] as const satisfies readonly Counter[]

const azure = [
  ['avg_cpu_percent', 'Average CPU', '%', 'interval'],
  ['avg_data_io_percent', 'Average data I/O', '%', 'interval'],
  ['avg_log_write_percent', 'Average log writes', '%', 'interval'],
  ['avg_memory_usage_percent', 'Average memory usage', '%', 'interval']
] as const satisfies readonly Counter[]

const oracle = [
  ['session logical reads', 'Session logical reads', 'count', 'cumulative'],
  ['physical read total bytes', 'Physical read bytes', 'bytes', 'cumulative'],
  ['physical write total bytes', 'Physical write bytes', 'bytes', 'cumulative'],
  ['user commits', 'User commits', 'count', 'cumulative'],
  ['user rollbacks', 'User rollbacks', 'count', 'cumulative']
] as const satisfies readonly Counter[]

// These lists come only from fixed metric definitions. Never interpolate a user
// identifier or a value returned by the database into a diagnostics query.
const columns = (definitions: readonly Counter[]) => definitions.map(([key]) => key).join(', ')
const names = (definitions: readonly Counter[]) => definitions.map(([key]) => `'${key}'`).join(', ')
const byColumn = (definitions: readonly Counter[], row: (string | null)[]) =>
  new Map(definitions.map(([key], index) => [key, row[index] ?? null]))
const byName = (rows: (string | null)[][]) => new Map(rows.flatMap(([key, value]) => key ? [[key.toLowerCase(), value ?? null] as const] : []))

export async function readPerformance(observer: ActivityObserver): Promise<PerformanceSnapshot> {
  const { engine, database, query } = observer
  let scope: Scope = { scope: 'Current database', note: 'Reads may require additional monitoring privileges.' }
  let values: Metric[] = [], reference: string | undefined
  try {
    switch (engine) {
      case 'postgres': {
        scope = { scope: 'Current PostgreSQL database', note: 'Totals accumulate since the last reset. Backend count is current and may include the inspection connection. PostgreSQL buffer hits exclude operating-system cache hits.' }
        const [row = []] = await query(`SELECT ${columns(postgres)}, stats_reset::text
          FROM pg_catalog.pg_stat_database WHERE datname = current_database()`)
        values = metrics(postgres, byColumn(postgres, row))
        if (row[postgres.length]) reference = `Last reset: ${row[postgres.length]}`
        break
      }
      case 'mysql':
      case 'mariadb': {
        scope = { scope: 'Whole server', note: 'Global status includes all databases. The observer can contribute to connection and thread counts. Totals can reset on restart or status reset.' }
        const rows = await query(`SHOW GLOBAL STATUS WHERE LOWER(Variable_name) IN (${names(mysql)})`)
        values = metrics(mysql, byName(rows))
        break
      }
      case 'sqlserver':
      case 'azure-sql': {
        const [[edition] = []] = await query("SELECT CONVERT(varchar(16), SERVERPROPERTY('EngineEdition'))")
        if (edition === '5') {
          scope = { scope: 'Current logical Azure SQL database', note: 'The latest reported 15-second interval shows percentages of the service limits. The sample can lag the current time.' }
          const [row = []] = await query(`SELECT TOP (1) ${columns(azure)}, CONVERT(varchar(33), end_time, 126)
            FROM sys.dm_db_resource_stats ORDER BY end_time DESC`)
          values = metrics(azure, byColumn(azure, row))
          if (row[azure.length]) reference = `Interval ended (UTC): ${row[azure.length]}`
        } else if (edition && ['2', '3', '4', '8'].includes(edition)) {
          scope = { scope: 'Current SQL Server database files', note: 'I/O totals are summed across data and log files. They reset at engine restart or when a file’s counters restart. File paths are excluded.' }
          const totals = sqlServer.map(([key]) => `CONVERT(varchar(64), SUM(CONVERT(decimal(38,0), ${key})))`).join(', ')
          const [row = []] = await query(`SELECT ${totals} FROM sys.dm_io_virtual_file_stats(DB_ID(), NULL)`)
          values = metrics(sqlServer, byColumn(sqlServer, row))
        }
        break
      }
      case 'oracle': {
        scope = { scope: 'Current Oracle container on this instance', note: 'Container statistics accumulate across its sessions. This snapshot does not combine other instances or containers.' }
        const rows = await query(`SELECT NAME, TO_CHAR(VALUE) FROM SYS.V_$CON_SYSSTAT
          WHERE CON_ID = TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND NAME IN (${names(oracle)}) FETCH FIRST 6 ROWS ONLY`)
        values = metrics(oracle, byName(rows))
        break
      }
    }
  } catch {
    return snapshot(engine, database, { ...scope, note: 'The engine did not expose these counters. Check monitoring privileges and engine support before refreshing.' }, [])
  }
  return snapshot(engine, database, values.length ? scope : {
    ...scope, note: 'The engine returned no usable counters for this scope. Check permissions and whether instrumentation is available.'
  }, values, values.length ? reference : undefined)
}

export function localPerformance(selected: SessionInfo, connections: { info: SessionInfo; busy: boolean }[]) {
  const summary: Metric[] = [
    { label: 'Connections open', value: String(connections.length), unit: 'count', basis: 'current' },
    { label: 'Connections with running operations', value: String(connections.filter(connection => connection.busy).length), unit: 'count', basis: 'current' },
    { label: 'Connections with known transactions', value: String(connections.filter(({ info }) => info.transaction === 'transaction' || info.transaction === 'failed').length), unit: 'count', basis: 'current' }
  ]
  return snapshot(selected.engine, selected.database, {
    scope: 'This workspace’s connections for this engine',
    note: 'Uses the last reported application state across local files. Engine-wide performance counters, other processes and OS file locks are unavailable.'
  }, summary)
}
