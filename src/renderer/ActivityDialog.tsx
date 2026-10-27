import { RollbackInspection } from './RollbackInspection'
import type { RollbackSnapshot } from '../shared/rollback'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { SessionInfo } from '../shared/contracts'
import type { ActivitySnapshot } from '../shared/activity'
import { activityControlLimit, type ActivityAction, type ActivityActionReview } from '../shared/activity-control'
import { ActivityActionDialog } from './ActivityActionDialog'

type View = 'sessions'|'locks'|'waits'
export function ActivityDialog({session,onClose}:{session:SessionInfo;onClose():void}) {
  const dialog=useRef<HTMLDialogElement>(null), pending=useRef(false), mounted=useRef(true)
  const [snapshot,setSnapshot]=useState<ActivitySnapshot>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const [includeSql,setIncludeSql]=useState(false),[view,setView]=useState<View>('sessions'),[filter,setFilter]=useState(''),[page,setPage]=useState(0),[selected,setSelected]=useState<string>(),[owner,setOwner]=useState<string>()
  const [review,setReview]=useState<ActivityActionReview>()
  const [rollback,setRollback]=useState<RollbackSnapshot>()
  async function work(action:()=>Promise<void>) {
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('')
    try{await action()}catch(e){if(mounted.current)setError((e as Error).message)}finally{pending.current=false;if(mounted.current)setBusy(false)}
  }
  function refresh() { return work(async()=>{setReview(undefined);setSnapshot(undefined);const next=await window.dbCommander.inspectActivity({sessionId:session.id,includeSql});if(mounted.current){setSnapshot(next);setSelected(undefined);setOwner(undefined);setPage(0);setMessage('Inspection complete. No session was changed.')}}) }
  function inspectRollback(targetId?:string) { return work(async()=>{const next=await window.dbCommander.inspectRollback(targetId?{sessionId:session.id,targetId}:{sessionId:session.id,inspectionId:rollback!.id});if(mounted.current)setRollback(next)}) }
  function prepare(action:ActivityAction) { return work(async()=>{const next=await window.dbCommander.prepareActivityAction({sessionId:session.id,targetId:selected!,action});if(mounted.current)setReview(next)}) }
  const initialRefresh = useEffectEvent(() => { void refresh() })
  useEffect(()=>{mounted.current=true;const node=dialog.current!;node.showModal();initialRefresh();return()=>{mounted.current=false;node.close()}},[])
  function changeView(next:View){setView(next);setPage(0);setFilter('');setOwner(undefined)}
  function findSession(id:string){changeView('sessions');setOwner(id);setSelected(id)}
  const section=snapshot?.[view], rows=(section?.rows??[]).filter(row=>!owner||('id' in row?row.id===owner:'sessionId' in row?row.sessionId===owner:row.waiting===owner||row.blocking===owner)).filter(row=>JSON.stringify(row).toLowerCase().includes(filter.toLowerCase())), visible=rows.slice(page*25,(page+1)*25)
  const detail=snapshot?.sessions.rows.find(row=>row.id===selected)
  return <dialog ref={dialog} className="connection-dialog activity-dialog" aria-label="Sessions and locks" onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();onClose()}}>
    <div className="dialog-heading"><div><h2>Sessions and locks</h2><p>{session.name} · {session.database||'server'} · {session.engine}</p></div><button aria-label="Close session inspection" onClick={onClose}>×</button></div>
    <p>Manual snapshots are read-only. Session controls require a separate review and confirmation. Your query can keep running while you inspect it; this tab’s Stop, Commit and Rollback controls remain available after closing this window.</p>
    <div className="activity-controls"><button className="primary-button" disabled={busy} onClick={()=>void refresh()}>Refresh sessions and locks</button><label className="activity-check"><input type="checkbox" disabled={busy} checked={includeSql} onChange={e=>{setIncludeSql(e.target.checked);setSnapshot(undefined);setSelected(undefined);setMessage('Refresh to capture the selected SQL-text visibility.')}}/>Include SQL text (may contain secrets)</label><button disabled={busy||!snapshot} onClick={()=>void work(async()=>{if(await window.dbCommander.saveActivity(snapshot!))setMessage('Session and lock report saved.')})}>Save inspection report</button></div>
    {busy&&<p role="status">Reading inspection data…</p>}{!busy&&message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    {rollback&&<RollbackInspection snapshot={rollback} busy={busy} onRefresh={()=>void inspectRollback()} onDismiss={()=>setRollback(undefined)}/>}
    {snapshot&&<>
      <p className="activity-scope">{snapshot.scope}<br/>Captured {new Date(snapshot.fetchedAt).toLocaleString()} · This connection: {snapshot.currentSessionId}</p>
      <details className="activity-notices"><summary>Visibility, limits and privacy</summary>{snapshot.notices.map(n=><p key={n}>{n}</p>)}</details>
      <div className="activity-views" aria-label="Inspection sections">{(['sessions','locks','waits'] as const).map(v=><button key={v} aria-pressed={view===v} onClick={()=>changeView(v)}>{v==='sessions'?'Sessions':v==='locks'?'Locks':'Blocking relationships'} ({snapshot[v].rows.length}{snapshot[v].truncated?'+':''})</button>)}</div>
      <label>Filter captured rows<input aria-label="Filter sessions and locks" value={filter} maxLength={256} onChange={e=>{setFilter(e.target.value);setPage(0)}} placeholder="Session ID, user, state or resource…"/></label>
      {owner&&<p>Showing owner {owner}. <button onClick={()=>{setOwner(undefined);setPage(0)}}>Show all owners</button></p>}
      {section?.status!=='available'&&<p role="alert">{section?.status==='unsupported'?'Not supported':'Unavailable'}: {section?.notice}</p>}
      {section?.truncated&&<p role="alert">Capture limit reached. More rows may exist; filtering searches only this captured subset.</p>}
      {section?.status==='available'&&<>
        <p>{rows.length} captured matching rows. Empty or missing rows can reflect permissions or capture timing.</p>
        <div className="activity-table" tabIndex={0} aria-label="Inspection results"><table>
          <thead><tr>{(view==='sessions'?['Session','User / application','Database / client','State / command','Age (s) / transaction','Wait']:view==='locks'?['Session','Database','Resource','Mode','Status']:['Waiting session','Blocking owner','Resource / wait']).map(h=><th key={h}>{h}</th>)}</tr></thead>
          <tbody>{visible.map((row,index)=>{
            if('id' in row)return <tr key={index} aria-selected={selected===row.id}><td><button aria-label={`Inspect session ${row.id}`} onClick={()=>setSelected(row.id)}>{row.id}{row.id===snapshot.currentSessionId?' · this connection':''}</button></td><td>{row.user??'—'}<small>{row.application}</small></td><td>{row.database??'—'}<small>{row.client}</small></td><td>{row.state??'—'}<small>{row.command}</small></td><td>{row.ageSeconds??'—'}<small>{row.transaction??'Not reported'}</small></td><td>{row.wait??'—'}</td></tr>
            if('sessionId' in row)return <tr key={index}><td>{row.sessionId?<button onClick={()=>findSession(row.sessionId!)}>{row.sessionId}</button>:'Unknown'}</td><td>{row.database??'—'}</td><td>{row.resource??'—'}</td><td>{row.mode??'—'}</td><td>{row.status??'—'}</td></tr>
            return <tr key={index}><td><button aria-label={`Inspect waiting session ${row.waiting}`} onClick={()=>findSession(row.waiting)}>{row.waiting}</button></td><td><button aria-label={`Inspect blocking owner ${row.blocking}`} onClick={()=>findSession(row.blocking)}>{row.blocking}</button></td><td>{row.resource??'—'}</td></tr>
          })}</tbody>
        </table></div>
        <div className="activity-paging"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous inspection page</button><span>Page {page+1} of {Math.max(1,Math.ceil(rows.length/25))}</span><button disabled={(page+1)*25>=rows.length} onClick={()=>setPage(p=>p+1)}>Next inspection page</button></div>
      </>}
      {selected&&!detail&&<p role="alert">Owner {selected} is not present in the captured sessions. It may be hidden, outside this scope, a special engine owner or no longer active.</p>}
      {detail&&<section className="activity-detail" aria-label="Selected session details"><h3>Session {detail.id}</h3><p>User: {detail.user??'Not reported'} · Started: {detail.startedAt??'Not reported'} · Transaction: {detail.transaction??'Not reported'}</p><button onClick={()=>{changeView('locks');setOwner(detail.id)}}>Show selected session locks</button><p>{detail.query===null?'SQL text excluded, unavailable, or not retained by this engine.':detail.queryTruncated?'SQL text truncated to 4,000 characters; engine truncation can impose a smaller limit.':'Current or last SQL as reported by the engine; it may be incomplete and can contain sensitive literals.'}</p>{detail.query!==null&&<><textarea readOnly spellCheck={false} aria-label="Session SQL text" value={detail.query}/><button disabled={busy} onClick={()=>void work(async()=>{await window.dbCommander.copyDefinition(detail.query!);setMessage('Session SQL copied.')})}>Copy session SQL</button></>}</section>}
      {detail&&<section className="activity-actions" aria-label="Session controls"><h3>Session controls</h3><button disabled={busy} onClick={()=>void inspectRollback(detail.id)}>Inspect rollback progress</button>{(['cancel','terminate'] as const).map(action=>{const reason=detail.id===snapshot.currentSessionId?'Use the owning tab’s controls for this connection.':activityControlLimit(session.engine,action);return <div key={action}><button disabled={busy||Boolean(reason)} title={reason} onClick={()=>void prepare(action)}>Review {action==='cancel'?'cancellation':'termination'}</button>{reason&&<p>{reason}</p>}</div>})}</section>}
    </>}
    {review&&<ActivityActionDialog key={review.id} review={review} onClose={()=>setReview(undefined)} onApplied={result=>{if(result.rollback)setRollback(result.rollback);setReview(undefined);setSnapshot(undefined);setSelected(undefined);if(['unknown','rejected'].includes(result.status))setError(result.message);else setMessage(result.message)}}/>}
  </dialog>
}
