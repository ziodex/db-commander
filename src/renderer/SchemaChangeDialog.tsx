import { useEffect, useRef, useState } from 'react'
import { X } from './WorkbenchIcons'
import { MigrationExportDialog } from './MigrationExportDialog'
import { objectKey, type CatalogObject } from '../shared/catalog'
import type { SchemaSnapshot, SessionInfo } from '../shared/contracts'
import { columnTypes, schemaActions, supportsCreateSchema, type SchemaChange, type SchemaChangePlan, type SchemaChangeResult, type SchemaColumnInput, type ApplySchemaChange } from '../shared/schema-changes'

const freshColumn = (): SchemaColumnInput => ({ name: '', type: 'varchar', length: 255, precision: 18, scale: 2, nullable: true, primaryKey: false, default: { kind: 'none' } })
export function SchemaChangeDialog({ session, snapshot, initialTarget, blocked, onClose, onPrepare, onApply }: {
  session: SessionInfo; snapshot: SchemaSnapshot | null; initialTarget?: CatalogObject; blocked?: string;
  onClose(): void; onPrepare(change: SchemaChange): Promise<SchemaChangePlan>; onApply(request: ApplySchemaChange): Promise<SchemaChangeResult>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [action, setAction] = useState<SchemaChange['action']>(initialTarget ? 'add-column' : 'create-table')
  const [targetKey, setTargetKey] = useState(initialTarget ? objectKey(initialTarget) : '')
  const [schema, setSchema] = useState(initialTarget?.schema ?? (session.engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(session.engine) ? 'dbo' : session.engine === 'oracle' ? session.user.toUpperCase() : ['sqlite','duckdb'].includes(session.engine) ? 'main' : session.database))
  const [catalog, setCatalog] = useState(initialTarget?.catalog ?? session.database)
  const [name, setName] = useState(''), [column, setColumn] = useState(''), [columns, setColumns] = useState<SchemaColumnInput[]>([{ ...freshColumn(), name: 'id', type: 'integer', nullable: false, primaryKey: !initialTarget }])
  const [indexColumns, setIndexColumns] = useState<string[]>([]), [unique, setUnique] = useState(false)
  const [plan, setPlan] = useState<SchemaChangePlan>(), [result, setResult] = useState<SchemaChangeResult>()
  const [migration, setMigration] = useState(false)
  const [busy, setBusy] = useState<'review' | 'apply' | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [confirmed, setConfirmed] = useState(false), [implicit, setImplicit] = useState(false), [destructive, setDestructive] = useState(false), [cancelling, setCancelling] = useState(false)
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  const targets = (snapshot?.catalog?.objects ?? []).filter(o => o.kind === (action === 'drop-index' ? 'index' : 'table'))
  const target = targets.find(o => objectKey(o) === targetKey)
  const targetColumns = snapshot?.objects.find(o => o.name === target?.name && o.schema === target?.schema && o.catalog === target?.catalog)?.columns.map(c => c.name) ?? []
  const creating = action === 'create-table' || action === 'create-schema'
  function changed() { setPlan(undefined); setResult(undefined); setError(''); setMessage(''); setConfirmed(false); setImplicit(false); setDestructive(false) }
  function updateColumn(index: number, patch: Partial<SchemaColumnInput>) { changed(); setColumns(previous => previous.map((c,i) => i === index ? { ...c, ...patch } : c)) }
  function changeRequest(): SchemaChange {
    const location = { schema, ...(session.engine === 'duckdb' ? { catalog } : {}) }
    if (action === 'create-schema') return { action, location }
    if (action === 'create-table') return { action, location, name, columns }
    if (!target) throw new Error('Select an object from the current catalog. Refresh the sidebar if it is missing.')
    if (action === 'add-column') return { action, target, column: { ...columns[0], primaryKey: false } }
    if (action === 'rename-column') return { action, target, column, name }
    if (action === 'drop-column') return { action, target, column }
    if (action === 'rename-table') return { action, target, name }
    if (action === 'create-index') return { action, target, name, columns: indexColumns, unique }
    return { action, target }
  }
  async function review() {
    setBusy('review'); changed()
    try { setPlan(await onPrepare(changeRequest())) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  async function apply() {
    if (!plan) return
    setBusy('apply'); setError(''); setMessage(''); setCancelling(false)
    try { setResult(await onApply({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: implicit, destructiveApproved: destructive })) }
    catch (e) { setError((e as Error).message); setPlan(undefined) }
    finally { setBusy(null) }
  }
  async function cancel() { setCancelling(true); try { await window.dbCommander.cancelSchemaChange(session.id); setMessage('Cancellation requested. Waiting for the database and transaction cleanup.') } catch (e) { setError((e as Error).message) } }
  return <dialog ref={dialog} className="connection-dialog schema-editor" aria-label="Schema changes" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>Schema changes</h2><p>{session.name} · {session.database} · {session.engine}</p></div><button aria-label="Close schema changes" disabled={Boolean(busy)} onClick={onClose}><X size={18}/></button></div>
    <p>Create or alter objects with generated SQL. Review the target and transaction behavior before applying a change.</p>
    {blocked && !busy && <p role="alert">{blocked}</p>}
    <fieldset disabled={Boolean(busy)} className="schema-edit-fields">
      <label>Change<select aria-label="Schema operation" value={action} onChange={e => { changed(); setAction(e.target.value as SchemaChange['action']); setColumn(''); setIndexColumns([]) }}>{Object.entries(schemaActions).filter(([action]) => action !== 'create-schema' || supportsCreateSchema(session.engine)).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {creating ? <div className="schema-edit-row">{session.engine === 'duckdb' && <label>Catalog<input aria-label="Target catalog" value={catalog} onChange={e => { changed(); setCatalog(e.target.value) }}/></label>}<label>{action === 'create-schema' ? 'New schema name' : 'Schema / namespace'}<input aria-label="Target schema" value={schema} onChange={e => { changed(); setSchema(e.target.value) }}/></label></div> : <label>Target object<select aria-label="Schema target" value={targetKey} onChange={e => { changed(); setTargetKey(e.target.value); setColumn(''); setIndexColumns([]) }}><option value="">Select an object…</option>{targets.map(o => <option key={objectKey(o)} value={objectKey(o)}>{[o.catalog,o.schema,o.name].filter(Boolean).join('.')}{o.parent ? ` on ${o.parent}` : ''}</option>)}</select></label>}
      {['create-table','rename-table','rename-column','create-index'].includes(action) && <label>{action === 'create-index' ? 'Index name' : action === 'create-table' ? 'Table name' : 'New name'}<input aria-label="New object name" value={name} onChange={e => { changed(); setName(e.target.value) }}/></label>}
      {['rename-column','drop-column'].includes(action) && <label>Column<select aria-label="Existing column" value={column} onChange={e => { changed(); setColumn(e.target.value) }}><option value="">Select a column…</option>{targetColumns.map(name => <option key={name}>{name}</option>)}</select></label>}
      {['create-table','add-column'].includes(action) && <><div className="schema-column-list">{columns.slice(0, action === 'add-column' ? 1 : columns.length).map((c,index) => <fieldset className="schema-column" key={index}><legend>Column {index + 1}</legend>
        <div className="schema-edit-row"><label>Name<input aria-label={`Column ${index + 1} name`} value={c.name} onChange={e => updateColumn(index, { name: e.target.value })}/></label><label>{c.generation?.kind === 'computed' && ['sqlserver','azure-sql'].includes(session.engine) ? 'Type (inferred by database)' : 'Type'}<select aria-label={`Column ${index + 1} type`} disabled={c.generation?.kind === 'computed' && ['sqlserver','azure-sql'].includes(session.engine)} value={c.type} onChange={e => updateColumn(index, { type: e.target.value as SchemaColumnInput['type'] })}>{columnTypes.map(type => <option key={type}>{type}</option>)}</select></label>
          {c.type === 'varchar' && !(c.generation?.kind === 'computed' && ['sqlserver','azure-sql'].includes(session.engine)) && <label>Length<input aria-label={`Column ${index + 1} length`} type="number" min={1} max={4000} value={c.length} onChange={e => updateColumn(index, { length: Number(e.target.value) })}/></label>}
          {c.type === 'decimal' && !(c.generation?.kind === 'computed' && ['sqlserver','azure-sql'].includes(session.engine)) && <><label>Precision<input aria-label={`Column ${index + 1} precision`} type="number" min={1} max={38} value={c.precision} onChange={e => updateColumn(index, { precision: Number(e.target.value) })}/></label><label>Scale<input aria-label={`Column ${index + 1} scale`} type="number" min={0} max={38} value={c.scale} onChange={e => updateColumn(index, { scale: Number(e.target.value) })}/></label></>}
        </div><div className="schema-edit-row"><label className="check-field"><input aria-label={`Column ${index + 1} nullable`} type="checkbox" checked={c.nullable && !(c.primaryKey && action === 'create-table')} disabled={c.generation?.kind === 'identity' || c.primaryKey && action === 'create-table'} onChange={e => updateColumn(index, { nullable: e.target.checked })}/>Nullable</label>{action === 'create-table' && <label className="check-field"><input aria-label={`Column ${index + 1} primary key`} type="checkbox" checked={c.primaryKey} onChange={e => updateColumn(index, { primaryKey: e.target.checked, ...(e.target.checked ? { nullable: false } : {}) })}/>Primary key</label>}
          <label>Default<select aria-label={`Column ${index + 1} default kind`} value={c.default.kind} onChange={e => { const kind = e.target.value; updateColumn(index, { default: kind === 'text' || kind === 'number' || kind === 'expression' ? { kind, value: kind === 'number' ? '0' : '' } : kind === 'boolean' ? { kind, value: false } : { kind: kind as 'none' | 'null' } }) }}>{['none','text','number','boolean','null','expression'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
          {(c.default.kind === 'text' || c.default.kind === 'number') && <label>Literal value<input aria-label={`Column ${index + 1} default value`} value={c.default.value} onChange={e => updateColumn(index, { default: { kind: c.default.kind as 'text' | 'number', value: e.target.value } })}/></label>}
          {c.default.kind === 'boolean' && <label>Value<select aria-label={`Column ${index + 1} default value`} value={String(c.default.value)} onChange={e => updateColumn(index, { default: { kind: 'boolean', value: e.target.value === 'true' } })}><option>false</option><option>true</option></select></label>}
          {c.default.kind === 'expression' && <label>SQL expression<input aria-label={`Column ${index + 1} default expression`} maxLength={4000} value={c.default.value} onChange={e => updateColumn(index, { default: { kind: 'expression', value: e.target.value } })}/></label>}
          {action === 'create-table' && columns.length > 1 && <button aria-label={`Remove column ${index + 1}`} onClick={() => { changed(); setColumns(columns.filter((_,i) => i !== index)) }}>Remove</button>}
        </div><div className="schema-edit-row"><label>Generation<select aria-label={`Column ${index + 1} generation`} value={c.generation?.kind ?? 'none'} onChange={e => {
          const kind = e.target.value
          if (kind === 'identity') updateColumn(index, { generation: { kind, mode: ['postgres','oracle'].includes(session.engine) ? 'by-default' : 'auto' }, nullable: false })
          else if (kind === 'computed') updateColumn(index, { generation: { kind, expression: '', storage: session.engine === 'postgres' ? 'stored' : 'virtual' } })
          else updateColumn(index, { generation: undefined })
        }}><option value="none">None</option><option value="identity" disabled={session.engine === 'duckdb'}>Identity</option><option value="computed">Generated expression</option></select></label>
          {c.generation?.kind === 'identity' && ['postgres','oracle'].includes(session.engine) && <label>Identity mode<select aria-label={`Column ${index + 1} identity mode`} value={c.generation.mode} onChange={e => updateColumn(index, { generation: { kind: 'identity', mode: e.target.value as 'always' | 'by-default' } })}><option value="by-default">By default</option><option value="always">Always</option></select></label>}
          {c.generation?.kind === 'identity' && ['mysql','mariadb'].includes(session.engine) && <label className="check-field"><input aria-label={`Column ${index + 1} identity unique key`} type="checkbox" checked={Boolean(c.generation.unique)} onChange={e => updateColumn(index, { generation: { kind: 'identity', mode: 'auto', unique: e.target.checked } })}/>Create a unique key for this identity</label>}
          {c.generation?.kind === 'computed' && <><label>Generated SQL expression<input aria-label={`Column ${index + 1} generated expression`} maxLength={4000} value={c.generation.expression} onChange={e => updateColumn(index, { generation: { kind: 'computed', expression: e.target.value, storage: c.generation!.kind === 'computed' ? c.generation!.storage : 'virtual' } })}/></label><label>Storage<select aria-label={`Column ${index + 1} generated storage`} value={c.generation.storage} onChange={e => updateColumn(index, { generation: { kind: 'computed', expression: c.generation!.kind === 'computed' ? c.generation!.expression : '', storage: e.target.value as 'virtual' | 'stored' } })}><option value="virtual" disabled={session.engine === 'postgres' && Number(/^PostgreSQL\s+(\d+)/i.exec(session.version)?.[1] ?? 0) < 18}>Virtual</option><option value="stored" disabled={['duckdb','oracle'].includes(session.engine) || session.engine === 'sqlite' && action === 'add-column'}>{['sqlserver','azure-sql'].includes(session.engine) ? 'Persisted' : 'Stored'}</option></select></label></>}
        </div></fieldset>)}</div>{action === 'create-table' && <button disabled={columns.length >= 100} onClick={() => { changed(); setColumns([...columns, freshColumn()]) }}>Add another column</button>}<p>Types map to each engine’s native types. SQL expressions run in the database; review them and their effects before applying. {session.engine === 'sqlite' && action === 'add-column' && 'SQLite cannot add a column with an expression default. '}{session.engine === 'duckdb' && action === 'add-column' && 'DuckDB cannot add a generated column to an existing table. '}Generated and identity columns cannot also have a default; engine rules determine which types and keys are allowed.</p></>}
      {action === 'create-index' && <><label className="check-field"><input type="checkbox" checked={unique} onChange={e => { changed(); setUnique(e.target.checked) }}/>Unique index</label><fieldset><legend>Index columns (selection order)</legend>{targetColumns.map(name => <label key={name} className="check-field"><input aria-label={`Index column ${name}`} type="checkbox" checked={indexColumns.includes(name)} onChange={e => { changed(); setIndexColumns(e.target.checked ? [...indexColumns,name] : indexColumns.filter(c => c !== name)) }}/>{name}</label>)}</fieldset></>}
      <button className="primary-button" disabled={Boolean(blocked)} onClick={() => void review()}>Review SQL</button>
    </fieldset>
    {busy && <p role="status">{busy === 'review' ? 'Preparing SQL and checking metadata…' : 'Applying schema change…'}</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {plan && <section className="schema-review"><h3>Review SQL</h3><p>{plan.connection} · {plan.database} · Review expires {new Date(plan.expiresAt).toLocaleTimeString()}</p>{plan.warnings.map(warning => <p key={warning}>{warning}</p>)}<textarea aria-label="Schema SQL preview" readOnly spellCheck={false} value={plan.sql}/>
      <div className="object-actions"><button disabled={Boolean(busy)} onClick={() => void window.dbCommander.copyDefinition(plan.sql).then(() => setMessage('SQL copied.')).catch(e => setError((e as Error).message))}>Copy SQL</button><button disabled={Boolean(busy)} onClick={() => void window.dbCommander.saveSql(plan.sql).then(path => path && setMessage('SQL saved.')).catch(e => setError((e as Error).message))}>Save SQL</button></div>
      <fieldset disabled={Boolean(busy) || Boolean(result)}><label className="check-field"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I reviewed this SQL and its target.</label>{plan.transaction === 'implicit-commit' && <label className="check-field"><input type="checkbox" checked={implicit} onChange={e => setImplicit(e.target.checked)}/>I understand this DDL commits immediately and cannot be rolled back.</label>}{plan.destructive && <label className="check-field"><input type="checkbox" checked={destructive} onChange={e => setDestructive(e.target.checked)}/>I understand this can remove data or database safeguards.</label>}
        <button className="primary-button" disabled={Boolean(blocked) || !confirmed || plan.transaction === 'implicit-commit' && !implicit || plan.destructive && !destructive} onClick={() => void apply()}>Apply reviewed SQL</button></fieldset>
    </section>}
    {busy === 'apply' && <button disabled={cancelling} onClick={() => void cancel()}>Cancel schema change</button>}
    {result && <p role={result.status === 'completed' ? 'status' : 'alert'}>{result.message}</p>}
    {plan && <button disabled={Boolean(busy) || !plan.migrationSourceId} onClick={() => setMigration(true)}>Export migration…</button>}
    {migration && plan?.migrationSourceId && <MigrationExportDialog sourceId={plan.migrationSourceId} engine={plan.engine} selected={['change']} includeDestructive={plan.destructive} onClose={() => setMigration(false)}/>}
  </dialog>
}
