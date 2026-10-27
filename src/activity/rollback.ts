import { randomUUID } from 'node:crypto'
import type { Cell, SessionInfo } from '../shared/contracts'
import type { RollbackSnapshot } from '../shared/rollback'
import { targetNumbers, type ActivityObserver, type ActivityTarget } from './control'

const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'"
const common='Manual read-only snapshot. Missing rows can mean completion, changed identity, permissions or capture timing; absence never proves rollback completed. No action is sent or retried.'
const counters='Counters are current observations, not a total or a countdown. No percentage or completion time is inferred from changing counters.'
interface Capture { snapshot:RollbackSnapshot; transaction:string[] }
function bounded(rows:Cell[][]) {
  if(rows.length>1||rows.some(r=>r.some(c=>c!==null&&String(c).length>256)))throw new Error('Ambiguous or oversized transaction identity.')
  return rows[0]
}
function metric(snapshot:RollbackSnapshot,label:string,value:Cell|undefined) {
  if(value!==undefined&&value!==null&&value!=='')snapshot.metrics.push({label,value:String(value).slice(0,256)})
}
function count(value:Cell|undefined) { return value!==null&&value!==undefined&&/^\d{1,30}$/.test(value)?value:null }
function missing(snapshot:RollbackSnapshot) { snapshot.status='not-visible';snapshot.notices.push('The captured transaction is not visible. Start a new inspection explicitly to follow another transaction.');return snapshot }
function base(snapshot:RollbackSnapshot,now:number):RollbackSnapshot { return {...structuredClone(snapshot),fetchedAt:new Date(now).toISOString(),metrics:[],percent:null,notices:[common],status:'observed'} }

/** Fixed point reads, never SQL text or administration commands. Transaction keys
 * survive the target connection disappearing; refresh never retargets a session ID. */
export async function captureRollback(observer:ActivityObserver,session:SessionInfo,targetId:string,now:number,expected?:ActivityTarget):Promise<Capture> {
  const snapshot:RollbackSnapshot={id:randomUUID(),sessionId:session.id,engine:session.engine,database:session.database,targetId,capturedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+30*60_000).toISOString(),identity:[],status:'observed',metrics:[],percent:null,notices:[common]}
  const capture:Capture={snapshot,transaction:[]}
  if(['sqlite','duckdb'].includes(session.engine)) {snapshot.status='unsupported';snapshot.notices.push('This embedded engine exposes no rollback-progress API. Use the owning tab’s transaction state and Rollback control.');return capture}
  const parts=targetNumbers(session.engine,targetId),n=parts.at(-1)!,{engine}=session
  try {
    let sql:string
    // Columns: two session-lifetime markers, transaction ID and lifetime marker.
    if(engine==='postgres')sql=`SELECT backend_start::text,pid::text,xact_start::text,xact_start::text FROM pg_catalog.pg_stat_activity WHERE pid=${n} AND datname=current_database() AND backend_type='client backend'`
    else if(engine==='mysql')sql=`SELECT CAST(t.THREAD_ID AS CHAR),CAST(t.PROCESSLIST_ID AS CHAR),CAST(x.TRX_ID AS CHAR),DATE_FORMAT(x.TRX_STARTED,'%Y-%m-%d %H:%i:%s') FROM performance_schema.threads t JOIN information_schema.INNODB_TRX x ON x.TRX_MYSQL_THREAD_ID=t.PROCESSLIST_ID WHERE t.PROCESSLIST_ID=${n} AND t.TYPE='FOREGROUND' AND t.PROCESSLIST_USER IS NOT NULL LIMIT 2`
    else if(engine==='mariadb')sql=`SELECT CAST(p.TID AS CHAR),CAST(p.ID AS CHAR),CAST(x.TRX_ID AS CHAR),DATE_FORMAT(x.TRX_STARTED,'%Y-%m-%d %H:%i:%s') FROM information_schema.PROCESSLIST p JOIN information_schema.INNODB_TRX x ON x.TRX_MYSQL_THREAD_ID=p.ID WHERE p.ID=${n} AND p.USER NOT IN ('system user','event_scheduler') LIMIT 2`
    else if(engine==='oracle')sql=`SELECT TO_CHAR(s.SERIAL#),TO_CHAR(s.LOGON_TIME,'YYYY-MM-DD"T"HH24:MI:SS'),RAWTOHEX(t.XID),TO_CHAR(t.START_SCN) FROM SYS.V_$SESSION s JOIN SYS.V_$TRANSACTION t ON t.ADDR=s.TADDR AND t.CON_ID=s.CON_ID WHERE s.SID=${n} AND s.TYPE='USER' AND s.CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND SYS_CONTEXT('USERENV','INSTANCE')=${literal(parts[0])} FETCH FIRST 2 ROWS ONLY`
    else sql=`SELECT DISTINCT TOP (2) CONVERT(varchar(50),s.login_time,126),CONVERT(varchar(50),c.connection_id),CONVERT(varchar(30),a.transaction_id),CONVERT(varchar(50),a.transaction_begin_time,126) FROM sys.dm_exec_sessions s JOIN sys.dm_exec_connections c ON c.session_id=s.session_id AND c.parent_connection_id IS NULL JOIN sys.dm_tran_session_transactions st ON st.session_id=s.session_id JOIN sys.dm_tran_active_transactions a ON a.transaction_id=st.transaction_id JOIN sys.dm_tran_database_transactions d ON d.transaction_id=a.transaction_id AND d.database_id=DB_ID() WHERE s.session_id=${n} AND s.is_user_process=1 AND s.database_id=DB_ID()`
    const row=bounded(await observer.query(sql))
    if(!row||row.slice(0,4).length!==4||row.slice(0,4).some(c=>!c)||((engine==='mysql'||engine==='mariadb')&&(!/^[1-9]\d*$/.test(row[2]!)||row[0]==='0'))) {
      snapshot.status='unavailable';snapshot.notices.push('No single identifiable transaction is visible. It may be idle, read-only, already gone, or hidden by permissions. No later transaction will be followed automatically.');return capture
    }
    if(expected&&JSON.stringify(row.slice(0,2))!==JSON.stringify(expected.identity))throw new Error('Session identity changed during capture.')
    snapshot.identity=row.slice(0,4) as string[];capture.transaction=row.slice(2,4) as string[]
    capture.snapshot=await refreshRollback(observer,capture,now)
  } catch { snapshot.status='unavailable';snapshot.notices.push('A bounded transaction identity could not be captured. Check monitoring privileges and refresh the session list before inspecting again.');capture.transaction=[] }
  return capture
}

