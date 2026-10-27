import { useEffect, useRef, useState } from 'react'
import type { ActivityActionReview, ActivityActionResult } from '../shared/activity-control'

export function ActivityActionDialog({review,onClose,onApplied}:{review:ActivityActionReview;onClose():void;onApplied(result:ActivityActionResult):void}) {
  const ref=useRef<HTMLDialogElement>(null),pending=useRef(false)
  const [confirmation,setConfirmation]=useState(''),[acknowledge,setAcknowledge]=useState(false),[busy,setBusy]=useState(false),[used,setUsed]=useState(false),[error,setError]=useState('')
  useEffect(()=>{const node=ref.current!;node.showModal();return()=>node.close()},[])
  async function apply() {
    if(pending.current||used)return
    pending.current=true;setBusy(true);setUsed(true)
    try{onApplied(await window.dbCommander.applyActivityAction({sessionId:review.sessionId,reviewId:review.id,confirmation,acknowledge:true}))}
    catch(e){setError(`${(e as Error).message} No automatic retry. Close this review and refresh the inspector before deciding what to do next.`)}
    finally{pending.current=false;setBusy(false)}
  }
  return <dialog ref={ref} className="connection-dialog activity-action-dialog" aria-label="Review session action" onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();e.stopPropagation();if(!pending.current)onClose()}}>
    <div className="dialog-heading"><h2>{review.action==='cancel'?'Review statement cancellation':'Review session termination'}</h2><button disabled={busy} aria-label="Close action review" onClick={onClose}>×</button></div>
    <p>Issuing connection: <strong>{review.connection}</strong> · {review.engine} · {review.database||'server'}</p>
    <p>Target: <strong>{review.targetId}</strong> · User: {review.user} · Database: {review.targetDatabase||'none'} · Client: {review.client||'not reported'}</p>
    <p>Native identity: {review.identity.join(' / ')}<br/>Active statement identity: {review.statement?.join(' / ')??'none or unavailable'}<br/>Transaction: {review.transaction??'none reported; this does not prove there is no uncommitted work'}</p>
    {review.warnings.map(w=><p key={w}>{w}</p>)}
    <label>Reviewed server command<textarea aria-label="Reviewed session command" readOnly value={review.sql} spellCheck={false}/></label>
    <p>Single use. Expires {new Date(review.expiresAt).toLocaleTimeString()}. {used?'This review has been consumed. Verify the outcome before any further action.':'No command has been sent yet.'}</p>
    <label className="activity-check"><input type="checkbox" checked={acknowledge} disabled={busy||used} onChange={e=>setAcknowledge(e.target.checked)}/>I understand the transaction and connection impact.</label>
    <label>Type {review.confirmation}<input aria-label="Session action confirmation" autoComplete="off" value={confirmation} disabled={busy||used} onChange={e=>setConfirmation(e.target.value)}/></label>
    {error&&<p role="alert">{error}</p>}{busy&&<p role="status">Revalidating and sending the request. Do not repeat it; the outcome is not yet known.</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Close review</button><button className="primary-button" disabled={busy||used||!acknowledge||confirmation!==review.confirmation||Date.now()>=Date.parse(review.expiresAt)} onClick={()=>void apply()}>Apply reviewed {review.action==='cancel'?'cancellation':'termination'}</button></div>
  </dialog>
}
