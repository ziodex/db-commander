import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResultSet } from '../shared/contracts'
import type { CellMark } from '../shared/inspection'
import { ColumnControls, useColumns, type ColumnLayout, type SavedColumnControls } from './ColumnControls'
import { ColumnResizer } from './ColumnResizer'
import { columnMeasurer, fittedColumnWidth, DEFAULT_COLUMN_WIDTH } from './column-sizing'
import { ValueInspector, type InspectCell, type InspectionActions } from './ValueInspector'
import { ActionMenu } from './ActionMenu'
import { ContextMenu, type MenuAnchor } from './ContextMenu'
import { ChevronDown, Search } from './WorkbenchIcons'
import { copyGridSelection, selectionBounds, type GridCopyFormat } from './grid-selection'
import { useGridSelection } from './use-grid-selection'
import type { ResultMatch } from './result-exploration'

export interface ResultGridSearch { text: string; matchCase: boolean; focus?: ResultMatch & { request: number } }
export function ResultGrid({ result, label = 'Query results', rowOffset = 0, rowOrder, selectionKey, search, onFind, scope, emptyMessage, marks, actions, view, onView, savedColumns, toolbarStart, toolbarEnd }: { result: ResultSet; label?: string; rowOffset?: number; rowOrder?:number[]; selectionKey?:string; search?:ResultGridSearch; onFind?():void; scope?:string; emptyMessage?:string; marks?:CellMark[]; actions?:InspectionActions; view?:ColumnLayout; onView?(view:ColumnLayout):void; savedColumns?:SavedColumnControls; toolbarStart?:ReactNode; toolbarEnd?:ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null), [inspecting,setInspecting] = useState<InspectCell>()
  const [copyStatus, setCopyStatus] = useState(''), [copyError, setCopyError] = useState(''), copying = useRef(false)
  const [menu, setMenu] = useState<Omit<MenuAnchor, 'items'> | null>(null)
  const header = useRef<HTMLDivElement>(null), headerHeight = header.current?.offsetHeight ?? 46
  const [cursor, setCursor] = useState({ row: 0, column: 0 }), pendingFocus = useRef<typeof cursor | null>(null)
  const revealedSearch = useRef<number | undefined>(undefined)
  const virtual = useVirtualizer({ count: result.rows.length, getScrollElement: () => scroll.current, estimateSize: () => 33, overscan: 8, scrollMargin: headerHeight, scrollPaddingStart: headerHeight })
  // Include both cell padding and the widest supported 12px monospace digits.
  const sourceRow = (row: number) => rowOrder?.[row] ?? row
  const rowNumberWidth = Math.max(48, 26 + String(rowOffset + (rowOrder ? Math.max(0, ...rowOrder) + 1 : result.rows.length)).length * 8)
  const columns = result.columns.slice(0, 100), controls = useColumns(columns,DEFAULT_COLUMN_WIDTH,rowNumberWidth,view,onView), {style} = controls
  const active = { row: Math.max(0, Math.min(cursor.row, result.rows.length - 1)), column: controls.visible.includes(cursor.column) ? cursor.column : controls.visible[0] }
  const rows = virtual.getVirtualItems(), activeMounted = rows.some(row => row.index === active.row)
  function move(row: number, column: number, page = false) {
    if (!result.rows.length || column === undefined) return
    const next = { row: Math.max(0, Math.min(row, result.rows.length - 1)), column }
    pendingFocus.current = next; setCursor(next)
    virtual.scrollToIndex(next.row, { align: page ? 'start' : 'auto' })
  }
  const range = useGridSelection(scroll, controls.visible, result.rows.length, point => move(point.row, point.column), selectionKey)
  const cellMarks=useMemo(()=>new Map(marks?.map(mark=>[`${mark.row}:${mark.column}`,mark])),[marks])
  function inspectCell(row: number, column: number): InspectCell {
    return { value: result.rows[row][column], column: columns[column], row: sourceRow(row), columnIndex: column, mark: cellMarks.get(`${sourceRow(row)}:${column}`) }
  }
  const selected = range.bounds ? inspectCell(active.row, active.column) : undefined
  const count = range.bounds ? (range.bounds.lastRow - range.bounds.firstRow + 1) * (range.bounds.lastColumn - range.bounds.firstColumn + 1) : 0
  async function copy(headers = false, format: GridCopyFormat = 'tsv') {
    if (!range.current.current || copying.current) return
    copying.current = true; setCopyStatus(''); setCopyError('')
    try {
      const text = copyGridSelection(result, controls.visible, range.current.current, headers, format)
      await window.dbCommander.copyDefinition(text)
      setCopyStatus(`${count.toLocaleString()} ${count === 1 ? 'cell' : 'cells'} copied${format !== 'tsv' ? ` as ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}` : headers ? ' with headers' : ''}.`)
    } catch (error) { setCopyError(error instanceof Error ? error.message : 'Could not copy. Try again.') }
    finally { copying.current = false }
  }
  const copyItems = [
    { label: 'Copy', title: 'Ctrl+C · Tab-separated values from the loaded rows', disabled: !count, action: () => void copy() },
    { label: 'Copy with headers', title: 'Ctrl+Shift+C · Includes the selected column names', disabled: !count, action: () => void copy(true) },
    { label: 'Copy as CSV', title: 'Selected shown cells and headers; NULL is unquoted NULL, text is quoted', disabled: !count, action: () => void copy(true, 'csv') },
    { label: 'Copy as JSON', title: 'Column names and row arrays preserve duplicate names, strings and SQL NULL', disabled: !count, action: () => void copy(true, 'json') },
    { label: 'Copy as Markdown table', title: 'Selected shown cells with headers and escaped table content', disabled: !count, action: () => void copy(true, 'markdown') },
    { label: rowOrder ? 'Select all shown cells' : 'Select all loaded cells', title: 'Ctrl+A · Visible columns only', disabled: !result.rows.length, action: selectAll }
  ]
  function selectAll() {
    if (!result.rows.length || !controls.visible.length) return
    range.select({ row: 0, column: controls.visible[0] })
    range.select({ row: result.rows.length - 1, column: controls.visible.at(-1)! }, true)
  }
  function selectionKeys(event: KeyboardEvent) {
    if (onFind && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); onFind(); return true
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['c', 'a'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation()
      if (event.key.toLowerCase() === 'c') void copy(event.shiftKey)
      else selectAll()
      return true
    }
    return false
  }
  useLayoutEffect(() => {
    const target = search?.focus
    if (!target || target.request === revealedSearch.current || !result.rows[target.row] || !controls.visible.includes(target.column)) return
    revealedSearch.current = target.request
    range.select(target); move(target.row, target.column)
  })
  useLayoutEffect(() => {
    const next = pendingFocus.current, viewport = scroll.current
    if (!next || !viewport) return
    const cell = viewport.querySelector<HTMLElement>(`[data-result-row="${next.row}"][data-result-column="${next.column}"]`)
    if (!cell) return // The virtual row will mount on the next range update.
    pendingFocus.current = null; cell.focus({ preventScroll: true })
    if (!controls.layout.pinned.includes(next.column)) {
      const bounds = cell.getBoundingClientRect(), frame = viewport.getBoundingClientRect()
      const left = frame.left + rowNumberWidth + controls.visible.filter(index => controls.layout.pinned.includes(index)).reduce((width, index) => width + controls.size(index), 0)
      const right = frame.left + viewport.clientWidth
      viewport.scrollLeft += bounds.left < left ? bounds.left - left : bounds.right > right ? Math.max(0, Math.min(bounds.right - right, bounds.left - left)) : 0
    }
    for (const container of [viewport.closest<HTMLElement>('.result-workspace'), viewport.closest<HTMLElement>('.main-workspace')]) {
      if (!container) continue
      const bounds = cell.getBoundingClientRect(), frame = container.getBoundingClientRect()
      container.scrollTop += bounds.top < frame.top ? bounds.top - frame.top : Math.max(0, bounds.bottom - frame.top - container.clientHeight)
    }
  })
  function navigate(event: KeyboardEvent, row: number, column: number) {
    if (selectionKeys(event) || event.altKey || !result.rows.length || !controls.visible.length) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); range.select({ row, column }); return }
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); event.stopPropagation()
      const owner = event.currentTarget as HTMLElement, bounds = owner.getBoundingClientRect()
      setMenu({ owner, x: bounds.left, y: bounds.bottom }); return
    }
    const position = controls.visible.indexOf(column), last = controls.visible.length - 1
    const page = Math.max(1, Math.floor(((scroll.current?.clientHeight ?? 200) - headerHeight) / 33))
    let nextRow = row, nextPosition = position
    switch (event.key) {
      case 'ArrowLeft': nextPosition--; break
      case 'ArrowRight': nextPosition++; break
      case 'ArrowUp': nextRow--; break
      case 'ArrowDown': nextRow++; break
      case 'Home': nextPosition = 0; if (event.ctrlKey || event.metaKey) nextRow = 0; break
      case 'End': nextPosition = last; if (event.ctrlKey || event.metaKey) nextRow = result.rows.length - 1; break
      case 'PageUp': nextRow -= page; break
      case 'PageDown': nextRow += page; break
      default: return
    }
    event.preventDefault(); event.stopPropagation()
    const next = { row: Math.max(0, Math.min(nextRow, result.rows.length - 1)), column: controls.visible[Math.max(0, Math.min(nextPosition, last))] }
    range.select(next, event.shiftKey)
    move(next.row, next.column, event.key === 'PageUp' || event.key === 'PageDown')
  }
  function fit(indices: number[]) {
    const measure = columnMeasurer(scroll.current)
    controls.setWidths(Object.fromEntries(indices.map(index => [index, fittedColumnWidth({ name: columns[index].name, type: columns[index].typeName ?? `Type ${columns[index].typeId}` }, result.rows.length, row => result.rows[row][index], measure)])))
  }
  function focusCell(row: number, column: number) {
    setCursor({ row, column })
    const bounds = selectionBounds(range.current.current, controls.visible, result.rows.length), position = controls.visible.indexOf(column)
    // Menus and the inspector restore focus without collapsing an existing range.
    if (!bounds || row < bounds.firstRow || row > bounds.lastRow || position < bounds.firstColumn || position > bounds.lastColumn) range.select({ row, column })
  }
  if (!result.columns.length) return <div className="empty-result"><strong>{result.command || 'Statement completed'}</strong><span>{result.rowCount === null ? 'No result rows.' : `${result.rowCount} rows affected.`}</span></div>
  return <div className="result-grid-container"><div className="data-toolbar" role="group" aria-label="Result controls">
    {toolbarStart}
    <div className="data-toolbar-group"><ColumnControls columns={columns} layout={controls.layout} onChange={controls.set} onFit={fit} saved={savedColumns}/>
      <div className="grid-copy-actions"><button disabled={!count} title="Copy selected cells (Ctrl+C)" onClick={() => void copy()}>Copy</button><ActionMenu label="Copy options" items={copyItems}><ChevronDown size={12}/></ActionMenu></div>
      <button aria-label="Inspect selected value" title="Inspect selected value (Enter or double-click)" disabled={!selected} onClick={()=>setInspecting(selected)}><Search size={14}/></button>
    </div><div className="tabs-spacer"/>
    <span className="grid-selection-count" aria-live="polite">{count ? `${count.toLocaleString()} selected` : ''}</span>
    {toolbarEnd}
  </div>
    <span className="sr-only" role="status">{copyStatus}</span>
    {copyError && <div className="grid-copy-error" role="alert">{copyError}<button aria-label="Dismiss copy error" onClick={() => setCopyError('')}>×</button></div>}
    <div ref={scroll} className="grid-scroll" role="table" tabIndex={!result.rows.length || !activeMounted ? 0 : -1} aria-label={label} aria-description={`${scope ? `${scope} ` : ''}${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'} loaded${rowOffset && result.rows.length ? `, rows ${rowOffset + 1} to ${rowOffset + result.rows.length}` : ''}. ${result.truncated ? 'Limited preview; more rows are available. ' : ''}Row numbers identify source rows within this loaded preview. Columns follow the displayed order. Use arrow keys to move between cells, Home and End within a row, and Page Up and Page Down between rows. Control or Command with Home or End moves to the first or last cell. Drag or Shift-click to select a range; Shift with navigation keys extends it. Control or Command+C copies selected cells; add Shift to include headers. Control or Command+A selects all shown cells in visible columns. NULL copies as NULL; empty text stays empty. Tab leaves the cells; Enter inspects the value.`} aria-rowcount={result.rows.length + 1} aria-colcount={controls.visible.length + 1}
      {...range.pointerEvents}
      aria-keyshortcuts={`Control+C Meta+C Control+Shift+C Meta+Shift+C Control+A Meta+A${onFind ? ' Control+F Meta+F' : ''}`}
      onDoubleClick={event => {
        // Pointer capture retargets clicks to the viewport while a range is dragged.
        const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-result-row][data-result-column]')
        if (cell && event.currentTarget.contains(cell)) setInspecting(inspectCell(Number(cell.dataset.resultRow), Number(cell.dataset.resultColumn)))
      }}
      onCopy={event => { event.preventDefault(); event.stopPropagation(); void copy() }}
      onContextMenu={event => {
        const owner = (event.target as Element).closest<HTMLElement>('[data-result-row][data-result-column]')
        if (!owner) return
        event.preventDefault(); event.stopPropagation()
        const row = Number(owner.dataset.resultRow), column = Number(owner.dataset.resultColumn), position = controls.visible.indexOf(column)
        if (!range.bounds || row < range.bounds.firstRow || row > range.bounds.lastRow || position < range.bounds.firstColumn || position > range.bounds.lastColumn) { range.select({ row, column }); move(row, column) }
        setMenu({ owner, x: event.clientX, y: event.clientY })
      }}
      onFocus={event => { if (event.target === event.currentTarget && result.rows.length) move(activeMounted ? active.row : rows.find(row => row.end > event.currentTarget.scrollTop + headerHeight)?.index ?? 0, active.column) }}
      onKeyDown={event => { if (event.target === event.currentTarget) navigate(event, active.row, active.column) }}>
      <div ref={header} className="grid-header" role="row" aria-rowindex={1} style={style}><span role="columnheader" aria-label="Row" aria-colindex={1} className="row-number">#</span>{controls.visible.map((index, position) => <span role="columnheader" aria-colindex={position + 2} aria-label={columns[index].name} aria-description={`Source column ${index + 1}. ${columns[index].typeName ?? `Type ${columns[index].typeId}`}.`} key={index} style={controls.cellStyle(index)}><b>{columns[index].name}</b><small>{columns[index].typeName ?? `Type ${columns[index].typeId}`}</small><ColumnResizer label={`Resize column ${index+1} ${columns[index].name}`} width={controls.size(index)} onResize={width=>controls.setWidths({[index]:width})} onFit={()=>fit([index])} onReset={()=>controls.resetWidth(index)}/></span>)}</div>
      <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: style.minWidth }}>
        {rows.map(row => <div className="grid-row" role="row" aria-rowindex={row.index + 2} key={row.key} style={{ ...style, position: 'absolute', top: row.start - headerHeight, height: row.size }}>
          <span role="cell" aria-colindex={1} className="row-number">{rowOffset + sourceRow(row.index) + 1}</span>
          {controls.visible.map((index, position) => {
            const cell = result.rows[row.index][index], target = inspectCell(row.index, index)
            const match = Boolean(search?.text && cell !== null && (search.matchCase ? cell : cell.toLowerCase()).includes(search.matchCase ? search.text : search.text.toLowerCase()))
            const inRange = Boolean(range.bounds && row.index >= range.bounds.firstRow && row.index <= range.bounds.lastRow && position >= range.bounds.firstColumn && position <= range.bounds.lastColumn)
            return <span role="cell" aria-colindex={position + 2} aria-label={cell === null ? 'SQL NULL' : cell === '' ? 'Empty text' : undefined} aria-description={`${inRange ? 'Selected. ' : ''}${match ? 'Find match. ' : ''}Row ${rowOffset + sourceRow(row.index) + 1}, ${columns[index].name}, source column ${index + 1}.${cell !== null && cell.length > 500 ? ' Display truncated; press Enter to inspect the loaded value.' : ''}`} data-result-row={row.index} data-source-row={sourceRow(row.index)} data-result-column={index} data-find-match={match || undefined} data-selected={inRange || undefined} tabIndex={row.index === active.row && index === active.column ? 0 : -1} key={index} style={controls.cellStyle(index)} title={cell?.slice(0,4096)} className={cell===null?'null-cell':''} onFocus={()=>focusCell(row.index,index)} onDoubleClick={()=>setInspecting(target)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();setInspecting(target)}else navigate(e,row.index,index)}}>{cell===null?'NULL':cell.length>500?cell.slice(0,500)+'…':cell}</span>
          })}
        </div>)}
      </div>
      {!result.rows.length&&<div className="zero-rows">{emptyMessage ?? 'Query returned no rows.'}</div>}
      {result.columns.length>100&&<p className="grid-note">Showing the first 100 columns. CSV includes all fetched columns.</p>}
    </div>
    {inspecting&&<ValueInspector cell={inspecting} actions={actions} onClose={()=>setInspecting(undefined)}/>}
    {menu && <ContextMenu label="Selected cells" anchor={{ ...menu, items: copyItems }} onClose={() => setMenu(null)}/>}
  </div>
}
