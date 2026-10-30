import { useRef, useState, type ReactNode } from 'react'
import type { ResultSet } from '../shared/contracts'
import type { ColumnLayout } from '../shared/column-layout'
import { emptyExploration, type ResultExploration } from './result-exploration'
import { pinResultSnapshot, type ResultSnapshot } from './result-snapshots'
import { ResultPane } from './ResultPane'
import { ModalDialog } from './ModalDialog'

interface PaneView { exploration: ResultExploration; columns?: ColumnLayout }
const EMPTY = emptyExploration()
export function ResultWorkspace({ hidden, result, results, sourceKey, sourceLabel, partial, view, onView, empty, editSource }: {
  hidden: boolean; result?: ResultSet; results: ResultSet[]; sourceKey: string; sourceLabel: string; partial: boolean
  view?: ColumnLayout; onView(view: ColumnLayout): void; empty: ReactNode; editSource?: { disabled: boolean; label: string; open(): void }
}) {
  const root = useRef<HTMLDivElement>(null), ordinal = useRef(0)
  const [snapshots, setSnapshots] = useState<ResultSnapshot[]>([]), [comparison, setComparison] = useState<string | null>(null)
  const [views, setViews] = useState<Record<string, PaneView>>({}), [error, setError] = useState('')
  const [editRequest, setEditRequest] = useState<{ sourceKey: string; resultIndex: number; label: string }>()
  const primaryKey = `main:${sourceKey}:${result?.index}`, secondaryKey = `comparison:${sourceKey}:${comparison}`
  const primary = views[primaryKey]?.exploration ?? EMPTY
  const snapshot = comparison?.startsWith('snapshot:') ? snapshots.find(item => item.id === comparison.slice(9)) : undefined
  const compared = comparison?.startsWith('result:') ? results.find(item => item?.index === Number(comparison.slice(7))) : undefined
  function saveView(key: string, change: Partial<PaneView>) {
    setViews(previous => {
      const entries = Object.entries(previous).filter(([id]) => id !== key).slice(-63)
      return Object.fromEntries([...entries, [key, { ...(previous[key] ?? { exploration: EMPTY }), ...change }]])
    })
  }
  function pin(capture: ResultSet, exploration: ResultExploration, columns?: ColumnLayout) {
    try {
      const next = pinResultSnapshot(snapshots, { id: crypto.randomUUID(), name: `Snapshot ${ordinal.current + 1}`, capturedAt: new Date().toISOString(), source: `${sourceLabel} · Result ${capture.index + 1}`, partial, result: capture, columns, exploration })
      ordinal.current++; setSnapshots(next); setComparison(`snapshot:${next.at(-1)!.id}`); setError('')
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  function split() {
    const other = results.find(item => item?.columns.length && item.index !== result?.index) ?? result
    setComparison(snapshots.length ? `snapshot:${snapshots.at(-1)!.id}` : other ? `result:${other.index}` : null)
  }
  function remove(id: string) {
    setSnapshots(previous => previous.filter(item => item.id !== id))
    if (comparison === `snapshot:${id}`) setComparison(null)
    setError(''); requestAnimationFrame(() => root.current?.focus())
  }
  function updateSnapshot(change: Partial<Pick<ResultSnapshot, 'name' | 'columns' | 'exploration'>>) {
    if (snapshot) setSnapshots(previous => previous.map(item => item.id === snapshot.id ? { ...item, ...change } : item))
  }
  const choices = <select aria-label="Comparison result" value={comparison ?? ''} onChange={event => setComparison(event.target.value)}>
    {results.filter(item => item?.columns.length).map(item => <option key={`result:${item.index}`} value={`result:${item.index}`}>Live · Result {item.index + 1} · {item.rows.length.toLocaleString()} rows</option>)}
    {snapshots.map(item => <option key={item.id} value={`snapshot:${item.id}`}>Pinned · {item.name || 'Unnamed snapshot'}</option>)}
    {!snapshot && !compared && comparison && <option value={comparison}>Waiting for this result</option>}
  </select>
  const closeComparison = <button aria-label="Close comparison pane" onClick={() => { setComparison(null); requestAnimationFrame(() => root.current?.focus()) }}>Close pane</button>
  return <div ref={root} hidden={hidden} className="result-workspace" tabIndex={-1} aria-label="Result exploration workspace">
    {error && <div className="result-snapshot-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {snapshots.length > 0 && <div className="result-snapshots" role="group" aria-label="Pinned results">
      <span title="Captures are held in this window’s memory only. Restarting or reloading discards them; pinning never runs SQL or saves result data into the workspace.">Pinned · window only</span>
      {snapshots.map((item, index) => <div className="result-snapshot-chip" key={item.id}>
        <button aria-pressed={comparison === `snapshot:${item.id}`} title={`${item.source} · ${new Date(item.capturedAt).toLocaleString()}${item.partial ? ' · Partial execution capture' : ''}`} onClick={() => setComparison(`snapshot:${item.id}`)}>{item.name || 'Unnamed snapshot'}</button>
        <button aria-label={`Remove pinned result ${index + 1}`} title="Remove this snapshot" onClick={() => remove(item.id)}>×</button>
      </div>)}
    </div>}
    <div className={`result-panes${comparison ? ' split' : ''}`}>
      {result ? <ResultPane key={primaryKey} result={result} label="Query results" caption="Live result" source={`Result ${result.index + 1} · ${sourceLabel}`} value={primary} onChange={exploration => saveView(primaryKey, { exploration })} view={view} onView={onView} partial={partial} showHeading={Boolean(comparison)}
        toolbar={<>{editSource && <button disabled={editSource.disabled} title="Open a fresh editable page from the source table. The query is not replayed; rows may have changed." onClick={() => setEditRequest({ sourceKey, resultIndex: result.index, label: editSource.label })}>Edit source table</button>}<button aria-label="Pin result snapshot" title="Capture these loaded rows and this view without running SQL; kept in this window only" onClick={() => pin(result, primary, view)}>Pin snapshot</button><button disabled={Boolean(comparison)} onClick={split}>Split results</button></>}/> : <div className="result-pane result-pane-empty">{empty}{snapshots.length > 0 && !comparison && <button onClick={split}>Open pinned result pane</button>}</div>}
      {comparison && (snapshot ? <ResultPane key={snapshot.id} result={snapshot.result} label="Snapshot results" caption="Pinned result" source={`${snapshot.source} · ${new Date(snapshot.capturedAt).toLocaleString()}`} snapshot partial={snapshot.partial} value={snapshot.exploration} onChange={exploration => updateSnapshot({ exploration })} view={snapshot.columns} onView={columns => updateSnapshot({ columns })} showHeading
        heading={<>{choices}<input aria-label="Snapshot name" maxLength={80} value={snapshot.name} onChange={event => updateSnapshot({ name: event.target.value })} onBlur={() => { if (!snapshot.name.trim()) updateSnapshot({ name: 'Snapshot' }) }}/>{closeComparison}</>}/>
        : compared ? <ResultPane key={secondaryKey} result={compared} label="Comparison results" caption="Comparison result" source={`Live · Result ${compared.index + 1} · ${sourceLabel}`} partial={partial} value={views[secondaryKey]?.exploration ?? EMPTY} onChange={exploration => saveView(secondaryKey, { exploration })} view={views[secondaryKey]?.columns} onView={columns => saveView(secondaryKey, { columns })} showHeading
          heading={<>{choices}{closeComparison}</>} toolbar={<button aria-label="Pin comparison snapshot" onClick={() => pin(compared, views[secondaryKey]?.exploration ?? EMPTY, views[secondaryKey]?.columns)}>Pin snapshot</button>}/>
          : <section className="result-pane result-pane-empty" aria-label="Comparison result"><div className="result-pane-heading">{choices}{closeComparison}</div><p>Choose a live result or a pinned snapshot. This pane does not run SQL.</p></section>)}
    </div>
    {editRequest && !hidden && editSource && editRequest.sourceKey === sourceKey && editRequest.resultIndex === result?.index && editRequest.label === editSource.label && <ModalDialog className="connection-dialog" aria-label="Open source table for editing" onDismiss={() => setEditRequest(undefined)}>
      <div className="dialog-heading"><h2>Open source table for editing</h2><button aria-label="Close source table review" onClick={() => setEditRequest(undefined)}>×</button></div>
      <p>Open a fresh page from {editRequest.label}. The rows can differ from this captured result. The original query will not run again. Your result stays available until another query runs.</p>
      <div className="dialog-actions"><button onClick={() => setEditRequest(undefined)}>Cancel</button><button className="primary-button" disabled={editSource.disabled} onClick={() => { setEditRequest(undefined); editSource.open() }}>Open table</button></div>
    </ModalDialog>}
  </div>
}
