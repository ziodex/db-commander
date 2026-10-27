import type { DatabaseEngine } from '../shared/contracts'

/** Fixed, read-only catalog queries. No renderer-supplied SQL or identifiers. */
export function activityQueries(engine:DatabaseEngine, includeSql:boolean) {
  if(engine==='postgres') return {
    scope:'Current database; visible PostgreSQL client sessions, locks and native blocking relationships.',
    permission:'Other users’ activity may be masked without pg_read_all_stats or equivalent privileges. Prepared transactions can appear as blocker 0. Relation/object IDs are native catalog identifiers.',
    sessions:`SELECT pid::text,usename,datname,application_name,client_addr::text,state,backend_type,
      EXTRACT(EPOCH FROM clock_timestamp()-state_change)::text,xact_start::text,backend_start::text,
      concat_ws(': ',wait_event_type,wait_event),${includeSql?'left(query,4001)':'NULL'}
      FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid LIMIT 201`,
    locks:`SELECT l.pid::text,a.datname,concat(l.locktype,' db=',l.database,' relation=',l.relation,' page=',l.page,' tuple=',l.tuple,' xid=',l.transactionid,' virtualxid=',l.virtualxid,' class=',l.classid,' object=',l.objid,' sub=',l.objsubid),l.mode,CASE WHEN l.granted THEN 'granted' ELSE 'waiting' END
      FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() ORDER BY l.granted,l.pid,l.locktype LIMIT 501`,
    waits:`SELECT a.pid::text,b.pid::text,concat_ws(': ',a.wait_event_type,a.wait_event)
      FROM pg_catalog.pg_stat_activity a CROSS JOIN LATERAL unnest(pg_catalog.pg_blocking_pids(a.pid)) b(pid)
      WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() ORDER BY a.pid,b.pid LIMIT 501`
  }
  if(engine==='mysql'||engine==='mariadb') return {
    scope:'Visible sessions across this server; InnoDB data locks and blocking relationships. Metadata/advisory locks are outside this view.',
    permission:engine==='mysql'?'Session visibility depends on PROCESS and catalog privileges. InnoDB lock inspection needs SELECT on performance_schema.data_locks, data_lock_waits and threads. Missing instrumentation or permission can hide activity.':'Session and InnoDB lock visibility depends on PROCESS. MariaDB INNODB_LOCKS lists requested locks and locks blocking other transactions, not every held lock.',
    // INFORMATION_SCHEMA also supports ordinary users’ own sessions without SELECT on performance_schema.
    sessions:`SELECT ID,USER,DB,NULL,HOST,COMMAND,STATE,TIME,NULL,NULL,STATE,${includeSql?'LEFT(INFO,4001)':'NULL'} FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() ORDER BY ID LIMIT 201`,
    locks:engine==='mysql'?`SELECT t.PROCESSLIST_ID,l.OBJECT_SCHEMA,CONCAT(l.OBJECT_SCHEMA,'.',l.OBJECT_NAME,' index=',COALESCE(l.INDEX_NAME,''),' ',l.LOCK_TYPE,' id=',l.ENGINE_LOCK_ID),l.LOCK_MODE,l.LOCK_STATUS
      FROM performance_schema.data_locks l LEFT JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID
      ORDER BY l.LOCK_STATUS DESC,l.ENGINE_LOCK_ID LIMIT 501`:
      `SELECT t.TRX_MYSQL_THREAD_ID,NULL,CONCAT(l.LOCK_TABLE,' index=',COALESCE(l.LOCK_INDEX,''),' ',l.LOCK_TYPE,' id=',l.LOCK_ID),l.LOCK_MODE,
      CASE WHEN EXISTS(SELECT 1 FROM information_schema.INNODB_LOCK_WAITS w WHERE w.REQUESTED_LOCK_ID=l.LOCK_ID) THEN 'waiting' ELSE 'granted' END
      FROM information_schema.INNODB_LOCKS l LEFT JOIN information_schema.INNODB_TRX t ON t.TRX_ID=l.LOCK_TRX_ID ORDER BY l.LOCK_ID LIMIT 501`,
    waits:engine==='mysql'?`SELECT r.PROCESSLIST_ID,b.PROCESSLIST_ID,w.REQUESTING_ENGINE_LOCK_ID FROM performance_schema.data_lock_waits w
      JOIN performance_schema.threads r ON r.THREAD_ID=w.REQUESTING_THREAD_ID JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID ORDER BY r.PROCESSLIST_ID,b.PROCESSLIST_ID LIMIT 501`:
      `SELECT r.TRX_MYSQL_THREAD_ID,b.TRX_MYSQL_THREAD_ID,w.REQUESTED_LOCK_ID FROM information_schema.INNODB_LOCK_WAITS w
      JOIN information_schema.INNODB_TRX r ON r.TRX_ID=w.REQUESTING_TRX_ID JOIN information_schema.INNODB_TRX b ON b.TRX_ID=w.BLOCKING_TRX_ID ORDER BY r.TRX_MYSQL_THREAD_ID,b.TRX_MYSQL_THREAD_ID LIMIT 501`
  }
  if(engine==='sqlserver'||engine==='azure-sql') return {
    scope:'Current database; visible user sessions, lock requests and blocking requests. One representative request per session is shown.',
    permission:'DMV visibility depends on server version and permissions (VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE, or Azure database/service-tier permissions). Negative blocker IDs are special engine owners, not ordinary sessions. Idle sessions may still hold transactions.',
    sessions:`SELECT TOP (201) CONVERT(varchar(128),s.session_id),s.login_name,DB_NAME(s.database_id),s.program_name,s.host_name,s.status,r.command,
      CONVERT(varchar(100),r.total_elapsed_time/1000.0),CONVERT(varchar(100),s.open_transaction_count),CONVERT(varchar(50),s.login_time,126),r.wait_type,${includeSql?'LEFT(txt.text,4001)':'NULL'}
      FROM sys.dm_exec_sessions s OUTER APPLY (SELECT TOP (1) * FROM sys.dm_exec_requests r WHERE r.session_id=s.session_id ORDER BY r.request_id) r
      ${includeSql?'OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) txt':''}
      WHERE s.is_user_process=1 AND s.database_id=DB_ID() AND s.session_id<>@@SPID ORDER BY s.session_id`,
    locks:`SELECT TOP (501) CONVERT(varchar(128),request_session_id),DB_NAME(resource_database_id),CONCAT(resource_type,' ',resource_subtype,' entity=',resource_associated_entity_id,' ',resource_description),request_mode,request_status
      FROM sys.dm_tran_locks WHERE resource_database_id=DB_ID() AND request_session_id<>@@SPID ORDER BY request_status DESC,request_session_id,resource_type`,
    waits:`SELECT DISTINCT TOP (501) CONVERT(varchar(128),session_id),CONVERT(varchar(128),blocking_session_id),CONCAT(wait_type,' ',wait_resource)
      FROM sys.dm_exec_requests WHERE database_id=DB_ID() AND blocking_session_id<>0 AND session_id<>@@SPID ORDER BY 1,2`
  }
  if(engine==='oracle') return {
    scope:'Current Oracle instance and container; user sessions, enqueue locks and reported blocking sessions. IDs use instance:SID; serial numbers appear in session state.',
    permission:'Reading SYS.V_$SESSION and SYS.V_$LOCK requires catalog grants; SQL text additionally needs SYS.V_$SQL. Cross-instance blockers may be outside this snapshot. This is an enqueue view, not a complete latch/OS-lock inventory.',
    sessions:`SELECT SYS_CONTEXT('USERENV','INSTANCE')||':'||TO_CHAR(s.SID),s.USERNAME,SYS_CONTEXT('USERENV','CON_NAME'),s.PROGRAM,s.MACHINE,s.STATUS||' (serial '||TO_CHAR(s.SERIAL#)||')',TO_CHAR(s.COMMAND),TO_CHAR(s.LAST_CALL_ET),CASE WHEN s.TADDR IS NULL THEN NULL ELSE 'transaction address '||s.TADDR END,TO_CHAR(s.LOGON_TIME,'YYYY-MM-DD"T"HH24:MI:SS'),CASE WHEN s.STATE='WAITING' THEN s.EVENT ELSE NULL END,${includeSql?'SUBSTR(q.SQL_TEXT,1,4001)':'NULL'}
      FROM SYS.V_$SESSION s ${includeSql?'LEFT JOIN SYS.V_$SQL q ON q.SQL_ID=s.SQL_ID AND q.CHILD_NUMBER=s.SQL_CHILD_NUMBER AND q.CON_ID=s.CON_ID':''}
      WHERE s.TYPE='USER' AND s.CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND s.SID<>TO_NUMBER(SYS_CONTEXT('USERENV','SID')) ORDER BY s.SID FETCH FIRST 201 ROWS ONLY`,
    locks:`SELECT SYS_CONTEXT('USERENV','INSTANCE')||':'||TO_CHAR(l.SID),SYS_CONTEXT('USERENV','CON_NAME'),l.TYPE||' id1='||TO_CHAR(l.ID1)||' id2='||TO_CHAR(l.ID2),'held='||TO_CHAR(l.LMODE)||' requested='||TO_CHAR(l.REQUEST),CASE WHEN l.REQUEST>0 THEN 'waiting' ELSE 'granted' END
      FROM SYS.V_$LOCK l JOIN SYS.V_$SESSION s ON s.SID=l.SID WHERE s.TYPE='USER' AND s.CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND l.SID<>TO_NUMBER(SYS_CONTEXT('USERENV','SID')) ORDER BY l.REQUEST DESC,l.SID,l.TYPE FETCH FIRST 501 ROWS ONLY`,
    waits:`SELECT SYS_CONTEXT('USERENV','INSTANCE')||':'||TO_CHAR(SID),TO_CHAR(BLOCKING_INSTANCE)||':'||TO_CHAR(BLOCKING_SESSION),EVENT
      FROM SYS.V_$SESSION WHERE TYPE='USER' AND CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')) AND BLOCKING_SESSION_STATUS='VALID' AND SID<>TO_NUMBER(SYS_CONTEXT('USERENV','SID')) ORDER BY SID FETCH FIRST 501 ROWS ONLY`
  }
  throw new Error('Embedded engines use local connection inspection.')
}
