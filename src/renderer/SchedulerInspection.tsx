import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScheduleReview, SchedulerSnapshot } from '../shared/scheduler'

export function SchedulerInspection({ snapshot, busy, blocked, review, onRefresh, onReview, onBack, onApply }: {
  snapshot?: SchedulerSnapshot
  busy: boolean
  blocked?: string
  review?: ScheduleReview
  onRefresh(): void
  onReview(targetId: string): void
  onBack(): void
  onApply(confirmation: string): void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const refresh = useRef<HTMLButtonElement>(null)
  const reviewOpened = useRef(false)
  const [confirmed, setConfirmed] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [page, setPage] = useState(0)
  const [expiredReview, setExpiredReview] = useState<string>()
  const expired = !!review && expiredReview === review.id
  useEffect(() => {
    if (!review) return
    const timer = window.setTimeout(() => setExpiredReview(review.id), Math.max(0, Date.parse(review.expiresAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [review])
  useLayoutEffect(() => {
    if (review && !reviewOpened.current) { reviewOpened.current = true; heading.current?.focus() }
    else if (!review && reviewOpened.current && !busy) { reviewOpened.current = false; refresh.current?.focus() }
  }, [review, busy])

  if (review) return <section className="scheduler-review" aria-label="Review scheduler change">
    <h3 ref={heading} tabIndex={-1}>{review.action === 'enable' ? 'Enable' : 'Disable'} {review.target.kind} {review.target.name}</h3>
    <p>{review.connection} · {review.scope}</p>
    <dl>
      <div><dt>Owner</dt><dd>{review.target.owner ?? 'Unreported'}</dd></div>
      <div><dt>Schedule</dt><dd>{review.target.schedule ?? 'Unreported'}</dd></div>
    </dl>
    <p>{review.action === 'enable'
      ? 'This lets the engine run eligible work according to its schedule.'
      : 'This disables future scheduling for the selected definition. Work already in flight may continue.'}
      {review.target.kind === 'schedule' && ' This can affect every attached job.'}</p>
    <p>The engine checks the definition again before applying the change. Another administrator can still change the target between that check and the engine command.</p>
    {blocked && <p role="alert">{blocked}</p>}
    <label className="activity-check"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I reviewed this target and scheduling impact</label>
    <label>Confirmation<input disabled={busy} value={confirmation} maxLength={16} aria-describedby="scheduler-confirmation" onChange={event => setConfirmation(event.target.value)}/></label>
    <p id="scheduler-confirmation">Type {review.confirmation} to apply. Reviews expire after one minute.</p>
    <div className="dialog-actions backup-actions">
      {expired && <p className="scheduler-expiry" role="alert">This review expired. Go back and refresh schedules before reviewing again.</p>}
      <button disabled={busy} onClick={onBack}>Back to schedules</button>
      <button className="primary-button" disabled={busy || expired || !!blocked || !confirmed || confirmation !== review.confirmation} onClick={() => onApply(confirmation)}>
        {busy ? 'Applying…' : review.action === 'enable' ? 'Enable scheduling' : 'Disable scheduling'}
      </button>
    </div>
  </section>

  if (snapshot?.status === 'unsupported') return <section aria-label="Native scheduler">
    <h3>Scheduler unavailable for this engine</h3>
    <p>{snapshot.note}</p>
  </section>

  const entries = snapshot?.entries ?? [], pageSize = 20
  return <section aria-label="Native scheduler">
    {snapshot?.status === 'unavailable' && <p role="alert">{snapshot.note}</p>}
    <div className="diagnostic-summary">
      {snapshot && <p className="activity-scope"><strong>{snapshot.scope}</strong><br/>Captured {new Date(snapshot.capturedAt).toLocaleString()}</p>}
      <button ref={refresh} className="primary-button" disabled={busy} onClick={() => { setPage(0); onRefresh() }}>Refresh schedules</button>
    </div>
    {snapshot && <>
      {snapshot.status === 'available' && <p>{snapshot.note}</p>}
      {snapshot.truncated && <p>Capture limit reached. More definitions may be visible on the server.</p>}
      {snapshot.status === 'available' && (entries.length ? <>
        <div className="activity-table scheduler-table" tabIndex={0} aria-label="Captured scheduler definitions">
          <table>
            <thead><tr><th>Definition</th><th>State</th><th>Schedule</th><th>Run times</th><th>Action</th></tr></thead>
            <tbody>{entries.slice(page * pageSize, (page + 1) * pageSize).map(entry => <tr key={entry.id}>
              <td>{entry.name}<small>{entry.kind}{entry.owner && ` · ${entry.owner}`}</small></td>
              <td>{entry.enabled === null ? 'Unreported' : entry.enabled ? 'Enabled' : 'Disabled'}<small>{entry.state}</small></td>
              <td>{entry.schedule ?? 'Unreported'}</td>
              <td>Last {entry.lastRun ?? 'unreported'}<small>Next {entry.nextRun ?? 'unreported'}</small></td>
              <td>{entry.changeAllowed
                ? <button disabled={busy} aria-label={`Review ${entry.enabled ? 'disable' : 'enable'} ${entry.name}`} onClick={() => {
                  setConfirmed(false); setConfirmation(''); onReview(entry.id)
                }}>Review {entry.enabled ? 'disable' : 'enable'}</button> : 'Read-only'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {entries.length > pageSize && <div className="activity-paging">
          <button disabled={busy || page === 0} onClick={() => setPage(page - 1)}>Previous schedule page</button>
          <span>Page {page + 1} of {Math.ceil(entries.length / pageSize)}</span>
          <button disabled={busy || (page + 1) * pageSize >= entries.length} onClick={() => setPage(page + 1)}>Next schedule page</button>
        </div>}
      </> : <p>No definitions are visible to this login in this scope.</p>)}
    </>}
  </section>
}
