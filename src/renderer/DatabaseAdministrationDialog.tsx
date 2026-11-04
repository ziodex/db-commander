import { useEffect, useRef, useState } from 'react'
import { administrationActions, administrationChangeSchema, administrationLabels, type AdministrationChange, type AdministrationResult, type AdministrationReview, type AdministrationTarget, type ApplyAdministration } from '../shared/database-administration'
import type { SessionInfo } from '../shared/contracts'
import { engineNames } from '../shared/database-engines'
import { ModalDialog } from './ModalDialog'
import { rendererError } from './workspace-runtime'

const outcomeLabels: Record<AdministrationResult['status'], string> = {
  applied: 'Operation completed',
  rejected: 'Operation rejected',
  partial: 'Possible partial changes',
  issues: 'Check reported issues',
  unknown: 'Outcome unknown'
}

export function DatabaseAdministrationDialog({ session, target, fallbackFocus, blocked, onClose, onPrepare, onApply }: {
  session: SessionInfo
  target: AdministrationTarget
  fallbackFocus: HTMLElement | null
  blocked?: string
  onClose(): void
  onPrepare(change: AdministrationChange): Promise<AdministrationReview>
  onApply(request: ApplyAdministration, change: AdministrationChange): Promise<AdministrationResult>
}) {
  const table = 'table' in target
  const currentDatabase = !table && target.database === session.database
  const available = administrationActions(session.engine, table ? 'table' : 'database')
  const choices = currentDatabase ? available.filter(choice => choice !== 'rename-database' && choice !== 'drop-database') : available
  const [action, setAction] = useState<AdministrationChange['action']>(choices.includes('rename-database') ? 'rename-database' : choices[0])
  const needsName = action === 'create-database' || action === 'rename-database'
  const [name, setName] = useState('')
  const [review, setReview] = useState<{ plan: AdministrationReview; change: AdministrationChange }>()
  const [result, setResult] = useState<AdministrationResult>()
  const [busy, setBusy] = useState<'preparing' | 'applying'>()
  const [error, setError] = useState('')
  const [used, setUsed] = useState(false)
  const [acknowledge, setAcknowledge] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const pending = useRef(false), actionInput = useRef<HTMLSelectElement>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null), resultHeading = useRef<HTMLHeadingElement>(null), errorMessage = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (review) reviewHeading.current?.focus()
    else actionInput.current?.focus()
  }, [review])
  useEffect(() => { if (result) resultHeading.current?.focus() }, [result])
  useEffect(() => { if (error) errorMessage.current?.focus() }, [error])

  async function run(stage: NonNullable<typeof busy>, operation: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(stage); setError('')
    try { await operation() }
    catch (error) { setError(rendererError(error)) }
    finally { pending.current = false; setBusy(undefined) }
  }

  function prepare() {
    if (blocked) return
    void run('preparing', async () => {
      const change = administrationChangeSchema.parse(table ? { action, ...target }
        : action === 'create-database' ? { action, database: name }
          : action === 'rename-database' ? { action, database: target.database, destination: name }
            : { action, database: target.database })
      setReview({ plan: await onPrepare(change), change })
    })
  }

  function back() {
    setReview(undefined); setResult(undefined); setUsed(false)
    setAcknowledge(false); setConfirmation(''); setError('')
  }

  const locked = Boolean(session.safety?.protected && session.safety.unlockedUntil <= Date.now())
  const canApply = review && !blocked && !locked && !busy && !used && acknowledge && confirmation === review.plan.confirmation
  const reviewedTarget = review && <><strong>{administrationLabels[review.change.action]}</strong> · {review.plan.target}
    <br />{review.plan.scope}</>
  const heading = table ? 'Table maintenance' : 'Database administration'
  return <ModalDialog className="connection-dialog database-administration-dialog" aria-labelledby="database-administration-title" fallbackFocus={fallbackFocus}
    onDismiss={() => { if (!pending.current) onClose() }}>
    <div className="dialog-heading"><div>
      <h2 id="database-administration-title">{heading}</h2>
      <p>{session.name} · {session.database} · {engineNames[session.engine]}</p>
    </div><button type="button" aria-label={`Close ${heading.toLowerCase()}`} disabled={Boolean(busy)} onClick={onClose}>×</button></div>

    {!review ? <form onSubmit={event => { event.preventDefault(); prepare() }}>
      <p>{table ? <>Table <strong>{target.schema}.{target.table}</strong></> : <>Selected database <strong>{target.database}</strong></>}</p>
      {currentDatabase && available.includes('drop-database') && <p>Open a connection to another database to {available.includes('rename-database') ? 'rename or drop' : 'drop'} this database.</p>}
      {!table && available.includes('create-database') && !available.includes('rename-database') && <p>{session.engine === 'azure-sql'
        ? 'This workflow supports database creation. Reviewed rename and drop are unavailable.'
        : `${engineNames[session.engine]} has no native database rename operation.`}</p>}
      <label>Operation<select ref={actionInput} value={action} disabled={Boolean(busy)}
        onChange={event => { setAction(event.target.value as AdministrationChange['action']); setName(''); setError('') }}>
        {choices.map(value => <option value={value} key={value}>{administrationLabels[value]}</option>)}
      </select></label>
      {needsName && <label>New database name
        <input value={name} maxLength={255} disabled={Boolean(busy)} onChange={event => setName(event.target.value)} />
      </label>}
      {!busy && blocked && <p role="status">{blocked}</p>}
      {busy && <p role="status">Checking the database catalog…</p>}
      {error && <p role="alert" tabIndex={-1} ref={errorMessage}>{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={Boolean(busy)}>Close</button>
        <button type="submit" className="primary-button" disabled={Boolean(busy || blocked) || needsName && !name.trim()}>Review operation</button></div>
    </form> : result ? <section aria-labelledby="database-administration-outcome">
      <h3 id="database-administration-outcome" tabIndex={-1} ref={resultHeading}>{outcomeLabels[result.status]}</h3>
      <p>{reviewedTarget}</p>
      <p>{result.message}</p>
      <div className="dialog-actions"><button type="button" onClick={onClose}>Close</button></div>
    </section> : <section aria-labelledby="database-administration-review">
      <h3 id="database-administration-review" ref={reviewHeading} tabIndex={-1}>Review {administrationLabels[review.change.action].toLowerCase()}</h3>
      <p>Connected as <strong>{review.plan.observer}</strong> in <strong>{review.plan.database}</strong></p>
      <label>Reviewed SQL<textarea readOnly spellCheck={false} value={review.plan.sql} /></label>
      <ul>{review.plan.notes.map(note => <li key={note}>{note}</li>)}</ul>
      <p>Single-use review. Expires at <time dateTime={review.plan.expiresAt}>{new Date(review.plan.expiresAt).toLocaleTimeString()}</time>.</p>
      <label className="save-profile-option"><input type="checkbox" disabled={Boolean(busy || used || locked)} checked={acknowledge}
        onChange={event => setAcknowledge(event.target.checked)} />I reviewed the SQL and its effects.</label>
      <label><span id="database-administration-confirmation">Type <strong>{review.plan.confirmation}</strong> to confirm</span>
        <input aria-label="Administration confirmation" aria-describedby="database-administration-confirmation" autoComplete="off" maxLength={600} value={confirmation} disabled={Boolean(busy || used || locked)}
          onChange={event => setConfirmation(event.target.value)} /></label>
      <p id="database-administration-target">{reviewedTarget}{review.change.action === 'drop-database' && ' · Permanently deletes data'}</p>
      {!busy && (locked || blocked) && <p role="status">{locked ? 'Unlock the protected connection before applying this operation.' : blocked}</p>}
      {busy && <p role="status">Rechecking the target and applying the reviewed operation…</p>}
      {error && <p role="alert" tabIndex={-1} ref={errorMessage}>{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={back} disabled={Boolean(busy)}>Back to operation</button>
        <button type="button" className="primary-button" aria-describedby="database-administration-target" disabled={!canApply}
          onClick={() => { if (canApply) void run('applying', async () => {
            setUsed(true)
            setResult(await onApply({ sessionId: session.id, reviewId: review.plan.id, confirmation, acknowledge: true }, review.change))
          }) }}>Apply operation</button></div>
    </section>}
  </ModalDialog>
}