export async function refreshRollback(observer:ActivityObserver,capture:Capture,now:number):Promise<RollbackSnapshot> {
  const snapshot=base(capture.snapshot,now),{engine,targetId,identity}=snapshot,[tx,start]=capture.transaction
  if(!capture.transaction.length)return {...structuredClone(capture.snapshot),fetchedAt:new Date(now).toISOString()}
  const n=targetNumbers(engine,targetId).at(-1)!
  try {
    if(engine==='postgres') {
      snapshot.notices.push('PostgreSQL exposes transaction/session state, but no rollback percentage, undo counter or ETA. Transaction observation does not establish that rollback is running.')
      const row=bounded(await observer.query(`SELECT state,wait_event_type,wait_event FROM pg_catalog.pg_stat_activity WHERE pid=${n} AND backend_start::text=${literal(identity[0])} AND xact_start::text=${literal(tx)} AND datname=current_database() AND backend_type='client backend'`))
      if(!row)return missing(snapshot)
      metric(snapshot,'Session state',row[0]);metric(snapshot,'Wait type',row[1]);metric(snapshot,'Wait event',row[2])
    } else if(engine==='mysql'||engine==='mariadb') {
      snapshot.notices.push('InnoDB transactions only; nontransactional engines and external effects are outside this inspection.',counters)
      const row=bounded(await observer.query(`SELECT TRX_STATE,TRX_OPERATION_STATE,CAST(TRX_ROWS_MODIFIED AS CHAR),CAST(TRX_ROWS_LOCKED AS CHAR) FROM information_schema.INNODB_TRX WHERE CAST(TRX_ID AS CHAR)=${literal(tx)} AND DATE_FORMAT(TRX_STARTED,'%Y-%m-%d %H:%i:%s')=${literal(start)} LIMIT 2`))
      if(!row)return missing(snapshot)
      if(row[0]==='ROLLING BACK')snapshot.status='rolling-back'
      metric(snapshot,'Transaction state',row[0]);metric(snapshot,'Operation',row[1]);metric(snapshot,'Rows modified (reported)',count(row[2]));metric(snapshot,'Rows locked (approximate)',count(row[3]))
    } else if(engine==='oracle') {
      snapshot.notices.push('Current instance/container only. Undo usage alone does not establish that rollback is running. Parallel recovery counters are available only for transactions in V$FAST_START_TRANSACTIONS; serial rollback has no percentage.',counters)
      const row=bounded(await observer.query(`SELECT STATUS,TO_CHAR(USED_UBLK),TO_CHAR(USED_UREC) FROM SYS.V_$TRANSACTION WHERE RAWTOHEX(XID)=${literal(tx)} AND TO_CHAR(START_SCN)=${literal(start)} AND CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) FETCH FIRST 2 ROWS ONLY`))
      if(row){metric(snapshot,'Transaction state',row[0]);metric(snapshot,'Undo blocks used',count(row[1]));metric(snapshot,'Undo records used',count(row[2]))}
      let recovery:Cell[]|undefined
      try { recovery=bounded(await observer.query(`SELECT STATE,TO_CHAR(UNDOBLOCKSDONE),TO_CHAR(UNDOBLOCKSTOTAL) FROM SYS.V_$FAST_START_TRANSACTIONS WHERE RAWTOHEX(XID)=${literal(tx)} AND CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) FETCH FIRST 2 ROWS ONLY`)) }
      catch { snapshot.notices.push('Parallel recovery diagnostics unavailable; SELECT on SYS.V_$FAST_START_TRANSACTIONS may be required.');if(!row)snapshot.status='unavailable' }
      if(recovery) {
        metric(snapshot,'Parallel recovery state',recovery[0]);metric(snapshot,'Recovery undo blocks done',count(recovery[1]));metric(snapshot,'Recovery undo blocks total',count(recovery[2]))
        if(['RECOVERING','TO BE RECOVERED'].includes(recovery[0]??''))snapshot.status='rolling-back'
        const done=count(recovery[1]),total=count(recovery[2])
        if(done&&total&&BigInt(total)>0n&&BigInt(done)<=BigInt(total))snapshot.percent=Number(BigInt(done)*10000n/BigInt(total))/100
        snapshot.notices.push('Percentage describes this parallel recovery record only, not all cleanup or lock release. Even 100% is not proof of global completion.')
      } else if(!row&&snapshot.status!=='unavailable')return missing(snapshot)
    } else {
      snapshot.notices.push('Current database transaction only. Percentage is reported only for its native rollback request. No ETA is shown: the DMV estimated-completion field is documented as internal. Even 100% does not prove cleanup or lock release.')
      const row=bounded(await observer.query(`SELECT TOP (2) CONVERT(varchar(10),a.transaction_state),r.status,r.command,CONVERT(varchar(50),r.percent_complete) FROM sys.dm_tran_active_transactions a JOIN sys.dm_tran_database_transactions d ON d.transaction_id=a.transaction_id AND d.database_id=DB_ID() OUTER APPLY (SELECT TOP (1) status,command,percent_complete FROM sys.dm_exec_requests WHERE transaction_id=a.transaction_id AND session_id=${n} AND database_id=DB_ID() ORDER BY request_id) r WHERE CONVERT(varchar(30),a.transaction_id)=${literal(tx)} AND CONVERT(varchar(50),a.transaction_begin_time,126)=${literal(start)}`))
      if(!row)return missing(snapshot)
      const rolling=row[1]==='rollback'||/ROLLBACK/i.test(row[2]??'')
      if(row[0]==='7'||rolling)snapshot.status='rolling-back'
      metric(snapshot,'Transaction state code',row[0]);metric(snapshot,'Request state',row[1]);metric(snapshot,'Command',row[2])
      if(rolling&&row[3]!==null&&row[3]!==undefined&&row[3]!==''&&Number.isFinite(Number(row[3]))&&Number(row[3])>=0&&Number(row[3])<=100)snapshot.percent=Number(row[3])
    }
  } catch {snapshot.status='unavailable';snapshot.metrics=[];snapshot.percent=null;snapshot.notices.push('Diagnostics could not be read. Check monitoring privileges, connection health and engine support. Retry this read manually; no session control is repeated.')}
  return snapshot
}

/** One transient capture per source, bounded globally and by a fixed lifetime. */
export class RollbackInspections {
  private captures=new Map<string,Capture>()
  constructor(private now=Date.now){}
  forget(sessionId:string){this.captures.delete(sessionId)}
  clear(){this.captures.clear()}
  async capture(observer:ActivityObserver,session:SessionInfo,targetId:string,expected?:ActivityTarget) {
    const capture=await captureRollback(observer,session,targetId,this.now(),expected)
    this.forget(session.id)
    while(this.captures.size>=20)this.captures.delete(this.captures.keys().next().value!)
    this.captures.set(session.id,structuredClone(capture));return structuredClone(capture.snapshot)
  }
  async inspect(observer:ActivityObserver,session:SessionInfo,id:string) {
    const capture=this.captures.get(session.id)
    if(!capture||capture.snapshot.id!==id||capture.snapshot.database!==session.database||Date.parse(capture.snapshot.expiresAt)<=this.now())throw new Error('Rollback inspection expired, was replaced or belongs to another connection/database. Select a visible session to start a new inspection.')
    return refreshRollback(observer,capture,this.now())
  }
}
