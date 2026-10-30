import { X } from './WorkbenchIcons'
import { useState } from 'react'
import type { GridTable, SessionInfo } from '../shared/contracts'
import type { DataFilePreview } from '../shared/transfer'
import { inferImportColumns } from '../shared/import-inference'
import type { ApplySchemaChange, SchemaChange, SchemaChangePlan, SchemaChangeResult, SchemaColumnInput } from '../shared/schema-changes'
import { ModalDialog } from './ModalDialog'

export function CreateImportTable({ session, preview, blocked, onPrepare, onApply, onCreated, onClose }: { session: SessionInfo; preview: DataFilePreview; blocked: boolean; onPrepare(change: SchemaChange): Promise<SchemaChangePlan>; onApply(request: ApplySchemaChange): Promise<SchemaChangeResult>; onCreated(table: GridTable, transaction: boolean): void; onClose(): void }) {
  const [schema, setSchema] = useState(['sqlite','duckdb'].includes(session.engine) ? 'main' : ['sqlserver','azure-sql'].includes(session.engine) ? 'dbo' : session.engine === 'postgres' ? 'public' : session.engine === 'oracle' ? session.user.toUpperCase() : session.database)
  const [name, setName] = useState('imported_data'), [columns, setColumns] = useState(() => inferImportColumns(session.engine, preview.headers, preview.rows))
  const [plan, setPlan] = useState<SchemaChangePlan>(), [confirmed, setConfirmed] = useState(false), [implicit, setImplicit] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  function change(index: number, patch: Partial<SchemaColumnInput>) { setColumns(columns.map((column, i) => i === index ? { ...column, ...patch } : column)); setPlan(undefined); setConfirmed(false) }
  async function review() {
    setBusy(true); setError('')
    try { setPlan(await onPrepare({ action: 'create-table', location: { schema }, name, columns })); setConfirmed(false); setImplicit(false) }
    catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  async function apply() {
    if (!plan || !confirmed || blocked) return
    setBusy(true); setError('')
    try {
      const result = await onApply({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: implicit, destructiveApproved: false })
      if (result.status !== 'completed') { setError(result.message); setPlan(undefined); return }
      onCreated({ schema, name }, result.session.transaction !== 'idle')
    } catch (error) { setError((error as Error).message); setPlan(undefined) } finally { setBusy(false) }
  }
  return <ModalDialog className="connection-dialog transfer-dialog" aria-label="Create import table" onDismiss={() => { if (!busy) onClose() }}>
    <div className="dialog-heading"><h2>Create import table</h2><button disabled={busy} aria-label="Close table inference" onClick={onClose}><X size={18}/></button></div>
    <p>Suggestions use only the first {preview.rows.length} records. Later records may need wider types. Leading-zero and ambiguous values stay text; all columns allow NULL. Review every type. SQLite decimal suggestions stay text to avoid affinity rounding; boolean suggestions stay text where import coercion differs. Table creation and row import are separate operations.</p>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy || blocked}>
      <div className="form-row"><label>New table schema<input value={schema} onChange={event => { setSchema(event.target.value); setPlan(undefined) }}/></label><label>New table name<input value={name} onChange={event => { setName(event.target.value); setPlan(undefined) }}/></label></div>
      <div className="transfer-mapping">{columns.map((column, index) => <div key={index}><label>Column {index + 1} name<input value={column.name} onChange={event => change(index, { name: event.target.value })}/></label><label>Column {index + 1} type<select value={column.type} onChange={event => change(index, { type: event.target.value as SchemaColumnInput['type'] })}>{['text','varchar','bigint','decimal','boolean'].map(type => <option key={type} value={type}>{type}</option>)}</select></label>{column.type === 'varchar' && <label>Column {index + 1} length<input type="number" min={1} max={4000} value={column.length} onChange={event => change(index, { length: event.target.valueAsNumber })}/></label>}{column.type === 'decimal' && <><label>Column {index + 1} precision<input type="number" min={1} max={38} value={column.precision} onChange={event => change(index, { precision: event.target.valueAsNumber })}/></label><label>Column {index + 1} scale<input type="number" min={0} max={30} value={column.scale} onChange={event => change(index, { scale: event.target.valueAsNumber })}/></label></>}</div>)}</div>
      <button onClick={() => void review()}>Review CREATE TABLE SQL</button>
      {plan && <><pre className="transfer-sql">{plan.sql}</pre><p>Transaction behavior: {plan.transaction}. No rows are imported by this statement.</p>{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{plan.transaction === 'implicit-commit' && <label className="save-profile-option"><input type="checkbox" checked={implicit} onChange={event => setImplicit(event.target.checked)}/>I approve the database’s implicit commit.</label>}<label className="save-profile-option"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Create the reviewed empty table.</label><button className="primary-button" disabled={!confirmed || plan.transaction === 'implicit-commit' && !implicit} onClick={() => void apply()}>Create table</button></>}
    </fieldset>
  </ModalDialog>
}
