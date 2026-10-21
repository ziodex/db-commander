import { Fragment, useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'
import { X } from 'lucide-react'
import type { WorkspaceTab } from '../shared/contracts'
import { engineNames } from '../shared/database-engines'
import type { EditorSettings } from '../shared/editor-settings'
import type { EditorViews } from '../shared/editor-views'
import { emptyTabState, type QueryTabState } from './query-tabs'
import { SqlEditor } from './SqlEditor'

interface Props {
  tabs: WorkspaceTab[]; activeId: string; views?: EditorViews; states: Record<string, QueryTabState>; settings: EditorSettings
  theme: 'dark' | 'light'; ready: boolean; blocked: boolean; dirty(tab: WorkspaceTab): boolean; path(id: string): string | undefined
  onActivate(id: string): void; onSelect(owner: string, next: string): void; onHide(id: string): void
  onResize(index: number, weight: number): void; onRun(id: string, current: boolean): void
  onReady(id: string, editor: Monaco.editor.IStandaloneCodeEditor | null): void
  onError(id: string, message: string): void; onChange(id: string, sql: string): void
}

export function QueryEditorViews(props: Props) {
  const { views, activeId } = props, visible = views?.tabIds ?? [activeId]
  return <div className={`query-editor-views ${views?.orientation ?? 'vertical'}`}>
    {visible.map((id, index) => <Fragment key={id}>
      <EditorView {...props} tab={props.tabs.find(tab => tab.id === id)!} index={index} weight={views?.weights[index] ?? 100}/>
      {views && index < visible.length - 1 && <EditorViewSplitter orientation={views.orientation} index={index} count={visible.length}
        weight={views.weights[index]} total={views.weights[index] + views.weights[index + 1]} disabled={!props.ready || props.blocked}
        onChange={weight => props.onResize(index, weight)} controls={`query-view-${id} query-view-${visible[index + 1]}`}/>}
    </Fragment>)}
  </div>
}

function EditorView(props: Props & { tab: WorkspaceTab; index: number; weight: number }) {
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const { tab, states, activeId, views, index } = props, state = states[tab.id] ?? emptyTabState(), session = state.session
  const busy = state.running || state.connecting || state.closing || state.schemaLoading || state.backupBusy || state.transferBusy || state.gridBusy || state.switching || state.databasesLoading
  const transaction = session?.transaction === 'transaction' ? 'In transaction' : session?.transaction === 'failed' ? 'Transaction failed' : session?.transaction === 'unknown' ? 'State unknown' : session?.autocommit === false ? 'Manual commit mode' : ''
  return <section id={`query-view-${tab.id}`} className={`query-editor-view ${tab.id === activeId ? 'active' : ''}`} aria-label={`Query view ${index + 1}`} style={{ flex: `${props.weight} 1 0` }}>
    {views && <div className="query-view-heading">
      <label className="sr-only" htmlFor={`query-view-select-${tab.id}`}>Query in view {index + 1}</label>
      <select id={`query-view-select-${tab.id}`} value={tab.id} disabled={props.blocked} title={props.path(tab.id) ?? tab.title} onChange={event => props.onSelect(tab.id, event.target.value)}>
        {props.tabs.map(item => <option key={item.id} value={item.id}>{item.title}{props.dirty(item) ? ' •' : ''}</option>)}
      </select>
      <button type="button" disabled={props.blocked} className="query-view-focus" aria-pressed={tab.id === activeId} onClick={() => { props.onActivate(tab.id); editor.current?.focus() }} title="Focus this editor; toolbar and results follow this view">{tab.id === activeId ? 'Active' : 'Focus'}</button>
      <button type="button" aria-label={`Hide query view ${index + 1}`} title="Hide this view; keep the query tab and session open" disabled={props.blocked} onClick={() => props.onHide(tab.id)}><X size={12}/></button>
      <small title={`${session?.name ?? tab.profile.name} · ${session?.database || 'No database selected'}`}>
        {engineNames[session?.engine ?? tab.profile.engine]} · {session ? session.database || session.name : 'Disconnected'}{state.running ? ' · Running' : transaction ? ` · ${transaction}` : ''}{state.error ? ' · Error' : ''}
      </small>
    </div>}
    <div className="query-view-editor"><SqlEditor theme={props.theme} settings={props.settings} tabId={tab.id} tabIds={props.tabs.map(tab => tab.id)} value={tab.sql}
      engine={session?.engine ?? tab.profile.engine} schema={session ? state.schema : null} noBackslashEscapes={session?.mysqlSqlMode?.noBackslashEscapes}
      readOnly={!props.ready || props.blocked} canRun={props.ready && Boolean(session) && !busy && !props.blocked} editorRef={editor}
      onFocus={() => props.onActivate(tab.id)} onReady={editor => props.onReady(tab.id, editor)} onError={props.onError} onChange={props.onChange}
      onRun={() => props.onRun(tab.id, false)} onRunCurrent={() => props.onRun(tab.id, true)} ariaLabel={views ? `SQL editor: ${tab.title}` : 'SQL editor'}/></div>
  </section>
}

function EditorViewSplitter({ orientation, index, count, weight, total, disabled, controls, onChange }: {
  orientation: 'vertical' | 'horizontal'; index: number; count: number; weight: number; total: number; disabled: boolean; controls: string; onChange(value: number): void
}) {
  const element = useRef<HTMLDivElement>(null), drag = useRef<{ pointer: number; coordinate: number; weight: number; extent: number } | null>(null)
  const change = useRef(onChange); change.current = onChange
  function finish(cancel = false) {
    const previous = drag.current; if (!previous) return
    drag.current = null
    if (cancel) change.current(previous.weight)
    delete document.body.dataset.resizing
    if (element.current?.hasPointerCapture(previous.pointer)) element.current.releasePointerCapture(previous.pointer)
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true) } }
    const blur = () => finish(true)
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', blur); if (drag.current) delete document.body.dataset.resizing }
  }, [])
  return <div ref={element} className={`panel-splitter ${orientation}`} role="separator" aria-label={`Resize query views ${index + 1} and ${index + 2}`}
    aria-orientation={orientation} aria-controls={controls} aria-valuemin={10} aria-valuemax={total - 10} aria-valuenow={weight} aria-valuetext={`${weight} percent`}
    aria-disabled={disabled} tabIndex={disabled ? -1 : 0} title="Drag or use arrow keys to resize. Escape cancels a drag. Enter or double-click gives both views equal space."
    onKeyDown={event => {
      if (disabled || event.altKey || event.ctrlKey || event.metaKey) return
      const lower = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp', higher = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
      if (![lower, higher, 'Home', 'End', 'Enter'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      onChange(event.key === 'Home' ? 10 : event.key === 'End' ? total - 10 : event.key === 'Enter' ? Math.round(total / 2) : weight + (event.key === lower ? -1 : 1) * (event.shiftKey ? 10 : 2))
    }} onDoubleClick={() => { if (!disabled) onChange(Math.round(total / 2)) }}
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
      drag.current = { pointer: event.pointerId, coordinate: orientation === 'vertical' ? event.clientX : event.clientY, weight, extent: Math.max(1, (orientation === 'vertical' ? bounds.width : bounds.height) - 6 * (count - 1)) }
      document.body.dataset.resizing = orientation
    }} onPointerMove={event => {
      const start = drag.current
      if (!start || start.pointer !== event.pointerId) return
      onChange(start.weight + 100 * ((orientation === 'vertical' ? event.clientX : event.clientY) - start.coordinate) / start.extent)
    }} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}/>
}
