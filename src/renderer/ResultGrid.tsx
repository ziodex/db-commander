import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResultSet } from '../shared/contracts'
import type { CellMark } from '../shared/inspection'
import { ColumnControls, useColumns, type ColumnLayout, type SavedColumnControls } from './ColumnControls'
import { ColumnResizer } from './ColumnResizer'
import { columnMeasurer, fittedColumnWidth, DEFAULT_COLUMN_WIDTH } from './column-sizing'
import { ValueInspector, type InspectCell, type InspectionActions } from './ValueInspector'

export function ResultGrid({ result, label = 'Query results', rowOffset = 0, marks, actions, view, onView, savedColumns }: { result: ResultSet; label?: string; rowOffset?: number; marks?:CellMark[]; actions?:InspectionActions; view?:ColumnLayout; onView?(view:ColumnLayout):void; savedColumns?:SavedColumnControls }) {
  const scroll = useRef<HTMLDivElement>(null), [selected,setSelected] = useState<InspectCell>(), [inspecting,setInspecting] = useState<InspectCell>()
  const header = useRef<HTMLDivElement>(null), headerHeight = header.current?.offsetHeight ?? 46
  const [cursor, setCursor] = useState({ row: 0, column: 0 }), pendingFocus = useRef<typeof cursor | null>(null)
  const virtual = useVirtualizer({ count: result.rows.length, getScrollElement: () => scroll.current, estimateSize: () => 33, overscan: 8, scrollMargin: headerHeight, scrollPaddingStart: headerHeight })
  const rowNumberWidth = Math.max(48, 25 + String(rowOffset + result.rows.length).length * 7)
  const columns = result.columns.slice(0, 100), controls = useColumns(columns,DEFAULT_COLUMN_WIDTH,rowNumberWidth,view,onView), {style} = controls
  const active = { row: Math.max(0, Math.min(cursor.row, result.rows.length - 1)), column: controls.visible.includes(cursor.column) ? cursor.column : controls.visible[0] }
  const rows = virtual.getVirtualItems(), activeMounted = rows.some(row => row.index === active.row)
  function move(row: number, column: number, page = false) {
    if (!result.rows.length || column === undefined) return
    const next = { row: Math.max(0, Math.min(row, result.rows.length - 1)), column }
    pendingFocus.current = next; setCursor(next)
    virtual.scrollToIndex(next.row, { align: page ? 'start' : 'auto' })
  }
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
  })
  function navigate(event: KeyboardEvent, row: number, column: number) {
    if (event.altKey || event.shiftKey) return
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
    move(nextRow, controls.visible[Math.max(0, Math.min(nextPosition, last))], event.key === 'PageUp' || event.key === 'PageDown')
  }
  function fit(indices: number[]) {
    const measure = columnMeasurer(scroll.current)
    controls.setWidths(Object.fromEntries(indices.map(index => [index, fittedColumnWidth({ name: columns[index].name, type: columns[index].typeName ?? `Type ${columns[index].typeId}` }, result.rows.length, row => result.rows[row][index], measure)])))
  }
  const cellMarks=useMemo(()=>new Map(marks?.map(mark=>[`${mark.row}:${mark.column}`,mark])),[marks])
  if (!result.columns.length) return <div className="empty-result"><strong>{result.command || 'Statement completed'}</strong><span>{result.rowCount === null ? 'No result rows.' : `${result.rowCount} rows affected.`}</span></div>
  return <div className="result-grid-container"><div className="column-toolbar"><ColumnControls columns={columns} layout={controls.layout} onChange={controls.set} onFit={fit} saved={savedColumns}/><button disabled={!selected} onClick={()=>setInspecting(selected)}>Inspect selected value</button><span>Arrow keys move between cells. Enter or double-click inspects a value.</span></div>
    <div ref={scroll} className="grid-scroll" role="table" tabIndex={!result.rows.length || !activeMounted ? 0 : -1} aria-label={label} aria-description={`${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'} loaded${rowOffset && result.rows.length ? `, rows ${rowOffset + 1} to ${rowOffset + result.rows.length}` : ''}. ${result.truncated ? 'Limited preview; more rows are available. ' : ''}Row positions are within this loaded preview. Columns follow the displayed order. Use arrow keys to move between cells, Home and End within a row, and Page Up and Page Down between rows. Control or Command with Home or End moves to the first or last cell. Tab leaves the cells; Enter inspects the value.`} aria-rowcount={result.rows.length + 1} aria-colcount={controls.visible.length + 1}
      onFocus={event => { if (event.target === event.currentTarget && result.rows.length) move(activeMounted ? active.row : rows.find(row => row.end > event.currentTarget.scrollTop + headerHeight)?.index ?? 0, active.column) }}
      onKeyDown={event => { if (event.target === event.currentTarget) navigate(event, active.row, active.column) }}>
      <div ref={header} className="grid-header" role="row" aria-rowindex={1} style={style}><span role="columnheader" aria-label="Row" aria-colindex={1} className="row-number">#</span>{controls.visible.map((index, position) => <span role="columnheader" aria-colindex={position + 2} aria-label={columns[index].name} aria-description={`Source column ${index + 1}. ${columns[index].typeName ?? `Type ${columns[index].typeId}`}.`} key={index} style={controls.cellStyle(index)}><b>{columns[index].name}</b><small>{columns[index].typeName ?? `Type ${columns[index].typeId}`}</small><ColumnResizer label={`Resize column ${index+1} ${columns[index].name}`} width={controls.size(index)} onResize={width=>controls.setWidths({[index]:width})} onFit={()=>fit([index])} onReset={()=>controls.resetWidth(index)}/></span>)}</div>
      <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: style.minWidth }}>
        {rows.map(row => <div className="grid-row" role="row" aria-rowindex={row.index + 2} key={row.key} style={{ ...style, position: 'absolute', top: row.start - headerHeight, height: row.size }}>
          <span role="cell" aria-colindex={1} className="row-number">{rowOffset + row.index + 1}</span>
          {controls.visible.map((index, position) => {
            const cell = result.rows[row.index][index], target:InspectCell={value:cell,column:columns[index],row:row.index,columnIndex:index,mark:cellMarks.get(`${row.index}:${index}`)}
            return <span role="cell" aria-colindex={position + 2} aria-label={cell === null ? 'SQL NULL' : cell === '' ? 'Empty text' : undefined} aria-description={`Row ${rowOffset + row.index + 1}, ${columns[index].name}, source column ${index + 1}.${cell !== null && cell.length > 500 ? ' Display truncated; press Enter to inspect the loaded value.' : ''}`} data-result-row={row.index} data-result-column={index} tabIndex={row.index === active.row && index === active.column ? 0 : -1} key={index} style={controls.cellStyle(index)} title={cell?.slice(0,4096)} className={cell===null?'null-cell':''} onFocus={()=>{setSelected(target);setCursor({ row: row.index, column: index })}} onDoubleClick={()=>setInspecting(target)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();setInspecting(target)}else navigate(e,row.index,index)}}>{cell===null?'NULL':cell.length>500?cell.slice(0,500)+'…':cell}</span>
          })}
        </div>)}
      </div>
      {!result.rows.length&&<div className="zero-rows">Query returned no rows.</div>}
      {result.columns.length>100&&<p className="grid-note">Showing the first 100 columns. CSV includes all fetched columns.</p>}
    </div>
    {inspecting&&<ValueInspector cell={inspecting} actions={actions} onClose={()=>setInspecting(undefined)}/>}
  </div>
}
