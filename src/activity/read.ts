import type { Cell, DatabaseEngine, SessionInfo } from '../shared/contracts'
import { ACTIVITY_LOCKS, ACTIVITY_SESSIONS, ACTIVITY_SQL, activitySnapshotSchema, type ActivitySnapshot } from '../shared/activity'
import { activityQueries } from './queries'

type Query = (sql:string) => Promise<Cell[][]>
const clip = (value:Cell|undefined, max=512) => value == null ? null : String(value).slice(0,max)
const identity = (value:Cell|undefined) => clip(value,128) ?? 'unknown'
export async function readActivity(engine:DatabaseEngine, database:string, currentSessionId:string, query:Query, includeSql:boolean):Promise<ActivitySnapshot> {
  const plan=activityQueries(engine,includeSql)
  async function read<T>(sql:string, limit:number, convert:(row:Cell[])=>T) {
    try { const rows=await query(sql);return {status:'available' as const,rows:rows.slice(0,limit).map(convert),truncated:rows.length>limit} }
    catch(error) { const e=error as Error & {code?:string;errorNum?:number};return {status:'unavailable' as const,rows:[] as T[],truncated:false,notice:`Unavailable (${e.code??e.errorNum??'catalog read failed'}). ${String(e.message).slice(0,900)} Check monitoring permissions and engine/version support, then refresh.`} }
  }
  // Independent sections preserve partial diagnostics when one catalog is denied.
  const sessions=await read(plan.sessions,ACTIVITY_SESSIONS,r=>({id:identity(r[0]),user:clip(r[1]),database:clip(r[2]),application:clip(r[3]),client:clip(r[4]),state:clip(r[5]),command:clip(r[6]),ageSeconds:clip(r[7]),transaction:clip(r[8]),startedAt:clip(r[9]),wait:clip(r[10]),query:includeSql?clip(r[11],ACTIVITY_SQL):null,queryTruncated:includeSql&&String(r[11]??'').length>ACTIVITY_SQL}))
  const locks=await read(plan.locks,ACTIVITY_LOCKS,r=>({sessionId:clip(r[0],128),database:clip(r[1]),resource:clip(r[2],1024),mode:clip(r[3]),status:clip(r[4])}))
  const waits=await read(plan.waits,ACTIVITY_LOCKS,r=>({waiting:identity(r[0]),blocking:identity(r[1]),resource:clip(r[2],1024)}))
  return activitySnapshotSchema.parse({engine,database:clip(database),currentSessionId,scope:plan.scope,fetchedAt:new Date().toISOString(),includeSql,sessions,locks,waits,notices:[plan.permission,
    'Live sequential catalog reads are not an atomic snapshot. Permissions, instrumentation and capture limits can hide sessions or blockers; an empty view does not prove there are no locks. Refresh to resolve stale relationships.',
    'Up to 200 sessions, 500 locks and 500 blocking relationships. IDs are native engine IDs. Field text is bounded; query text may also be truncated by the engine. Age/transaction fields retain engine-specific meanings.',
    'SQL text is excluded unless requested. Captures are transient; copying SQL or saving a report can expose SQL literals, user names and host details. No session is cancelled, terminated or changed.'
  ]})
}
export function localActivity(engine:DatabaseEngine, selected:SessionInfo, connections:{info:SessionInfo;busy:boolean}[], includeSql:boolean):ActivitySnapshot {
  const notice=`${engine==='sqlite'?'SQLite file locks':'DuckDB file locks and optimistic transaction conflicts'} have no supported server session/lock catalog in this adapter. External processes, exact lock ownership and wait chains are not observable here; transaction state does not prove ownership of a lock.`
  return activitySnapshotSchema.parse({engine,database:clip(selected.database),currentSessionId:selected.id,scope:`Db Commander’s ${engine} connections across all files in this application instance. Local IDs are application connection IDs.`,fetchedAt:new Date().toISOString(),includeSql,notices:[notice,'States are the last known driver state; a running query may not have reported its transaction change yet. No database reads or probes are performed. SQL text is not retained by this view.'],
    sessions:{status:'available',truncated:false,rows:connections.map(({info,busy})=>({id:info.id,user:'local',database:clip(info.host),application:clip(info.name),client:'This application',state:busy?'Running operation':'Idle',command:null,ageSeconds:null,transaction:info.transaction,startedAt:null,wait:null,query:null,queryTruncated:false}))},
    locks:{status:'unsupported',rows:[],truncated:false,notice},waits:{status:'unsupported',rows:[],truncated:false,notice}})
}
