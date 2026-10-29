import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { ResultSet } from '../shared/contracts'
import { resolveColumnLayout, visibleColumnIndices, type ColumnLayout } from '../shared/column-layout'
import { exploredRows, findResultMatches, type ResultExploration } from './result-exploration'
import { ResultGrid, type ResultGridSearch } from './ResultGrid'
import { ResultViewControls } from './ResultViewControls'
import { resultCommand, resultCount } from './result-navigation'

export function ResultPane({ result, label, caption, source, value, onChange, view, onView, heading, toolbar, showHeading = false, snapshot = false, partial = false }: {
  result: ResultSet; label: string; caption: string; source: string; value: ResultExploration; onChange(value: ResultExploration): void
  view?: ColumnLayout; onView(view: ColumnLayout): void; heading?: ReactNode; toolbar?: ReactNode; showHeading?: boolean; snapshot?: boolean; partial?: boolean
}) {
  const { filters, sort, matchCase } = value
  const rows = useMemo(() => exploredRows(result, { find: '', filters, sort, matchCase }), [result, filters, sort, matchCase])
  const shown = useMemo(() => ({ ...result, rows: rows.map(row => result.rows[row]) }), [result, rows])
  const layout = useMemo(() => resolveColumnLayout(Math.min(100, result.columns.length), view), [view, result.columns.length])
  const visible = useMemo(() => visibleColumnIndices(layout), [layout])
  const found = useMemo(() => findResultMatches(result, rows, visible, value.find, value.matchCase), [result, rows, visible, value.find, value.matchCase])
  const signature = JSON.stringify([value.find, value.matchCase, rows, visible])
  const [position, setPosition] = useState({ signature: '', index: -1 }), request = useRef(0)
  const [focus, setFocus] = useState<ResultGridSearch['focus']>()
  const [findRequest, setFindRequest] = useState(0)
  const current = position.signature === signature ? position.index : -1
  const filtered = value.filters.length > 0 || value.sort.length > 0
  const scope = `${rows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} loaded rows shown${result.truncated ? ' · Limited preview' : ''}${partial ? ' · Partial execution capture' : ''}`
  function find(direction: number) {
    if (!found.matches.length) return
    const index = current < 0 ? direction > 0 ? 0 : found.matches.length - 1 : (current + direction + found.matches.length) % found.matches.length
    setPosition({ signature, index }); setFocus({ ...found.matches[index], request: ++request.current })
  }
  return <section className="result-pane" aria-label={caption} aria-description={source}>
    {result.columns.length > 0 && showHeading && <>
      <div className="result-pane-heading"><strong>{caption}</strong><span title={source}>{source}</span>{heading}</div>
    </>}
    <ResultGrid result={shown} label={label} view={view} onView={onView} rowOrder={filtered ? rows : undefined} selectionKey={filtered ? rows.join(',') : ''}
      scope={scope} emptyMessage={result.rows.length > 0 && !rows.length ? 'No loaded rows match these filters. Reset the view to show the captured rows.' : undefined}
      onFind={() => setFindRequest(request => request + 1)}
      toolbarStart={<ResultViewControls columns={result.columns} value={value} onChange={onChange} matchCount={found.matches.length} limited={found.limited} matchPosition={current} onFind={find} findRequest={findRequest}/>}
      toolbarEnd={toolbar}
      search={{ text: value.find, matchCase: value.matchCase, focus: position.signature === signature ? focus : undefined }}/>
    <div className="result-footer"><span title={result.statement}>{resultCommand(result)} · {resultCount(result)}{filtered ? ` · ${rows.length.toLocaleString()} shown` : ''}{partial ? ' · Partial capture' : ''}</span><span title={`${scope}. Find searches displayed columns and full captured values. Copy follows this view; Export preview retains all fetched rows. No SQL runs for exploration.`}>{snapshot ? 'Read-only snapshot · window only' : filtered ? 'Local view · no SQL runs' : 'Read-only result'}</span></div>
  </section>
}
