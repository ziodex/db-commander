import { z } from 'zod'
import { idSchema, type DatabaseEngine } from './contracts'

export const rollbackRequestSchema = z.union([
  z.object({sessionId:idSchema,targetId:z.string().min(1).max(128)}).strict(),
  z.object({sessionId:idSchema,inspectionId:idSchema}).strict()
])
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>
export interface RollbackSnapshot {
  id:string; sessionId:string; engine:DatabaseEngine; database:string; targetId:string
  capturedAt:string; fetchedAt:string; expiresAt:string; identity:string[]
  status:'observed'|'rolling-back'|'not-visible'|'unavailable'|'unsupported'
  metrics:{label:string;value:string}[]; percent:number|null; notices:string[]
}
export const rollbackStatus = {observed:'Transaction observed', 'rolling-back':'Rollback reported', 'not-visible':'Captured transaction no longer visible', unavailable:'Diagnostics unavailable', unsupported:'Progress inspection not supported'} as const
