import { z } from 'zod'
import { engineSchema, idSchema } from './contracts'

export const ACTIVITY_SESSIONS = 200, ACTIVITY_LOCKS = 500, ACTIVITY_SQL = 4000
export const activityRequestSchema = z.object({ sessionId:idSchema, includeSql:z.boolean() }).strict()
export type ActivityRequest = z.infer<typeof activityRequestSchema>
const cell = z.string().max(512).nullable(), identity = z.string().max(128)
const sessionSchema = z.object({ id:identity, user:cell, database:cell, application:cell, client:cell, state:cell, command:cell, ageSeconds:cell, transaction:cell, startedAt:cell, wait:cell, query:z.string().max(ACTIVITY_SQL).nullable(), queryTruncated:z.boolean() }).strict()
const lockSchema = z.object({ sessionId:identity.nullable(), database:cell, resource:z.string().max(1024).nullable(), mode:cell, status:cell }).strict()
const waitSchema = z.object({ waiting:identity, blocking:identity, resource:z.string().max(1024).nullable() }).strict()
const section = <T extends z.ZodType>(row:T, limit:number) => z.object({ status:z.enum(['available','unavailable','unsupported']), rows:z.array(row).max(limit), truncated:z.boolean(), notice:z.string().max(2000).optional() }).strict().refine(s=>s.status==='available'||(!s.rows.length&&!s.truncated),'Unavailable sections cannot contain captured rows.')
export const activitySnapshotSchema = z.object({ engine:engineSchema, database:z.string().max(512), currentSessionId:identity, scope:z.string().max(1000), fetchedAt:z.string().datetime(), includeSql:z.boolean(), notices:z.array(z.string().max(2000)).max(20), sessions:section(sessionSchema,ACTIVITY_SESSIONS), locks:section(lockSchema,ACTIVITY_LOCKS), waits:section(waitSchema,ACTIVITY_LOCKS) }).strict().refine(s=>s.includeSql||s.sessions.rows.every(r=>r.query===null&&!r.queryTruncated),'SQL text must be excluded when its visibility option is off.')
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>
