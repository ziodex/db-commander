import { useEffect, useRef, useState } from 'react'
import type { GridChange, GridFilter, GridPreview, GridQueryOptions, GridSnapshot } from '../shared/contracts'
import { EditableGrid } from './EditableGrid'
import { ResultGrid } from './ResultGrid'
import type { InspectionActions } from './ValueInspector'
import type { ColumnLayout, SavedColumnControls } from './ColumnControls'
import { ActionMenu } from './ActionMenu'
import { ChevronRight, MoreHorizontal } from './WorkbenchIcons'

const operators = { eq: 'Equals', ne: 'Does not equal', lt: 'Less than', lte: 'Less than or equal', gt: 'Greater than', gte: 'Greater than or equal', contains: 'Contains text', 'starts-with': 'Starts with', 'is-null': 'Is NULL', 'not-null': 'Is not NULL' }

function BrowseOptions({ grid, onApply, onClose }: { grid: GridSnapshot; onApply(query: GridQueryOptions): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [filters, setFilters] = useState<GridFilter[]>(grid.query.filters)
  const [sort, setSort] = useState(grid.query.sort)
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  function changeFilter(index: number, value: GridFilter) { setFilters(previous => previous.map((filter, i) => i === index ? value : filter)) }
  return <dialog ref={dialog} className="connection-dialog browse-dialog" aria-label="Table filters and sorting" onCancel={onClose}>
    <form onSubmit={event => { event.preventDefault(); onApply({ ...grid.query, offset: 0, filters, sort }); onClose() }}>
      <div className="dialog-heading"><div><h2>Filter and sort table data</h2><p>{grid.table.schema}.{grid.table.name} · Applied on the database</p></div><button type="button" aria-label="Close table options" onClick={onClose}>×</button></div>
      <h3>Match all filters</h3><p>Values are literal text, including % and _. Comparisons follow the database’s types and collation. Use Is NULL for missing values.</p>
      {filters.map((filter, index) => {
        const column = grid.columns.find(c => c.name === filter.column)!
        return <div className="browse-filter" key={index}>
          <label>Column<select aria-label={`Filter ${index + 1} column`} value={filter.column} onChange={event => {
            const selected = grid.columns.find(c => c.name === event.target.value)!
            changeFilter(index, selected.filterable ? { column: selected.name, operator: 'eq', value: '' } : { column: selected.name, operator: 'is-null' })
          }}>{grid.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
          <label>Condition<select aria-label={`Filter ${index + 1} condition`} value={filter.operator} onChange={event => {
            const operator = event.target.value as GridFilter['operator']
            changeFilter(index, operator === 'is-null' || operator === 'not-null' ? { column: filter.column, operator } : { column: filter.column, operator, value: 'value' in filter ? filter.value : '' })
          }}>{Object.entries(operators).filter(([key]) => key.endsWith('null') || column.filterable && (column.textual || !['contains', 'starts-with'].includes(key))).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          {'value' in filter && <label>Value<input aria-label={`Filter ${index + 1} value`} maxLength={16384} value={filter.value} onChange={event => changeFilter(index, { ...filter, value: event.target.value })} /></label>}
          <button type="button" aria-label={`Remove filter ${index + 1}`} onClick={() => setFilters(filters.filter((_, i) => i !== index))}>Remove</button>
        </div>
      })}
      <button type="button" disabled={filters.length >= 8} onClick={() => {
        const c = grid.columns.find(c => c.filterable) ?? grid.columns[0]
        setFilters([...filters, c.filterable ? { column: c.name, operator: 'eq', value: '' } : { column: c.name, operator: 'is-null' }])
      }}>Add filter</button>
      <h3>Sort priority</h3><p>NULLs appear last. Primary-key columns break ties automatically where available.</p>
      {sort.map((item, index) => <div className="browse-filter" key={index}>
        <label>Column<select aria-label={`Sort ${index + 1} column`} value={item.column} onChange={event => setSort(sort.map((value, i) => i === index ? { ...value, column: event.target.value } : value))}>{grid.columns.filter(c => c.sortable).map(c => <option key={c.name} value={c.name} disabled={sort.some((value, i) => i !== index && value.column === c.name)}>{c.name}</option>)}</select></label>
        <label>Direction<select aria-label={`Sort ${index + 1} direction`} value={item.direction} onChange={event => setSort(sort.map((value, i) => i === index ? { ...value, direction: event.target.value as 'asc' | 'desc' } : value))}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <button type="button" aria-label={`Remove sort ${index + 1}`} onClick={() => setSort(sort.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <button type="button" disabled={sort.length >= 3 || !grid.columns.some(c => c.sortable && !sort.some(s => s.column === c.name))} onClick={() => setSort([...sort, { column: grid.columns.find(c => c.sortable && !sort.some(s => s.column === c.name))!.name, direction: 'asc' }])}>Add sort column</button>
      <div className="dialog-actions"><button type="button" onClick={() => { setFilters([]); setSort([]) }}>Clear all</button><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Apply filters and sorting</button></div>
    </form>
  </dialog>
}

export function TableData({ grid, changes, busy, disconnected, expired, transaction, onChange, onApply, onPreview, onLoad, onClose, actions, view, onView, onBack, savedColumns }: {
  grid: GridSnapshot; changes: GridChange[]; busy: boolean; disconnected: boolean; expired: boolean; transaction: boolean
  onChange(changes: GridChange[]): void; onApply(): void; onPreview(): Promise<GridPreview>; onLoad(query: GridQueryOptions, mode: GridSnapshot['mode']): void; onClose(): void
  actions?:InspectionActions; view?:ColumnLayout; onView?(view:ColumnLayout):void; onBack?:()=>void; savedColumns?:SavedColumnControls
}) {
  const [options, setOptions] = useState(false), blocked = busy || disconnected || transaction || changes.length > 0
  const load = (query: GridQueryOptions) => onLoad(query, grid.mode)
  const pagination = <div className="data-toolbar-group table-pagination" role="group" aria-label="Table pagination">
      {onBack&&<button disabled={blocked} onClick={onBack}>Back to source table</button>}
      <button aria-label="First page" title="First page" disabled={blocked || !grid.query.offset} onClick={() => load({ ...grid.query, offset: 0 })}>First</button>
      <button aria-label="Previous page" title="Previous page" disabled={blocked || !grid.query.offset} onClick={() => load({ ...grid.query, offset: Math.max(0, grid.query.offset - grid.query.pageSize) })}><ChevronRight className="previous-page-icon" size={14}/></button>
      <span aria-live="polite" className="page-range">{grid.rows.length ? `Rows ${grid.query.offset + 1}–${grid.query.offset + grid.rows.length}` : 'No rows on this page'}</span>
      <button aria-label="Next page" title="Next page" disabled={blocked || !grid.truncated || grid.query.offset + grid.query.pageSize > 1_000_000} onClick={() => load({ ...grid.query, offset: grid.query.offset + grid.query.pageSize })}><ChevronRight size={14}/></button>
      <select aria-label="Rows per page" title="Rows per page" disabled={blocked} value={grid.query.pageSize} onChange={event => load({ ...grid.query, offset: 0, pageSize: Number(event.target.value) as GridQueryOptions['pageSize'] })}>{[25, 50, 100, 200].map(size => <option key={size} value={size}>{size} / page</option>)}</select>
    </div>
  const filters = <button disabled={blocked} title={`${grid.query.filters.length} filters, ${grid.query.sort.length} sort columns · Applied on the database`} onClick={() => setOptions(true)}>Filters &amp; sort{Boolean(grid.query.filters.length || grid.query.sort.length) && ` (${grid.query.filters.length}/${grid.query.sort.length})`}</button>
  return <div className="table-data">
    {grid.mode === 'edit' ? <><div className="data-toolbar">{pagination}{filters}</div><EditableGrid key={grid.id} grid={grid} changes={changes} busy={busy} disconnected={disconnected} expired={expired} transaction={transaction} onChange={onChange} onApply={onApply} onPreview={onPreview} onReload={() => load(grid.query)} onClose={onClose} actions={actions} view={view} onView={onView} savedColumns={savedColumns}/></> : <>
      {expired && <div className="grid-edit-hint" role="status">The last load failed or the connection changed. Reload to fetch current data.</div>}
      <ResultGrid key={grid.id} result={{ index: 0, statement: '', columns: grid.columns.map(c => ({ name: c.name, typeId: 0, typeName: c.type })), rows: grid.rows, rowCount: null, command: 'SELECT', truncated: grid.truncated }} label="Table data" rowOffset={grid.query.offset} marks={grid.cellMarks} actions={blocked||expired?undefined:actions} view={view} onView={onView} savedColumns={savedColumns}
        toolbarStart={<>{pagination}{filters}</>}
        toolbarEnd={<ActionMenu label="Table actions" items={[
          { label: 'Edit this page', disabled: blocked || expired, action: () => onLoad(grid.query, 'edit') },
          { label: 'Reload data', disabled: blocked, action: () => load(grid.query) },
          { label: 'Close data', disabled: busy, action: onClose }
        ]}><MoreHorizontal size={16}/></ActionMenu>}/>
    </>}
    <div className="browse-notice" title={`${grid.table.schema}.${grid.table.name} · ${grid.notice}`}><strong>{grid.table.schema}.{grid.table.name}</strong><span>{grid.notice}</span></div>
    {options && <BrowseOptions grid={grid} onApply={load} onClose={() => setOptions(false)} />}
  </div>
}
