import { useEffect, useRef, useState } from 'react'
import type { GridFilter, GridTable, SessionInfo } from '../shared/contracts'
import type { DataCompareRequest, DataComparison, DataDifference } from '../shared/data-compare'
import type { QueryTabState } from './query-tabs'

type Tab = { id: string; title: string; state: QueryTabState }
const tableId = (table: GridTable) => JSON.stringify([table.catalog ?? '', table.schema, table.name])
const tableLabel = (table: GridTable) => [table.catalog, table.schema, table.name].filter(Boolean).join('.')
const operators = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts-with', 'is-null', 'not-null'] as const
function Filters({ side, value, columns, onChange }: { side: string; value: GridFilter[]; columns: string[]; onChange(filters: GridFilter[]): void }) {
  function change(index: number, filter: GridFilter) { onChange(value.map((v, i) => i === index ? filter : v)) }
  return <fieldset className="data-filters"><legend>{side} filters (AND)</legend>
    {value.map((filter, index) => <div key={index}>
      <select aria-label={`${side} filter ${index + 1} column`} value={filter.column} onChange={e => change(index, { ...filter, column: e.target.value })}>{columns.map(name => <option key={name}>{name}</option>)}</select>
      <select aria-label={`${side} filter ${index + 1} operator`} value={filter.operator} onChange={e => {
        const operator = e.target.value as typeof operators[number]
        change(index, operator === 'is-null' || operator === 'not-null' ? { column: filter.column, operator } : { column: filter.column, operator, value: 'value' in filter ? filter.value : '' })
      }}>{operators.map(op => <option key={op}>{op}</option>)}</select>
      {'value' in filter && <input aria-label={`${side} filter ${index + 1} value`} maxLength={16384} value={filter.value} onChange={e => change(index, { ...filter, value: e.target.value })}/>}
      <button aria-label={`Remove ${side.toLowerCase()} filter ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button>
    </div>)}
    <button disabled={value.length >= 8 || !columns.length} onClick={() => onChange([...value, { column: columns[0], operator: 'eq', value: '' }])}>Add {side.toLowerCase()} filter</button>
  </fieldset>
}
export function DataCompareDialog({ target, initialTable, tabs, load, onClose }: {
  target: SessionInfo; initialTable?: GridTable; tabs: Tab[]; load(request: DataCompareRequest): Promise<DataComparison>; onClose(): void
}) {
  const candidates = tabs.filter(tab => tab.state.session?.engine === target.engine)
  const tables = (id: string) => tabs.find(t => t.state.session?.id === id)?.state.schema?.objects.filter(o => o.kind === 'table') ?? []
  const firstSource = candidates.find(tab => tab.state.session?.id !== target.id)?.state.session?.id ?? target.id
  const [sourceId, setSourceId] = useState(firstSource)
  const [targetTable, setTargetTable] = useState<GridTable | undefined>(initialTable ?? tables(target.id)[0])
  const [sourceTable, setSourceTable] = useState<GridTable | undefined>(() => tables(firstSource).find(t => t.name === targetTable?.name) ?? tables(firstSource)[0])
  const [keys, setKeys] = useState<string[]>([]), [columns, setColumns] = useState<string[]>([])
  const [sourceFilters, setSourceFilters] = useState<GridFilter[]>([]), [targetFilters, setTargetFilters] = useState<GridFilter[]>([])
  const [maxRows, setMaxRows] = useState(100), [result, setResult] = useState<DataComparison | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [status, setStatus] = useState('differences'), [search, setSearch] = useState(''), [page, setPage] = useState(0), [focused, setFocused] = useState<DataDifference | null>(null)
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), pending = useRef(false)
  useEffect(() => { const node = dialog.current!; active.current = true; node.showModal(); return () => { active.current = false; node.close() } }, [])
  const names = (id: string, table?: GridTable) => tables(id).find(t => table && tableId(t) === tableId(table))?.columns.map(c => c.name) ?? []
  const sourceNames = names(sourceId, sourceTable), targetNames = names(target.id, targetTable), common = sourceNames.filter(name => targetNames.includes(name))
  const owners = [sourceId, target.id].map(id => tabs.find(t => t.state.session?.id === id)?.state)
  const blocked = owners.some(s => !s?.session || s.running || s.schemaLoading || s.gridBusy || s.transferBusy || s.backupBusy || s.switching || s.databasesLoading || s.connecting || s.closing || s.gridChanges.length || s.session.transaction !== 'idle' || s.session.engine !== 'oracle' && s.session.autocommit === false)
  function invalidate() { setResult(null); setFocused(null); setMessage(''); setError(''); setPage(0) }
  function resetTables() { invalidate(); setKeys([]); setColumns([]); setSourceFilters([]); setTargetFilters([]) }
  async function compare() {
    if (pending.current || !sourceTable || !targetTable) return
    pending.current = true; setBusy(true); invalidate()
    const scope = (id: string, table: GridTable, filters: GridFilter[]) => ({ sessionId: id, table: { schema: table.schema, name: table.name, ...(table.catalog ? { catalog: table.catalog } : {}) }, filters })
    try {
      const next = await load({ source: scope(sourceId, sourceTable, sourceFilters), target: scope(target.id, targetTable, targetFilters), keys, columns, maxRows })
      if (active.current) { setResult(next); setMessage(`Compared ${next.sourceRows} source and ${next.targetRows} target rows. No data changed.`); setFocused(next.rows.find(r => r.status !== 'matching') ?? next.rows[0] ?? null) }
    } catch (e) { if (active.current) setError((e as Error).message) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  const filtered = result?.rows.filter(row => (status === 'all' || status === 'differences' && row.status !== 'matching' || row.status === status) && JSON.stringify(row).toLowerCase().includes(search.toLowerCase())) ?? []
  const report = result ? JSON.stringify(result, null, 2) : ''
  const print = (value: string | null | undefined) => value === undefined ? 'Row absent' : JSON.stringify(value)
  return <dialog ref={dialog} className="connection-dialog data-compare-dialog" aria-label="Compare table data" onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>Compare table data</h2><p>Target: {target.name} · {target.host} / {target.database}</p></div><button disabled={busy} aria-label="Close data comparison" onClick={onClose}>×</button></div>
    <p>Compare complete, bounded row sets by a unique key. Reads use each tab’s session. Nothing is written, synchronized or added to query history.</p>
    <fieldset disabled={busy} className="comparison-scope"><legend>Tables and limits</legend>
      <label>Source tab<select aria-label="Source tab" value={sourceId} onChange={e => { setSourceId(e.target.value); setSourceTable(tables(e.target.value).find(t => t.name === targetTable?.name) ?? tables(e.target.value)[0]); resetTables() }}>{candidates.map(t => <option key={t.id} value={t.state.session!.id}>{t.title} · {t.state.session!.name} / {t.state.session!.database}</option>)}</select></label>
      <label>Source table<select aria-label="Source table" value={sourceTable ? tableId(sourceTable) : ''} onChange={e => { setSourceTable(tables(sourceId).find(t => tableId(t) === e.target.value)); resetTables() }}><option value="" disabled>Select a table</option>{tables(sourceId).map(t => <option key={tableId(t)} value={tableId(t)}>{tableLabel(t)}</option>)}</select></label>
      <label>Target table<select aria-label="Target table" value={targetTable ? tableId(targetTable) : ''} onChange={e => { setTargetTable(tables(target.id).find(t => tableId(t) === e.target.value)); resetTables() }}><option value="" disabled>Select a table</option>{tables(target.id).map(t => <option key={tableId(t)} value={tableId(t)}>{tableLabel(t)}</option>)}</select></label>
      <label>Maximum rows per side<input type="number" min={1} max={200} value={maxRows} onChange={e => { setMaxRows(Number(e.target.value)); invalidate() }}/></label>
      <label>Key columns<select aria-label="Key columns" multiple value={keys} onChange={e => { setKeys([...e.target.selectedOptions].map(o => o.value)); invalidate() }}>{common.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>Comparison columns<select aria-label="Comparison columns" multiple value={columns} onChange={e => { setColumns([...e.target.selectedOptions].map(o => o.value)); invalidate() }}>{common.map(name => <option key={name}>{name}</option>)}</select></label>
      <button onClick={() => { setKeys([]); invalidate() }}>Use primary key</button><button onClick={() => { setColumns([]); invalidate() }}>Compare all columns</button>
      <p className="data-scope-help">No key selection uses each table’s declared primary key. No column selection compares all columns; otherwise keys are added automatically. Up to 8 key columns and 32 columns total. Selected names and types must match.</p>
      <Filters side="Source" value={sourceFilters} columns={sourceNames} onChange={value => { setSourceFilters(value); invalidate() }}/>
      <Filters side="Target" value={targetFilters} columns={targetNames} onChange={value => { setTargetFilters(value); invalidate() }}/>
    </fieldset>
    <p>Both filtered sets must fit the row limit. Values over 4,096 characters, duplicate/NULL keys, unsupported types or more than 4 MiB per side stop the comparison. Filters follow database collation; matching uses exact captured strings. Reads are sequential, not a shared snapshot, and may scan more rows than are returned.</p>
    {blocked && !busy && <p role="alert">Finish both tabs’ operations, commit or roll back, and apply or discard staged edits first.</p>}
    <button disabled={busy || blocked || !sourceTable || !targetTable || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200 || keys.length > 8 || new Set([...keys, ...columns]).size > 32} onClick={() => void compare()}>{busy ? 'Comparing data…' : 'Compare data'}</button>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {result && <>
      <p className="data-counts">{result.counts['source-only']} source-only · {result.counts['target-only']} target-only · {result.counts.changed} changed · {result.counts.matching} matching</p>
      <details><summary>Captured scope and comparison rules</summary><p>Source: {result.sourceLabel}</p><p>Target: {result.targetLabel}</p><p>Key: {result.keys.join(', ')} · Captured {result.capturedAt}</p>{result.notices.map(notice => <p key={notice}>{notice}</p>)}</details>
      <div className="data-result-controls"><label>Show rows<select aria-label="Show rows" value={status} onChange={e => { setStatus(e.target.value); setPage(0) }}>{['differences', 'all', 'source-only', 'target-only', 'changed', 'matching'].map(s => <option key={s}>{s}</option>)}</select></label><label>Search captured rows<input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}/></label></div>
      <div className="comparison-list" aria-label="Compared rows">{filtered.slice(page * 25, (page + 1) * 25).map(row => <button key={JSON.stringify(row.key)} aria-pressed={focused === row} onClick={() => setFocused(row)}>{JSON.stringify(row.key)} · {row.status}{row.changedColumns.length ? ` · ${row.changedColumns.join(', ')}` : ''}</button>)}{!filtered.length && <p>No rows match this display filter.</p>}</div>
      <div className="data-result-controls"><button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous differences</button><span>{filtered.length} captured rows · page {page + 1} of {Math.max(1, Math.ceil(filtered.length / 25))}</span><button disabled={(page + 1) * 25 >= filtered.length} onClick={() => setPage(p => p + 1)}>Next differences</button></div>
      {focused && <section aria-label="Row comparison"><h3>{JSON.stringify(focused.key)} · {focused.status}</h3><div className="data-cell-table"><table><thead><tr><th>Column</th><th>Source</th><th>Target</th></tr></thead><tbody>{result.columns.map((column, index) => <tr key={column.name} className={focused.changedColumns.includes(column.name) ? 'changed' : ''}><th>{column.name}<small>{column.type}</small></th><td><pre>{print(focused.source?.[index])}</pre></td><td><pre>{print(focused.target?.[index])}</pre></td></tr>)}</tbody></table></div></section>}
      <p>The JSON report contains captured row values and filter values. It is saved only when you choose a file.{report.length > 1_000_000 ? ' Narrow the comparison before saving: reports are limited to 1 MB.' : ''}</p>
      <div className="dialog-actions"><button disabled={report.length > 1_000_000} onClick={() => { void window.dbCommander.saveValue({ text: report, format: 'json' }).then(path => { if (path) setMessage('Data comparison report saved.') }, e => setError(e.message)) }}>Save comparison report</button></div>
    </>}
  </dialog>
}
