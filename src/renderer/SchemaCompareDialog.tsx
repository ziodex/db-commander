import { useEffect, useRef, useState } from 'react'
import { objectKinds } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { orderMigrationDrops } from '../shared/migration-order'
import { SCHEMA_DETAIL_LIMIT, SCHEMA_INVENTORY_LIMIT, comparisonSql, type CompareSchemaRequest, type SchemaComparison } from '../shared/schema-compare'
import { tabOperationBusy, type QueryTabState } from './query-tabs'
import { MigrationExportDialog } from './MigrationExportDialog'

const PAGE_SIZE = 25
type Scope = { schema: string; catalog: string }

export function SchemaCompareDialog({ target, tabs, load, onClose, onOpen }: {
  target: SessionInfo
  tabs: { id: string; title: string; state: QueryTabState }[]
  load(request: CompareSchemaRequest): Promise<SchemaComparison>
  onClose(): void
  onOpen(sql: string): void
}) {
  const candidates = tabs.filter(tab => tab.state.session?.engine === target.engine)
  const initial = candidates.find(tab => tab.state.session?.id !== target.id) ?? candidates[0]
  function defaults(id: string): Scope {
    const state = candidates.find(tab => tab.state.session?.id === id)?.state
    const session = state?.session ?? target
    const table = state?.schema?.catalog?.objects.find(object => object.kind === 'table')
    const schema = {
      postgres: 'public', sqlserver: 'dbo', 'azure-sql': 'dbo', oracle: session.user.toUpperCase(),
      mysql: session.database, mariadb: session.database, sqlite: 'main', duckdb: 'main'
    }[session.engine]
    return { schema: table?.schema ?? schema, catalog: table?.catalog ?? (session.engine === 'duckdb' ? session.database : '') }
  }
  const [sourceId, setSourceId] = useState(initial?.state.session?.id ?? target.id)
  const [sourceScope, setSourceScope] = useState(() => defaults(sourceId))
  const [targetScope, setTargetScope] = useState(() => defaults(target.id))
  const [filter, setFilter] = useState('')
  const [kinds, setKinds] = useState<CompareSchemaRequest['kinds']>(['table', 'view'])
  const [result, setResult] = useState<SchemaComparison | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [focus, setFocus] = useState('')
  const [status, setStatus] = useState('differences')
  const [page, setPage] = useState(0)
  const [destructive, setDestructive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [migration, setMigration] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), pending = useRef(false)
  const resultsHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const node = dialog.current!
    active.current = true
    node.showModal()
    return () => { active.current = false; node.close() }
  }, [])
  useEffect(() => { if (result) resultsHeading.current?.focus() }, [result])

  const owners = [sourceId, target.id].map(id => candidates.find(tab => tab.state.session?.id === id)?.state)
  const blocked = owners.some(state => !state?.session || tabOperationBusy(state) || state.gridChanges.length ||
    state.session.transaction !== 'idle' || state.session.engine !== 'oracle' && state.session.autocommit === false)
  const invalidScope = !sourceScope.schema || !targetScope.schema || !kinds.length

  function invalidate() {
    setResult(null)
    setSelected([])
    setFocus('')
    setPage(0)
    setStatus('differences')
    setDestructive(false)
    setError('')
    setMessage('')
  }
  async function compare(mode: 'inventory' | 'definitions', selection?: string[]) {
    if (pending.current || blocked || invalidScope) return
    pending.current = true
    setBusy(true)
    // Keep the inventory and its selection available if a definition read fails.
    if (!selection) invalidate()
    else { setError(''); setMessage('') }
    const scope = (sessionId: string, value: Scope) => ({
      sessionId, schema: value.schema, ...(value.catalog ? { catalog: value.catalog } : {})
    })
    try {
      const next = await load({ source: scope(sourceId, sourceScope), target: scope(target.id, targetScope), filter, kinds, mode, selection })
      if (!active.current) return
      setResult(next)
      setSelected(mode === 'inventory' ? [] : next.objects.filter(object => object.status !== 'matching' && object.status !== 'unknown').map(object => object.key))
      setFocus(next.objects.find(object => object.status !== 'matching')?.key ?? next.objects[0]?.key ?? '')
      setStatus('differences')
      setPage(0)
      setDestructive(false)
      setMessage(mode === 'inventory' ? `${next.objects.length} visible object names compared. Select objects to review their definitions.` :
        `${next.objects.length} ${next.objects.length === 1 ? 'object' : 'objects'} compared. No SQL executed.`)
    } catch (cause) {
      if (active.current) setError((cause as Error).message)
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }

  const inventory = result?.mode === 'inventory'
  const sql = result && !inventory ? comparisonSql(result, selected, destructive) : ''
  const item = result?.objects.find(object => object.key === focus)
  const filtered = result?.objects.filter(object =>
    status === 'all' || status === 'differences' && object.status !== 'matching' || object.status === status) ?? []
  let dependencyError = ''
  if (destructive && result) {
    try { orderMigrationDrops(result.objects.filter(object => selected.includes(object.key) && object.destructiveSql.length)) }
    catch (cause) { dependencyError = (cause as Error).message }
  }
  const sqlBlocked = !selected.length || sql.length > 1_000_000

  return <dialog ref={dialog} className="connection-dialog schema-compare-dialog" aria-label="Compare schemas"
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading">
      <div><h2>Compare schemas</h2><p>Target {target.name} · {target.host}{target.port ? `:${target.port}` : ''} / {target.database}</p></div>
      <button disabled={busy} aria-label="Close schema comparison" onClick={onClose}>×</button>
    </div>
    <fieldset disabled={busy} className="comparison-scope">
      <legend>Comparison scope</legend>
      <label>Source tab<select value={sourceId} onChange={event => {
        setSourceId(event.target.value); setSourceScope(defaults(event.target.value)); invalidate()
      }}>{candidates.map(tab => <option key={tab.id} value={tab.state.session!.id}>{tab.title} · {tab.state.session!.name} / {tab.state.session!.database}</option>)}</select></label>
      <label>Source schema<input maxLength={255} value={sourceScope.schema} onChange={event => { setSourceScope({ ...sourceScope, schema: event.target.value }); invalidate() }}/></label>
      <label>Target schema<input maxLength={255} value={targetScope.schema} onChange={event => { setTargetScope({ ...targetScope, schema: event.target.value }); invalidate() }}/></label>
      {target.engine === 'duckdb' && <>
        <label>Source catalog<input maxLength={255} value={sourceScope.catalog} onChange={event => { setSourceScope({ ...sourceScope, catalog: event.target.value }); invalidate() }}/></label>
        <label>Target catalog<input maxLength={255} value={targetScope.catalog} onChange={event => { setTargetScope({ ...targetScope, catalog: event.target.value }); invalidate() }}/></label>
      </>}
      <label>Object name contains<input maxLength={200} value={filter} onChange={event => { setFilter(event.target.value); invalidate() }}/></label>
      <label>Object kinds<select multiple value={kinds} onChange={event => {
        setKinds([...event.target.selectedOptions].map(option => option.value as CompareSchemaRequest['kinds'][number])); invalidate()
      }}>{objectKinds.map(kind => <option key={kind}>{kind}</option>)}</select></label>
    </fieldset>
    <p>Compare up to {SCHEMA_INVENTORY_LIMIT.toLocaleString('en-US')} visible names per side, or compare definitions for up to {SCHEMA_DETAIL_LIMIT} objects per side. Reads use live metadata from each connection in sequence.</p>
    {blocked && !busy && <p role="alert">Finish both tabs’ operations, commit or roll back, and apply or discard staged edits before comparing.</p>}
    <div className="comparison-controls">
      <button disabled={busy || blocked || invalidScope} onClick={() => void compare('inventory')}>Compare inventory</button>
      <button disabled={busy || blocked || invalidScope} onClick={() => void compare('definitions')}>{busy ? 'Comparing schemas…' : 'Compare schemas'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {result && <>
      <h3 tabIndex={-1} ref={resultsHeading}>{inventory ? 'Visible object inventory' : 'Compared definitions'}</h3>
      <details><summary>Scope and limitations</summary><p>Source {result.sourceLabel}</p><p>Target {result.targetLabel}</p>{result.notices.map(notice => <p key={notice}>{notice}</p>)}</details>
      <label>Show objects<select value={status} onChange={event => { setStatus(event.target.value); setPage(0) }}>
        <option value="differences">{inventory ? 'All inventory entries' : 'Differences and unknown'}</option>
        {!inventory && <option value="all">All objects</option>}
        <option value="source-only">Source only</option><option value="target-only">Target only</option>
        {inventory ? <option value="unchecked">Present on both sides</option> : ['changed', 'matching', 'unknown'].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <div className="comparison-list" role="group" aria-label="Compared objects">
        {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(object => {
          const checked = selected.includes(object.key)
          const label = `${object.name}${object.parent ? ` on ${object.parent}` : ''}${object.signature ? ` (${object.signature})` : ''} · ${object.kind} · ${object.status === 'unchecked' ? 'present on both sides' : object.status}`
          const checkbox = <input type="checkbox" aria-label={`${inventory ? 'Select definition for' : 'Include'} ${object.kind} ${object.name}`}
            disabled={busy || (inventory ? selected.length >= SCHEMA_DETAIL_LIMIT && !checked : object.status === 'matching' || object.status === 'unknown')}
            checked={checked} onChange={event => {
              const include = event.target.checked
              setSelected(values => include ? [...values, object.key] : values.filter(value => value !== object.key))
            }}/>
          return inventory ? <label className="inventory-entry" key={object.key}>{checkbox}<span>{label}</span></label> :
            <div key={object.key}>{checkbox}<button aria-pressed={focus === object.key} onClick={() => setFocus(object.key)}>{label}</button></div>

        })}
        {!filtered.length && <p>No objects match this view.</p>}
      </div>
      <nav className="comparison-controls" aria-label="Compared object pages">
        <button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous objects</button>
        <span>{filtered.length} {filtered.length === 1 ? 'object' : 'objects'} · page {page + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}</span>
        <button disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(value => value + 1)}>Next objects</button>
      </nav>
      {inventory ? <div className="comparison-controls">
        <button disabled={busy || blocked || !selected.length} onClick={() => void compare('definitions', selected)}>Compare selected definitions</button>
        <span>{selected.length} of {SCHEMA_DETAIL_LIMIT} selected</span>
      </div> : <>
        {item && <section><h3>{item.name} · {item.status}</h3>{item.notices.map(notice => <p key={notice}>{notice}</p>)}
          <div className="comparison-definitions">{(['source', 'target'] as const).map(side => <details key={side}>
            <summary>{side === 'source' ? 'Source' : 'Target'} definition and metadata</summary>
            <pre aria-label={`${side} definition`}>{item[side]?.definition.sql ?? 'No readable definition.'}</pre>
            <pre>{JSON.stringify(item[side]?.sections ?? [], null, 2)}</pre>
          </details>)}</div>
        </section>}
        <label className="comparison-check"><input type="checkbox" checked={destructive} onChange={event => setDestructive(event.target.checked)}/>Include destructive DROP TABLE suggestions; I understand these remove target data.</label>
        {dependencyError && <p role="alert">{dependencyError}</p>}
        <label>Review SQL<textarea aria-label="Comparison SQL preview" readOnly value={sql}/></label>
        {sql.length > 1_000_000 && <p role="alert">Select fewer objects before copying, saving or opening SQL. SQL documents are limited to 1 MB.</p>}
        <div className="dialog-actions">
          <button disabled={sqlBlocked} onClick={() => { void window.dbCommander.copyDefinition(sql).then(() => setMessage('SQL copied.'), cause => setError(cause.message)) }}>Copy comparison SQL</button>
          <button disabled={sqlBlocked} onClick={() => { void window.dbCommander.saveSql(sql).then(path => { if (path) setMessage('Comparison SQL saved.') }, cause => setError(cause.message)) }}>Save comparison SQL</button>
          <button disabled={sqlBlocked} onClick={() => onOpen(sql)}>Open SQL in target tab</button>
        </div>
        <p>Open the review in a query tab on the target connection. Confirm the scope and dependencies before running SQL.</p>
        <button disabled={!selected.length || !result.migrationSourceId || Boolean(dependencyError)} onClick={() => setMigration(true)}>Export migration…</button>
        {migration && result.migrationSourceId && <MigrationExportDialog sourceId={result.migrationSourceId} engine={result.engine} selected={selected} includeDestructive={destructive} onClose={() => setMigration(false)}/>}
      </>}
    </>}
  </dialog>
}
