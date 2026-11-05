import { useMemo, useRef, useState } from 'react'
import type { DataComparison } from '../shared/data-compare'
import { synchronizationPlan } from '../shared/synchronization-plan'
import { ComparisonValues } from './ComparisonValues'
import { ModalDialog } from './ModalDialog'

export function SynchronizationReview({ result, selected, onClose, onSaved }: {
  result: DataComparison
  selected: Set<string>
  onClose(): void
  onSaved(): void
}) {
  const { plan, text, fits } = useMemo(() => {
    const plan = synchronizationPlan(result, selected)
    const text = JSON.stringify(plan, null, 2) + '\n'
    return { plan, text, fits: new TextEncoder().encode(text).byteLength <= 1_000_000 }
  }, [result, selected])
  const [operationIndex, setOperationIndex] = useState(0)
  const operation = plan.operations[operationIndex]
  const [reviewed, setReviewed] = useState(false)
  const [approvedDeletes, setApprovedDeletes] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const deletes = plan.operations.filter(operation => operation.action === 'delete').length
  const inserts = plan.operations.filter(operation => operation.action === 'insert').length
  const updates = plan.operations.length - inserts - deletes
  const count = (number: number, action: string) => `${number} ${action}${number === 1 ? '' : 's'}`
  async function save() {
    if (pending.current || !fits || !reviewed || deletes && !approvedDeletes) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const path = await window.dbCommander.saveValue({ text, format: 'synchronization-plan' })
      if (path) onSaved()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return <ModalDialog className="connection-dialog migration-export-dialog" aria-label="Review synchronization plan" onDismiss={() => { if (!busy) onClose() }}>
    <div className="dialog-heading">
      <div><h2>Review synchronization plan</h2><p>{count(inserts, 'insert')} · {count(updates, 'update')} · {count(deletes, 'delete')}</p></div>
      <button aria-label="Close synchronization review" disabled={busy} onClick={onClose}>×</button>
    </div>
    <p><strong>Source</strong> {plan.source.label}</p>
    <p><strong>Target</strong> {plan.target.label}</p>
    <p>These proposals come from sequential reads. Recheck both tables and the captured target values before applying changes manually.</p>
    <section aria-label="Proposed operation">
      <label>Review operation<select value={operationIndex} onChange={event => setOperationIndex(Number(event.target.value))}>
        {plan.operations.map((item, index) => <option key={JSON.stringify(item.key)} value={index}>
          {item.action === 'insert' ? 'Insert' : item.action === 'update' ? 'Update' : 'Delete'} · {JSON.stringify(item.key)}
        </option>)}
      </select></label>
      <ComparisonValues columns={plan.columns} left={operation.expectedTarget} right={operation.proposedRow}
        labels={['Expected target', 'Proposed row']} changed={operation.columnsToWrite}/>
    </section>
    <details><summary>Exact JSON file</summary><label>Plan contents<textarea readOnly spellCheck={false} value={text}/></label></details>
    <p>The exported JSON contains the captured values. Review it before sharing.</p>
    {!fits && <p role="alert">The plan exceeds 1 MB. Return to the comparison and select fewer rows.</p>}
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy}>
      <label className="check-field"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>I reviewed the proposed operations and target.</label>
      {deletes > 0 && <label className="check-field"><input type="checkbox" checked={approvedDeletes} onChange={event => setApprovedDeletes(event.target.checked)}/>I understand this plan proposes deleting target rows.</label>}
    </fieldset>
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>Back to comparison</button>
      <button className="primary-button" disabled={busy || !fits || !reviewed || Boolean(deletes && !approvedDeletes)} onClick={() => void save()}>Save synchronization plan</button>
    </div>
  </ModalDialog>
}
