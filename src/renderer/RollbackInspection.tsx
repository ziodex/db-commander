import { useEffect, useRef } from 'react'
import { rollbackStatus, type RollbackSnapshot } from '../shared/rollback'

export function RollbackInspection({snapshot,busy,onRefresh,onDismiss}:{snapshot:RollbackSnapshot;busy:boolean;onRefresh():void;onDismiss():void}) {
  const ref=useRef<HTMLElement>(null)
  useEffect(()=>{ref.current?.focus({preventScroll:true});ref.current?.scrollIntoView({block:'start'})},[snapshot.id])
  return <section ref={ref} tabIndex={-1} className="activity-detail rollback-inspection" aria-label="Rollback progress inspection">
    <h3>Rollback progress · session {snapshot.targetId}</h3>
    <p><strong>{rollbackStatus[snapshot.status]}</strong></p>
    <p>Captured {new Date(snapshot.capturedAt).toLocaleString()} · Last read {new Date(snapshot.fetchedAt).toLocaleTimeString()}<br/>Inspection expires {new Date(snapshot.expiresAt).toLocaleTimeString()}. {snapshot.identity.length>0?'Refresh follows this captured transaction, even if its session disappears.':'No transaction identity was captured; a refresh cannot attach to a future transaction.'}</p>
    {snapshot.identity.length>0&&<p className="rollback-identity">Captured identity: {snapshot.identity.join(' / ')}</p>}
    {snapshot.percent!==null?<p><progress aria-label="Reported rollback progress" max={100} value={snapshot.percent}/>{' '}{snapshot.percent.toFixed(2)}% reported</p>:<p>No percentage or estimated completion time is available.</p>}
    {snapshot.metrics.length>0&&<dl>{snapshot.metrics.map(m=><div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>)}</dl>}
    {snapshot.notices.map(n=><p key={n}>{n}</p>)}
    <p>This inspection contains no SQL text and is kept only in memory. Closing this window clears its display; starting another inspection replaces the capture. It is not included in the sessions and locks report.</p>
    <div className="activity-controls"><button disabled={busy||Date.now()>=Date.parse(snapshot.expiresAt)} onClick={onRefresh}>Refresh rollback progress</button><button disabled={busy} onClick={onDismiss}>Dismiss rollback inspection</button></div>
  </section>
}
