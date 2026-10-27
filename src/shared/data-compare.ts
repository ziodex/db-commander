import { z } from 'zod'
import { gridFilterSchema, gridTableSchema, idSchema, type Cell, type DatabaseEngine, type GridColumn } from './contracts'

const DATA_ROWS = 200
export const DATA_COLUMNS = 32
export const DATA_CELL = 4096
export const DATA_BYTES = 4 * 1024 * 1024
const names = z.array(z.string().min(1).max(255)).max(DATA_COLUMNS).refine(v => new Set(v).size === v.length, 'Choose each column once.')
const dataScopeSchema = z.object({ sessionId: idSchema, table: gridTableSchema, filters: z.array(gridFilterSchema).max(8).default([]) }).strict()
export const dataCompareSchema = z.object({
  source: dataScopeSchema, target: dataScopeSchema,
  keys: names.refine(v => v.length <= 8, 'Choose at most eight key columns.').default([]),
  columns: names.default([]), maxRows: z.number().int().min(1).max(DATA_ROWS).default(100)
}).strict()
export type DataScope = z.infer<typeof dataScopeSchema>
export type DataCompareRequest = z.infer<typeof dataCompareSchema>
// Host-only operation: never accepted by the public grid IPC schema.
export type DataCaptureRequest = DataScope & Pick<DataCompareRequest, 'keys' | 'columns' | 'maxRows'> & { action: 'compare-data' }
export interface DataCapture { columns: GridColumn[]; keys: string[]; rows: Cell[][] }
export interface DataDifference {
  key: string[]; status: 'source-only' | 'target-only' | 'changed' | 'matching'
  source?: Cell[]; target?: Cell[]; changedColumns: string[]
}
export interface DataComparison {
  engine: DatabaseEngine; request: DataCompareRequest; sourceLabel: string; targetLabel: string; capturedAt: string
  columns: GridColumn[]; keys: string[]; sourceRows: number; targetRows: number
  counts: Record<DataDifference['status'], number>; rows: DataDifference[]; notices: string[]
}
