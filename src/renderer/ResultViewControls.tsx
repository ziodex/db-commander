import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Column } from '../shared/contracts'
import { MAX_RESULT_FILTERS, MAX_RESULT_SORTS, resultFilterError, type ResultExploration, type ResultFilter, type ResultFilterOperator, type ResultSort } from './result-exploration'

const operators: [ResultFilterOperator, string][] = [['contains', 'contains'], ['not-contains', 'does not contain'], ['starts-with', 'starts with'], ['eq', 'equals'], ['ne', 'does not equal'], ['lt', 'less than'], ['lte', 'less than or equal'], ['gt', 'greater than'], ['gte', 'greater than or equal'], ['is-null', 'is NULL'], ['not-null', 'is not NULL']]
export function ResultViewControls({ columns, value, onChange, matchCount, limited, matchPosition, onFind, findRequest }: {
  columns: Column[]; value: ResultExploration; onChange(value: ResultExploration): void
  matchCount: number; limited: boolean; matchPosition: number; onFind(direction: number): void; findRequest: number
}) {
  const id = useId(), [open, setOpen] = useState(false), [finding, setFinding] = useState(false)
  const findInput = useRef<HTMLInputElement>(null), focusPending = useRef(false)
  const disclosure = useRef<HTMLButtonElement>(null), returnFocus = useRef(false)
  const [filters, setFilters] = useState<ResultFilter[]>([]), [sort, setSort] = useState<ResultSort[]>([])
  const error = resultFilterError(columns, filters)
  useLayoutEffect(() => {
    if (!findRequest) return
    focusPending.current = true; setFinding(true)
  }, [findRequest])
  useLayoutEffect(() => {
    if (finding && focusPending.current) { findInput.current?.focus(); focusPending.current = false }
    if (!open && returnFocus.current) { disclosure.current?.focus(); returnFocus.current = false }
  })
  const chooseColumn = (label: string, column: number, change: (column: number) => void) => <select aria-label={label} value={column} onChange={event => change(Number(event.target.value))}>{columns.map((item, index) => <option key={index} value={index}>{index + 1}. {item.name}</option>)}</select>
  const toggle = () => { if (!open) { setFilters(value.filters.map(filter => ({ ...filter }))); setSort(value.sort.map(item => ({ ...item }))) } setOpen(!open) }
  function close() { returnFocus.current = true; setOpen(false) }
  function reset() { setFilters([]); setSort([]); onChange({ ...value, filters: [], sort: [] }) }
  return <div className="result-view-controls">
    <div className="result-find" role="search" aria-label="Find loaded result values" onKeyDown={event => event.stopPropagation()}>
      <button aria-expanded={finding} aria-controls={`${id}-find-controls`} aria-keyshortcuts="Control+F Meta+F" onClick={() => { focusPending.current = !finding; setFinding(!finding) }}>Find</button>
      <div id={`${id}-find-controls`} className="result-find-fields" hidden={!finding}>
      <label className="sr-only" htmlFor={`${id}-find`}>Find in loaded rows</label>
      <input ref={findInput} id={`${id}-find`} type="search" placeholder="Find in loaded rows" maxLength={4096} value={value.find} onChange={event => onChange({ ...value, find: event.target.value })} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onFind(event.shiftKey ? -1 : 1) }
        if (event.key === 'Escape') { event.preventDefault(); onChange({ ...value, find: '' }) }
      }}/>
      <button disabled={!matchCount} aria-label="Previous result match" onClick={() => onFind(-1)}>Previous</button>
      <button disabled={!matchCount} aria-label="Next result match" onClick={() => onFind(1)}>Next</button>
      <span className="result-find-count" role="status">{value.find ? `${matchPosition >= 0 ? `${matchPosition + 1} of ` : ''}${matchCount.toLocaleString()}${limited ? '+' : ''} matching ${matchCount === 1 ? 'cell' : 'cells'}` : ''}</span>
      <label className="result-match-case" title="Match case in Find and text filters"><input type="checkbox" checked={value.matchCase} onChange={event => onChange({ ...value, matchCase: event.target.checked })}/>Match case</label>
      </div>
      <button ref={disclosure} aria-expanded={open} aria-controls={`${id}-view`} onClick={toggle}>Filter / sort{value.filters.length + value.sort.length ? ` (${value.filters.length + value.sort.length})` : ''}</button>
      {(value.filters.length > 0 || value.sort.length > 0) && <button onClick={reset}>Reset view</button>}
    </div>
    {open && <div id={`${id}-view`} className="result-view-editor" onKeyDown={event => event.stopPropagation()}>
      <p>Apply to this pane’s loaded rows only. Filters use AND; sort keys are applied in order, with NULL last. No SQL runs. Copy follows the view; Export preview retains all fetched rows.</p>
      <div className="result-view-section"><strong>Filters</strong><button disabled={filters.length >= MAX_RESULT_FILTERS} onClick={() => setFilters([...filters, { column: 0, operator: 'contains', value: '' }])}>Add filter</button></div>
      {filters.map((filter, index) => <div className="result-view-row" key={index}>
        {chooseColumn(`Filter ${index + 1} column`, filter.column, column => setFilters(filters.map((item, i) => i === index ? { ...item, column } : item)))}
        <select aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={event => setFilters(filters.map((item, i) => i === index ? { ...item, operator: event.target.value as ResultFilterOperator } : item))}>{operators.map(([operator, label]) => <option key={operator} value={operator}>{label}</option>)}</select>
        <input aria-label={`Filter ${index + 1} value`} maxLength={4096} disabled={['is-null', 'not-null'].includes(filter.operator)} value={filter.value} onChange={event => setFilters(filters.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}/>
        <select aria-label={`Filter ${index + 1} values as`} value={filter.mode ?? 'auto'} disabled={['contains', 'not-contains', 'starts-with', 'is-null', 'not-null'].includes(filter.operator)} onChange={event => setFilters(filters.map((item, i) => i === index ? { ...item, mode: event.target.value as ResultSort['mode'] } : item))}><option value="auto">Column type</option><option value="number">Exact number</option><option value="text">Text</option></select>
        <button aria-label={`Remove filter ${index + 1}`} onClick={() => setFilters(filters.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <div className="result-view-section"><strong>Sort keys</strong><button disabled={sort.length >= MAX_RESULT_SORTS} onClick={() => setSort([...sort, { column: 0, direction: 'asc', mode: 'auto' }])}>Add sort key</button></div>
      {sort.map((item, index) => <div className="result-view-row" key={index}>
        {chooseColumn(`Sort ${index + 1} column`, item.column, column => setSort(sort.map((key, i) => i === index ? { ...key, column } : key)))}
        <select aria-label={`Sort ${index + 1} direction`} value={item.direction} onChange={event => setSort(sort.map((key, i) => i === index ? { ...key, direction: event.target.value as 'asc' | 'desc' } : key))}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
        <select aria-label={`Sort ${index + 1} values as`} value={item.mode} onChange={event => setSort(sort.map((key, i) => i === index ? { ...key, mode: event.target.value as ResultSort['mode'] } : key))}><option value="auto">Column type</option><option value="number">Exact number</option><option value="text">Text</option></select>
        <button aria-label={`Remove sort key ${index + 1}`} onClick={() => setSort(sort.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      {error && <p role="alert">{error}</p>}
      <div className="result-view-section"><button disabled={Boolean(error)} onClick={() => { onChange({ ...value, filters, sort }); close() }}>Apply locally</button><button onClick={close}>Cancel view changes</button><button onClick={reset}>Reset view</button></div>
    </div>}
  </div>
}
