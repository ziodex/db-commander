import { useEffect, useRef, useState } from 'react'
import type { DatabaseEngine } from '../shared/contracts'
import type { MigrationPreview } from '../shared/migrations'
import { transactionalDdl } from '../shared/schema-changes'

export function MigrationExportDialog({ sourceId, engine, selected, includeDestructive, requiresAutocommit = false, onClose }: {
  sourceId: string; engine: DatabaseEngine; selected: string[]; includeDestructive: boolean; requiresAutocommit?: boolean; onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false)
  const [name, setName] = useState('schema_change'), [transaction, setTransaction] = useState<'caller'|'transaction'>('caller')
  const [preview, setPreview] = useState<MigrationPreview>(), [reviewed, setReviewed] = useState(false), [destructive, setDestructive] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  function invalidate() { setPreview(undefined); setReviewed(false); setDestructive(false); setError(''); setMessage('') }
  async function prepare() {
    if (pending.current) return; pending.current = true; setBusy(true); invalidate()
    try { setPreview(await window.dbCommander.prepareMigration({ sourceId, name, selected, includeDestructive, transaction })) }
    catch (e) { setError((e as Error).message) } finally { pending.current = false; setBusy(false) }
  }
  async function save() {
    if (!preview || pending.current) return; pending.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const path = await window.dbCommander.saveMigration({ id: preview.id, reviewed: true, destructiveApproved: destructive })
      setMessage(path ? `Migration exported to ${path}. No SQL executed.` : 'Export cancelled. No file was created.')
    } catch (e) { setError((e as Error).message) } finally { pending.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="connection-dialog migration-export-dialog" aria-label="Export migration" onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>Export migration</h2><p>{engine} · {selected.length} selected change{selected.length === 1 ? '' : 's'} · forward SQL file</p></div><button aria-label="Close migration export" disabled={busy} onClick={onClose}>×</button></div>
    <p>Create a new UTF-8 .sql file from this captured review. Export does not apply changes or recheck the live schema.</p>
    <fieldset disabled={busy} className="migration-options">
      <label>Migration name<input aria-label="Migration name" maxLength={80} value={name} onChange={e => { invalidate(); setName(e.target.value) }}/></label>
      <label>Transaction handling<select aria-label="Migration transaction handling" value={transaction} onChange={e => { invalidate(); setTransaction(e.target.value as typeof transaction) }}>
        <option value="caller">Managed by the runner — no transaction commands</option>
        {transactionalDdl(engine) && !requiresAutocommit && <option value="transaction">Include BEGIN and COMMIT</option>}
      </select></label>
      {requiresAutocommit && <p>This change requires an idle autocommit connection and cannot be wrapped in a transaction.</p>}
      {!transactionalDdl(engine) && <p>DDL on this engine commits implicitly and can partially succeed.</p>}
      <button disabled={!name.trim()} onClick={() => void prepare()}>Prepare migration preview</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {preview && <section>
      <p>Suggested filename: <strong>{preview.filename}</strong> · {preview.statements} SQL statement{preview.statements === 1 ? '' : 's'}. Review expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
      <details><summary>Execution notes and limitations</summary>{preview.warnings.map((warning,i) => <p key={i}>{warning}</p>)}</details>
      <label>Migration file contents<textarea aria-label="Migration file contents" readOnly spellCheck={false} value={preview.sql}/></label>
      <details><summary>File checksum (SHA-256)</summary><code className="migration-checksum">{preview.sha256}</code></details>
      <fieldset disabled={busy}>
        <label className="check-field"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>I reviewed the migration file, target and transaction handling.</label>
        {preview.destructive && <label className="check-field"><input type="checkbox" checked={destructive} onChange={e => setDestructive(e.target.checked)}/>I understand this migration includes destructive SQL.</label>}
        <div className="dialog-actions"><button className="primary-button" disabled={!reviewed || preview.destructive && !destructive} onClick={() => void save()}>{busy ? 'Exporting…' : 'Export migration file'}</button></div>
      </fieldset>
      <p>Existing files are never replaced. No rollback script or migration runner is generated.</p>
    </section>}
  </dialog>
}
