import { z } from 'zod'
import { idSchema } from './id-schema'
import type { DatabaseEngine } from './database-engines'

export const schedulerCaptureLimit = 100
export const prepareScheduleChangeSchema = z.object({ sessionId: idSchema, targetId: idSchema }).strict()
export const applyScheduleChangeSchema = z.object({
  sessionId: idSchema, reviewId: idSchema, confirmation: z.string().max(16), acknowledge: z.literal(true)
}).strict()
export type PrepareScheduleChange = z.infer<typeof prepareScheduleChangeSchema>
export type ApplyScheduleChange = z.infer<typeof applyScheduleChangeSchema>

export interface SchedulerEntry {
  id: string
  kind: 'job' | 'schedule' | 'event'
  name: string
  owner: string | null
  enabled: boolean | null
  state: string
  schedule: string | null
  lastRun: string | null
  nextRun: string | null
  changeAllowed: boolean
}

export interface SchedulerSnapshot {
  status: 'available' | 'unavailable' | 'unsupported'
  scope: string
  note: string
  capturedAt: string
  truncated: boolean
  entries: SchedulerEntry[]
}

export interface ScheduleReview {
  id: string
  sessionId: string
  engine: DatabaseEngine
  connection: string
  scope: string
  target: SchedulerEntry
  action: 'enable' | 'disable'
  confirmation: 'ENABLE' | 'DISABLE'
  expiresAt: string
}

export interface ScheduleResult {
  status: 'completed' | 'not-applied' | 'unknown'
  message: string
}
