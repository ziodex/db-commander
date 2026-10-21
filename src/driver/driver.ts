import type { ConnectionConfig, DatabaseEvent, ResultSet, RunRequest, SchemaTable, SchemaSnapshot, SessionInfo, GridResponse } from '../shared/contracts'
import { open } from 'node:fs/promises'
import { publishFile } from '../backup/files'
import { csvCell } from '../shared/sql/common'

export type Emit = (event: DatabaseEvent) => void | Promise<void>
export type Completion = Extract<DatabaseEvent, { type: 'complete' }>
/** Host-only streaming mode. The public run schema never accepts this flag. */
export type DriverRunRequest = RunRequest & { fullExport?: boolean; bound?: ReturnType<typeof import('../shared/parameters').compileParameters> }
export interface DatabaseDriver {
  withActivity?<T>(id:string, read:(observer:import('../activity/control').ActivityObserver)=>Promise<T>):Promise<T>
  activityId?(id:string):string
  invalidateActivity?(id:string):void
  activity?(id:string, includeSql:boolean): Promise<import('../shared/activity').ActivitySnapshot>
  backup?(request: import('../shared/backup').BackupRequest, context: import('../backup/context').BackupContext): Promise<void>
  listDatabases?(id: string): Promise<import('../shared/contracts').DatabaseCatalog>
  editGrid(request: import('../shared/transfer').GridOperation, context?: import('../shared/transfer').ImportContext): Promise<GridResponse>
  connect(config: ConnectionConfig): Promise<SessionInfo>
  disconnect(id: string): Promise<void>
  start(request: DriverRunRequest, completed?: (event: Completion) => void): string
  cancel(id: string): Promise<{ requested: boolean }>
  tables(id: string): Promise<SchemaTable[]>
  schema(id: string): Promise<SchemaSnapshot>
  explore(id: string, object?: import('../shared/catalog').CatalogObject, diagram?: import('../shared/diagram').DiagramScope): Promise<import('../shared/catalog').CatalogResponse>
  exportCsv(queryId: string, index: number, path: string): Promise<void>
  getSession(id: string): SessionInfo
  wait(id: string): Promise<void>
  close(): Promise<void>
}

export async function exportResultCsv(result: ResultSet | undefined, path: string): Promise<void> {
  if (!result) throw new Error('This result is no longer available. Execute the query again explicitly.')
  await publishFile(path, { signal: new AbortController().signal, log() {} }, async temporary => {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(result.columns.map(column => csvCell(column.name)).join(',') + '\r\n')
      for (const row of result.rows) await file.writeFile(row.map(csvCell).join(',') + '\r\n')
      await file.close()
    } finally { await file.close().catch(() => {}) }
  })
}
