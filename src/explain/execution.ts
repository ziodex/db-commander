import { randomUUID } from 'node:crypto'
import oracledb from 'oracledb'
import { oracleConnectionOptions } from '../driver/oracle'
import { openSqlServer, streamSqlServer } from '../driver/sqlserver-transport'
import type { Cell, ConnectionConfig } from '../shared/contracts'
import { PLAN_LIMIT, planFormat, type PlanOutput } from '../shared/explain'
import { boundValue } from '../driver/parameters'
import type { QueryParameter } from '../shared/parameters'

export class PlanCollector {
  output: PlanOutput = { columns: [], rows: [] }
  private bytes = 0
  columns(columns: string[]) { this.output.columns = columns }
  row(row: Cell[]) {
    const bytes = Buffer.byteLength(JSON.stringify(row))
    if (this.bytes + bytes > PLAN_LIMIT || this.output.rows.length >= 2000) throw new Error('Plan exceeds the 1 MB or 2,000-row capture limit. Narrow the statement; incomplete output is not shown as a complete plan.')
    this.bytes += bytes; this.output.rows.push(row)
  }
}
export function rawPlan(config: ConnectionConfig, output: PlanOutput) {
  if (!output.rows.length) throw new Error('The database returned no execution plan.')
  const format = planFormat(config.engine)
  if (format === 'json' || format === 'xml') {
    const raw = output.rows.map(row => row[0] ?? '').join('\n')
    if (!raw.trim() || format === 'xml' && !/<ShowPlanXML[\s>]/.test(raw)) throw new Error('The database did not return a complete execution plan.')
    return raw
  }
  if (config.engine === 'oracle') return output.rows.map(row => row[0] ?? '').join('\n')
  if (config.engine === 'duckdb') return output.rows.map(row => row.join('\n')).join('\n\n')
  return [output.columns, ...output.rows].map(row => row.map(value => value ?? 'NULL').join('\t')).join('\n')
}

/** These two engines require private session state. Never reuse this connection. */
export async function isolatedPlan(config: ConnectionConfig, sql: string, signal: AbortSignal, submitted: string[], values?: QueryParameter[]): Promise<PlanOutput> {
  signal.throwIfAborted()
  const collector = new PlanCollector()
  if (config.engine === 'oracle') {
    const client = await oracledb.getConnection(oracleConnectionOptions(config))
    client.callTimeout = 60000
    const cancel = () => { void client.break().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const statement = `EXPLAIN PLAN SET STATEMENT_ID = 'sc_${randomUUID().replaceAll('-','').slice(0,24)}' FOR\n${sql}`
      const binds = Object.fromEntries((values ?? []).map((p, i) => [`sc_p${i + 1}`, { val: boundValue(p), type: p.type === 'hex' ? oracledb.BUFFER : oracledb.STRING }]))
      submitted.push(statement); await client.execute(statement, binds, { autoCommit: false })
      signal.throwIfAborted()
      const id = /'([^']+)'/.exec(statement)![1]
      const display = `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '${id}', 'ALL'))`
      submitted.push(display)
      const result = await client.execute<string[]>(display, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 2001, autoCommit: false })
      collector.columns(['PLAN_TABLE_OUTPUT']); for (const row of result.rows ?? []) collector.row(row)
      signal.throwIfAborted()
      return collector.output
    } finally {
      signal.removeEventListener('abort', cancel)
      try { await client.rollback() } finally { await client.close() }
    }
  }
  const client = await openSqlServer(config)
  let active: ReturnType<typeof streamSqlServer> | undefined
  const cancel = () => active?.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    // SHOWPLAN does not compile the dynamic batch inside sp_executesql. A
    // connection-local procedure gives the optimizer a real parameterized
    // module without interpolating values or executing the user's query.
    // Closing this disposable connection also drops the temporary procedure.
    const bindings = values?.map(boundValue)
    const procedure = bindings?.length ? '#sc_plan_' + randomUUID().replaceAll('-', '') : undefined
    const create = procedure ? `CREATE PROCEDURE ${procedure}\n${bindings!.map((value, index) => `@sc_p${index + 1} ${Buffer.isBuffer(value) ? 'varbinary' : 'nvarchar'}(max)`).join(',\n')}\nAS\n${sql}\n` : undefined
    for (const statement of [...(create ? [create] : []), 'SET SHOWPLAN_XML ON', procedure ?? sql]) {
      signal.throwIfAborted(); submitted.push(statement)
      active = statement === procedure ? streamSqlServer(client, statement, bindings, { procedure: true }) : streamSqlServer(client, statement)
      for await (const frame of active.frames) {
        if (frame.kind === 'error') throw frame.error
        if (frame.kind === 'fields') collector.columns(frame.columns.map(column => column.name))
        if (frame.kind === 'row') collector.row(frame.row)
      }
      active = undefined
    }
    signal.throwIfAborted()
    return collector.output
  } finally { signal.removeEventListener('abort', cancel); active?.cancel(); client.close() }
}
