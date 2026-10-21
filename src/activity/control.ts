import { randomUUID } from 'node:crypto'
import type { Cell, DatabaseEngine, SessionInfo } from '../shared/contracts'
import { activityControlLimit, type ActivityAction, type ActivityActionReview, type ActivityActionResult, type ApplyActivityAction } from '../shared/activity-control'

export interface ActivityObserver { engine: DatabaseEngine; database: string; currentSessionId: string; query(sql: string): Promise<Cell[][]> }
export interface ActivityTarget { id: string; user: string; database: string; client: string; identity: string[]; statement: string[] | null; transaction: string | null }
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'"
function number(s: string) { if (!/^[1-9]\d{0,19}$/.test(s) || BigInt(s) > 18446744073709551615n) throw new Error('Only ordinary positive session IDs can be controlled.'); return s }
export function targetNumbers(engine: DatabaseEngine, id: string) {
  const parts = id.split(':').map(number)
  if (parts.length !== (engine === 'oracle' ? 2 : 1)) throw new Error('Invalid native session identity.')
  if (['postgres','sqlserver','azure-sql','oracle'].includes(engine) && parts.some(s => BigInt(s) > 2147483647n)) throw new Error('Native session ID is out of range.')
  return parts
}
/** Point reads never fetch SQL text. Identities stay in the host's single-use review. */
export async function readTarget(observer: ActivityObserver, id: string): Promise<ActivityTarget> {
  const { engine, query } = observer, parts = targetNumbers(engine, id), n = parts.at(-1)!
  if (id === observer.currentSessionId) throw new Error('Use this tab’s existing Stop or Disconnect controls for its own session.')
  let sql: string
  // Columns: user, database, client, lifetime marker, active statement marker,
  // transaction marker, extra lifetime marker, extra statement marker.
  if (engine === 'postgres') sql = `SELECT usename,datname,client_addr::text,backend_start::text,CASE WHEN state='active' THEN query_start::text END,xact_start::text,pid::text,NULL FROM pg_catalog.pg_stat_activity WHERE pid=${n} AND datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()`
  else if (engine === 'mysql') sql = `SELECT t.PROCESSLIST_USER,t.PROCESSLIST_DB,t.PROCESSLIST_HOST,CAST(t.THREAD_ID AS CHAR),CAST(e.EVENT_ID AS CHAR),(SELECT CAST(x.TRX_ID AS CHAR) FROM information_schema.INNODB_TRX x WHERE x.TRX_MYSQL_THREAD_ID=t.PROCESSLIST_ID),CAST(t.PROCESSLIST_ID AS CHAR),NULL FROM performance_schema.threads t LEFT JOIN performance_schema.events_statements_current e ON e.THREAD_ID=t.THREAD_ID AND e.END_EVENT_ID IS NULL AND t.PROCESSLIST_COMMAND<>'Sleep' WHERE t.PROCESSLIST_ID=${n} AND t.TYPE='FOREGROUND' AND t.PROCESSLIST_USER IS NOT NULL AND t.PROCESSLIST_ID<>CONNECTION_ID()`
  else if (engine === 'mariadb') sql = `SELECT USER,DB,HOST,CAST(TID AS CHAR),CASE WHEN COMMAND<>'Sleep' AND QUERY_ID<>0 THEN CAST(QUERY_ID AS CHAR) END,(SELECT CAST(x.TRX_ID AS CHAR) FROM information_schema.INNODB_TRX x WHERE x.TRX_MYSQL_THREAD_ID=p.ID),CAST(ID AS CHAR),NULL FROM information_schema.PROCESSLIST p WHERE ID=${n} AND ID<>CONNECTION_ID() AND USER NOT IN ('system user','event_scheduler')`
  else if (engine === 'sqlserver' || engine === 'azure-sql') sql = `SELECT s.login_name,DB_NAME(s.database_id),s.host_name,CONVERT(varchar(50),s.login_time,126),NULL,CONVERT(varchar(30),s.open_transaction_count),CONVERT(varchar(50),c.connection_id),NULL FROM sys.dm_exec_sessions s JOIN sys.dm_exec_connections c ON c.session_id=s.session_id WHERE s.session_id=${n} AND s.is_user_process=1 AND s.database_id=DB_ID() AND s.session_id<>@@SPID AND c.parent_connection_id IS NULL`
  else if (engine === 'oracle') sql = `SELECT USERNAME,SYS_CONTEXT('USERENV','CON_NAME'),MACHINE,TO_CHAR(SERIAL#),CASE WHEN STATUS='ACTIVE' THEN SQL_ID END,CASE WHEN TADDR IS NOT NULL THEN RAWTOHEX(TADDR) END,TO_CHAR(LOGON_TIME,'YYYY-MM-DD"T"HH24:MI:SS'),CASE WHEN STATUS='ACTIVE' THEN TO_CHAR(SQL_EXEC_ID)||':'||TO_CHAR(SQL_EXEC_START,'YYYY-MM-DD"T"HH24:MI:SS') END FROM SYS.V_$SESSION WHERE SID=${n} AND TYPE='USER' AND STATUS<>'KILLED' AND CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND SYS_CONTEXT('USERENV','INSTANCE')=${literal(parts[0])} AND SID<>TO_NUMBER(SYS_CONTEXT('USERENV','SID'))`
  else throw new Error(activityControlLimit(engine, 'terminate'))
  const rows = await query(sql)
  if (rows.length !== 1) throw new Error('The target disappeared, is outside this database/instance, or its identity is not visible. Refresh and review again.')
  const r = rows[0]
  if (!r[0] || !r[3] || !r[6] || r.some(v => v !== null && String(v).length > 1024)) throw new Error('The server did not expose a complete bounded session identity. No action is allowed.')
  if (engine==='mariadb' && !/^[1-9]\d*$/.test(r[3])) throw new Error('MariaDB did not expose an OS thread identity. Session controls are unavailable.')
  if (engine==='oracle' && r[4] && (!r[7] || !/^\d+:\d{4}-\d{2}-\d{2}T/.test(r[7]))) r[4]=null
  return { id, user: String(r[0]), database: r[1] ?? '', client: r[2] ?? '', identity: [String(r[3]),String(r[6])], statement: r[4] ? [String(r[4]),...(r[7] ? [String(r[7])] : [])] : null, transaction: r[5] }
}
export function sameTarget(a: ActivityTarget, b: ActivityTarget, action: ActivityAction) {
  return JSON.stringify([a.id,a.user,a.database,a.client,a.identity,a.transaction,action==='cancel'?a.statement:null]) === JSON.stringify([b.id,b.user,b.database,b.client,b.identity,b.transaction,action==='cancel'?b.statement:null])
}
export function actionSql(engine: DatabaseEngine, action: ActivityAction, t: ActivityTarget): string {
  const unsupported = activityControlLimit(engine,action); if (unsupported) throw new Error(unsupported)
  const parts=targetNumbers(engine,t.id), n=parts.at(-1)!
  if (action==='cancel' && !t.statement) throw new Error('No active statement with a verifiable identity is visible. Refresh while the statement is running.')
  if (engine==='postgres') return `SELECT pg_catalog.pg_${action==='cancel'?'cancel':'terminate'}_backend(pid) FROM pg_catalog.pg_stat_activity WHERE pid=${n} AND backend_start::text=${literal(t.identity[0])} AND datname=current_database() AND backend_type='client backend'${action==='cancel'?` AND state='active' AND query_start::text=${literal(t.statement![0])}`:''}`
  if (engine==='mysql') return `KILL ${action==='cancel'?'QUERY':'CONNECTION'} ${n}`
  if (engine==='mariadb') return action==='cancel'?`KILL SOFT QUERY ID ${number(t.statement![0])}`:`KILL SOFT CONNECTION ${n}`
  if (engine==='oracle') {
    const serial=number(t.identity[0])
    if (action==='cancel' && !/^[a-z0-9]{13}$/.test(t.statement![0])) throw new Error('Invalid Oracle SQL identity.')
    return action==='cancel'?`ALTER SYSTEM CANCEL SQL '${n},${serial},@${parts[0]},${t.statement![0]}'`:`ALTER SYSTEM KILL SESSION '${n},${serial},@${parts[0]}' IMMEDIATE`
  }
  return `IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions s JOIN sys.dm_exec_connections c ON c.session_id=s.session_id WHERE s.session_id=${n} AND s.is_user_process=1 AND s.database_id=DB_ID() AND CONVERT(varchar(50),s.login_time,126)=${literal(t.identity[0])} AND CONVERT(varchar(50),c.connection_id)=${literal(t.identity[1])}) BEGIN KILL ${n}; SELECT 'requested'; END ELSE SELECT 'not-applied';`
}
export async function dispatchAction(observer: ActivityObserver, action: ActivityAction, target: ActivityTarget, beforeDispatch:()=>void): Promise<ActivityActionResult> {
  const fresh=await readTarget(observer,target.id)
  if (!sameTarget(target,fresh,action)) throw new Error('Session identity, transaction or active statement changed. No action was sent. Refresh and review again.')
  const sql=actionSql(observer.engine,action,fresh)
  beforeDispatch()
  try {
    const rows=await observer.query(sql)
    if (observer.engine==='postgres' && rows[0]?.[0]!=='t' || ['sqlserver','azure-sql'].includes(observer.engine) && rows[0]?.[0]!=='requested') return {status:'not-applied',message:'The server did not apply the request. Refresh and review the current target; nothing is retried.'}
    return {status:'requested',message:`${action==='cancel'?'Cancellation':'Termination'} requested. This is not proof that work stopped or rollback finished. Refresh and verify the target; nothing is retried.`}
  } catch (error) {
    const e=error as Error & {code?:string;errorNum?:number;number?:number}, code=String(e.errorNum??e.number??e.code??'')
    if(observer.engine==='oracle'&&action==='terminate'&&code==='31')return {status:'requested',message:'Oracle marked the session for termination. Cleanup/rollback is still pending; refresh and verify. Nothing is retried.'}
    const rejected=['42501','ER_SPECIFIC_ACCESS_DENIED_ERROR','ER_KILL_DENIED_ERROR','1031','229','297'].includes(code)
      || ['sqlserver','azure-sql'].includes(observer.engine)&&code==='6102'
    const absent=['ER_NO_SUCH_THREAD','ER_NO_SUCH_QUERY','30','6106'].includes(code)
    return {status:rejected?'rejected':absent?'not-applied':'unknown',message:`${rejected?'Server rejected the request':absent?'Target no longer available':'Outcome unknown after dispatch'} (${code||'transport error'}): ${e.message.slice(0,700)}. Refresh and verify; this review cannot be retried.`}
  }
}
export class ActivityReviews {
  private reviews=new Map<string,{preview:ActivityActionReview;target:ActivityTarget}>()
  constructor(private now=Date.now) {}
  forget(sessionId:string) { for(const [id,r] of this.reviews)if(r.preview.sessionId===sessionId)this.reviews.delete(id) }
  clear(){this.reviews.clear()}
  prepare(session:SessionInfo, target:ActivityTarget, action:ActivityAction) {
    target=structuredClone(target)
    this.forget(session.id)
    const sql=actionSql(session.engine,action,target), confirmation=`${action==='cancel'?'CANCEL':'TERMINATE'} ${target.id}`
    const preview:ActivityActionReview={id:randomUUID(),sessionId:session.id,engine:session.engine,connection:session.name,database:session.database,action,targetId:target.id,user:target.user,client:target.client,targetDatabase:target.database,identity:target.identity,statement:target.statement,transaction:target.transaction,sql,confirmation,expiresAt:new Date(this.now()+60000).toISOString(),warnings:[
      action==='cancel'?'Cancels the reviewed statement. The connection can remain open, and its transaction may remain active or become failed. Locks may remain until its owner rolls back.':'Disconnects this session and can roll back all its uncommitted work. Rollback can take time and locks may remain. Other applications and users can be affected.',
      'No automatic retry or undo. Already committed changes and nontransactional/external effects are not reversed. An accepted request does not prove completion.',
      'The server identity and transaction are checked again immediately before dispatch. Cancellation also checks the active statement. If they changed, prepare a new review.',
      session.engine==='oracle'?'Oracle commands include SID, serial and instance; cancellation also includes SQL_ID. SQL_EXEC_ID is rechecked before dispatch.':session.engine==='mariadb'?'MariaDB uses SOFT requests and native QUERY_ID for cancellation. Termination rechecks connection ID, OS thread ID, user, host and transaction; ID-only termination still has a validation/delivery race.':'This engine’s control API ultimately addresses a session ID. A small identity/statement change race can remain between validation and server delivery.',
      'Only visible ordinary sessions are eligible. Database privileges are enforced by the server; Db Commander does not grant them. Protected issuing and recognized target profiles must be unlocked.'
    ]}
    while(this.reviews.size>=20)this.reviews.delete(this.reviews.keys().next().value!)
    this.reviews.set(preview.id,{preview:structuredClone(preview),target:structuredClone(target)});return preview
  }
  consume(request:ApplyActivityAction) {
    const retained=this.reviews.get(request.reviewId);this.reviews.delete(request.reviewId)
    if(!retained||retained.preview.sessionId!==request.sessionId||Date.parse(retained.preview.expiresAt)<=this.now())throw new Error('This review expired, was used or belongs to another connection. Prepare a new review.')
    if(!request.acknowledge||request.confirmation!==retained.preview.confirmation)throw new Error('Acknowledge the impact and type the exact confirmation before applying this action.')
    return retained
  }
}
