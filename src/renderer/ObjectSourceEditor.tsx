import { useEffect, useRef, useState } from 'react'
import type { ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import type { ApplySchemaChange, SchemaChange, SchemaChangePlan, SchemaChangeResult } from '../shared/schema-changes'

export function ObjectSourceEditor({ detail, initialSql, session, blocked, onRefresh, onPrepare, onApply, onExit }: {
  detail: ObjectDetail; initialSql: string; session: SessionInfo; blocked?: string
  onRefresh(): void; onPrepare(change: SchemaChange): Promise<SchemaChangePlan>; onApply(request: ApplySchemaChange): Promise<SchemaChangeResult>; onExit(): void
}) {
  const [base, setBase] = useState(detail.definition.sql!), [draft, setDraft] = useState(initialSql)
  const [plan, setPlan] = useState<SchemaChangePlan>(), [result, setResult] = useState<SchemaChangeResult>()
  const [busy, setBusy] = useState<'review' | 'apply' | null>(null), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false), [destructive, setDestructive] = useState(false), [implicit, setImplicit] = useState(false), [message, setMessage] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const current = detail.definition.sql, stale = !current || detail.definition.truncated || current !== base
  useEffect(() => { if (plan && heading.current) { heading.current.focus({ preventScroll: true }); heading.current.scrollIntoView?.({ block: 'start' }) } }, [plan])
  function changed() { setPlan(undefined); setResult(undefined); setError(''); setConfirmed(false); setDestructive(false); setImplicit(false); setMessage('') }
  async function review() {
    changed(); setBusy('review')
    try { setPlan(await onPrepare({ action: 'edit-source', target: detail.object, baseDefinition: base, sql: draft })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(null) }
  }
  async function apply() {
    if (!plan) return
    setBusy('apply'); setError('')
    try { setResult(await onApply({ sessionId: session.id, planId: plan.id, confirmed: true, destructiveApproved: destructive, implicitCommitApproved: implicit })) }
    catch (e) { setError((e as Error).message); setPlan(undefined) }
    finally { setBusy(null) }
  }
  return <section aria-label="Edit object source">
    <h3>Edit source</h3><p>Compare your draft with the definition loaded from the database. Review the exact SQL before applying it.</p>
    {blocked && !busy && <p role="alert">{blocked}</p>}
    {stale && <div role="alert"><p>The database definition has changed or is unavailable. Your draft is retained. Compare the latest definition before choosing a new baseline.</p>{current && !detail.definition.truncated && <><label>Latest database definition<textarea aria-label="Latest database definition" className="object-definition" readOnly spellCheck={false} value={current}/></label><button disabled={Boolean(busy)} onClick={() => { setBase(current); changed() }}>Use latest as comparison baseline</button></>}</div>}
    <div className="comparison-definitions"><label>Loaded definition<textarea aria-label="Loaded definition" className="object-definition" readOnly spellCheck={false} value={base}/></label><label>Edited source<textarea aria-label="Edited source" className="object-definition" spellCheck={false} maxLength={1000000} disabled={Boolean(busy)} value={draft} onChange={event => { setDraft(event.target.value); changed() }}/></label></div>
    <div className="object-actions"><button disabled={Boolean(busy)} onClick={onRefresh}>Check current definition</button><button disabled={Boolean(busy) || stale || Boolean(blocked) || !draft.trim()} onClick={() => void review()}>Review source SQL</button><button disabled={Boolean(busy)} onClick={onExit}>Discard draft and close editor</button></div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {plan && <section aria-label="Source SQL review"><h3 tabIndex={-1} ref={heading}>Review source SQL</h3><p>{plan.connection} · {plan.database} · {plan.transaction === 'transactional' ? 'Transaction: commit or roll back' : 'DDL may commit implicitly'}</p>{plan.warnings.map(warning => <p key={warning}>{warning}</p>)}<textarea aria-label="Source SQL preview" className="object-definition" readOnly spellCheck={false} value={plan.sql}/>
      <label className="source-review-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> I reviewed this SQL and its target.</label>
      {plan.destructive && <label className="source-review-check"><input type="checkbox" checked={destructive} onChange={event => setDestructive(event.target.checked)}/> I understand this may change or remove an existing object and its dependencies.</label>}
      {plan.transaction === 'implicit-commit' && <label className="source-review-check"><input type="checkbox" checked={implicit} onChange={event => setImplicit(event.target.checked)}/> I understand the database can commit these changes implicitly.</label>}
      <div className="object-actions"><button disabled={Boolean(busy) || stale || Boolean(blocked) || !confirmed || plan.destructive && !destructive || plan.transaction === 'implicit-commit' && !implicit || Boolean(result)} onClick={() => void apply()}>Apply reviewed source</button>{busy === 'apply' && <button onClick={() => void window.dbCommander.cancelSchemaChange(session.id).then(() => setMessage('Cancellation requested. Waiting for the database.'), e => setError((e as Error).message))}>Cancel application</button>}</div>
      {result && <p role="status">{result.message}</p>}
    </section>}
  </section>
}
