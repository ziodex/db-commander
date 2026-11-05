import { useLayoutEffect, useRef, useState } from 'react'
import { ModalDialog } from './ModalDialog'
import type { sqlRenameReview } from './language-service'

export function SqlRenameDialog({ review, onClose }: { review: ReturnType<typeof sqlRenameReview>; onClose(): void }) {
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof review.preview>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { if (preview) heading.current?.focus() }, [preview])

  async function prepare() {
    if (busy) return
    setError('')
    setPreview(undefined)
    setBusy(true)
    try { setPreview(await review.preview(name)) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  function apply() {
    if (!preview) return
    try { review.apply(preview.plan); onClose() }
    catch (cause) { setPreview(undefined); setError((cause as Error).message) }
  }

  return <ModalDialog className="connection-dialog sql-rename-dialog" aria-label="Review alias rename" onDismiss={onClose}>
    <div className="dialog-heading"><div><h2>Rename query alias</h2><p>Review the affected references in this statement before editing the buffer.</p></div></div>
    <form onSubmit={event => { event.preventDefault(); void prepare() }}>
      <label>New alias name<input autoFocus value={name} maxLength={63} disabled={busy} onChange={event => { setName(event.target.value); setPreview(undefined); setError('') }}/></label>
      <button type="submit" disabled={!name.trim() || busy}>{busy ? 'Checking references…' : 'Preview rename'}</button>
    </form>
    {error && <p role="alert" className="dialog-error">{error}</p>}
    {preview && <section className="sql-rename-preview" aria-label="Rename changes">
      <h3 ref={heading} tabIndex={-1}>{preview.rows.length} changes to <code>{preview.plan.name}</code></h3>
      <table><thead><tr><th>Line</th><th>Before</th><th>After</th></tr></thead><tbody>
        {preview.rows.map(row => <tr key={`${row.line}:${row.column}`}><th scope="row">{row.line}:{row.column}</th>
          <td><code>{row.prefix}<strong>{row.before}</strong>{row.suffix}</code></td>
          <td><code>{row.prefix}<strong>{preview.plan.replacement}</strong>{row.suffix}</code></td></tr>)}
      </tbody></table>
    </section>}
    <div className="dialog-actions"><button onClick={onClose}>Cancel</button>
      <button className="primary-button" disabled={!preview || busy} onClick={apply}>Apply rename</button></div>
  </ModalDialog>
}
