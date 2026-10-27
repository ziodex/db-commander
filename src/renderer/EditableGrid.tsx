import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Cell, GridChange, GridSnapshot } from '../shared/contracts'
import { ColumnControls, useColumns, type ColumnLayout, type SavedColumnControls } from './ColumnControls'
import { ColumnResizer } from './ColumnResizer'
import { columnMeasurer, fittedColumnWidth, DEFAULT_COLUMN_WIDTH } from './column-sizing'
import { ValueInspector, type InspectCell, type InspectionActions } from './ValueInspector'

export function EditableGrid({ grid, changes, busy, disconnected, expired, transaction, onChange, onApply, onReload, onClose, actions, view, onView, savedColumns }: {
  grid: GridSnapshot; changes: GridChange[]; busy: boolean; disconnected: boolean; expired: boolean; transaction: boolean
  onChange(changes: GridChange[]): void; onApply(): void; onReload(): void; onClose(): void
  actions?:InspectionActions; view?:ColumnLayout; onView?(view:ColumnLayout):void; savedColumns?:SavedColumnControls
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const inserted = changes.flatMap((change, index) => change.kind === 'insert' ? [{ change, index }] : [])
  const virtual = useVirtualizer({ count: grid.rows.length + inserted.length, getScrollElement: () => scroll.current, estimateSize: () => 56, overscan: 5 })
  const controls=useColumns(grid.columns,DEFAULT_COLUMN_WIDTH,90,view,onView), {style}=controls, [inspecting,setInspecting]=useState<InspectCell>()
  function fit(indices: number[]) {
    const measure = columnMeasurer(scroll.current)
    controls.setWidths(Object.fromEntries(indices.map(index => {
      const column = grid.columns[index]
      const value = (row: number) => {
        const change = row >= grid.rows.length ? inserted[row-grid.rows.length].change : changes.find(change=>change.kind!=='insert'&&change.row===row)
        const staged = change && change.kind!=='delete' ? change.values.find(cell=>cell.column===index) : undefined
        return staged ? staged.value : grid.rows[row]?.[index]
      }
      return [index, fittedColumnWidth({ name: column.name + (column.primaryKey ? ' · key' : ''), type: column.type + (column.generated ? ' · generated' : '') }, grid.rows.length + inserted.length, value, measure)]
    })))
  }
  const disabled = busy || disconnected || expired || transaction
  function edit(row: number, column: number, value: Cell | undefined) {
    const isNew = row >= grid.rows.length, insert = inserted[row - grid.rows.length]
    const index = isNew ? insert.index : changes.findIndex(change => change.kind !== 'insert' && change.row === row)
    const current = changes[index], values = current && current.kind !== 'delete' ? current.values.filter(cell => cell.column !== column) : []
    if (value !== undefined && (isNew || value !== grid.rows[row][column])) values.push({ column, value })
    const next = [...changes], change: GridChange = isNew ? { kind: 'insert', values } : { kind: 'update', row, values }
    if (index < 0) { if (values.length) next.push(change) }
    else if (!isNew && !values.length) next.splice(index, 1)
    else next[index] = change
    onChange(next)
  }
  function remove(row: number) {
    if (row >= grid.rows.length) { onChange(changes.filter((_, index) => index !== inserted[row - grid.rows.length].index)); return }
    const existing = changes.find(change => change.kind !== 'insert' && change.row === row)
    const next = changes.filter(change => change.kind === 'insert' || change.row !== row)
    if (existing?.kind !== 'delete') next.push({ kind: 'delete', row })
    onChange(next)
  }
  return <div className="editable-result">
    <div className="grid-edit-toolbar"><strong>{grid.table.schema}.{grid.table.name}</strong><span>{changes.length} staged {changes.length === 1 ? 'row' : 'rows'}</span><div className="tabs-spacer" />
      <ColumnControls columns={grid.columns} layout={controls.layout} onChange={controls.set} onFit={fit} saved={savedColumns}/>
      <button disabled={disabled || changes.length >= 200} onClick={() => onChange([...changes, { kind: 'insert', values: [] }])}>Insert row</button>
      <button disabled={busy || !changes.length} onClick={() => onChange([])}>Discard edits</button>
      <button className="primary-button" disabled={disabled || !changes.length} onClick={onApply}>Apply edits</button>
      <button disabled={busy || disconnected || transaction || Boolean(changes.length)} onClick={onReload}>Reload data</button>
      <button disabled={busy || Boolean(changes.length)} onClick={onClose}>Close data</button>
    </div>
    <div className="grid-edit-hint" role="status">{busy ? 'Working with table data…' : disconnected ? 'The connection was lost. Staged edits are kept here for review. Discard them before reconnecting; nothing will be replayed.' : transaction ? 'Edits are in this tab’s transaction. Use Commit to save or Rollback to undo, then reopen the table.' : expired ? 'This snapshot has expired. Discard staged edits and reload the table before editing again.' : 'Edit cells or mark rows for deletion, then Apply edits. Apply starts a transaction; Commit saves it. Keys and generated values are protected.'}</div>
    <div ref={scroll} className="grid-scroll" role="table" tabIndex={0} aria-label="Editable table data" aria-description={`${grid.rows.length} rows loaded; ${inserted.length} new rows staged. Row positions are within this page. Columns follow the displayed order. Scroll to reach other rows. Edits are staged until Apply edits; Commit saves them.`} aria-rowcount={grid.rows.length + inserted.length + 1} aria-colcount={controls.visible.length + 1}>
      <div className="grid-header" role="row" aria-rowindex={1} style={style}><span role="columnheader" aria-colindex={1} className="row-number">Row</span>{controls.visible.map((index, position) => {const column=grid.columns[index]; return <span role="columnheader" aria-colindex={position + 2} aria-label={column.name} aria-description={`Source column ${index + 1}. ${column.type}.${column.primaryKey ? ' Primary key.' : ''}${column.generated ? ' Generated.' : ''}`} key={index} style={controls.cellStyle(index)}><b>{column.name}{column.primaryKey ? ' · key' : ''}</b><small>{column.type}{column.generated ? ' · generated' : ''}</small><ColumnResizer label={`Resize column ${index+1} ${column.name}`} width={controls.size(index)} onResize={width=>controls.setWidths({[index]:width})} onFit={()=>fit([index])} onReset={()=>controls.resetWidth(index)}/></span>})}</div>
      <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: style.minWidth }}>
        {virtual.getVirtualItems().map(item => {
          const row = item.index, isNew = row >= grid.rows.length
          const change = isNew ? inserted[row - grid.rows.length].change : changes.find(change => change.kind !== 'insert' && change.row === row)
          const deleted = change?.kind === 'delete'
          return <div className={`grid-row editable-row ${deleted ? 'deleted-row' : change ? 'changed-row' : ''}`} role="row" aria-rowindex={row + 2} key={item.key} style={{ ...style, position: 'absolute', top: item.start, height: item.size }}>
            <span role="cell" aria-colindex={1} className="row-edit-action">{isNew ? 'New' : row + 1}<button aria-label={`${deleted ? 'Undo delete' : 'Delete'} row ${row + 1}`} disabled={disabled} onClick={() => remove(row)}>{deleted ? 'Undo' : 'Delete'}</button></span>
            {controls.visible.map((index, position) => {
              const column=grid.columns[index]
              const staged = change && change.kind !== 'delete' ? change.values.find(value => value.column === index) : undefined
              const value = staged ? staged.value : isNew ? undefined : grid.rows[row][index]
              const readOnly = disabled || deleted || column.generated || !isNew && column.primaryKey
              return <span role="cell" aria-colindex={position + 2} className={`editable-cell ${staged ? 'staged-cell' : ''}`} key={index} style={controls.cellStyle(index)}>
                <textarea rows={1} aria-label={`Row ${row + 1} ${column.name}`} aria-description={`${value === null ? 'SQL NULL. ' : value === '' ? 'Empty text. ' : value === undefined ? column.generated ? 'Generated value. ' : 'Database default. ' : ''}${staged ? 'Staged value. ' : ''}${deleted ? 'Row marked for deletion. ' : ''}${column.generated ? 'Protected generated column.' : !isNew && column.primaryKey ? 'Protected primary key.' : ''}`.trim() || undefined} readOnly={readOnly} value={value ?? ''} placeholder={value === null ? 'NULL' : value === undefined ? column.generated ? 'Generated' : 'DEFAULT' : ''} maxLength={16384} onChange={event => edit(row, index, event.target.value)} />
                <button className="inspect-cell-button" disabled={value===undefined} aria-label={`Inspect row ${row+1} ${column.name}`} onClick={()=>setInspecting({value:value??null,column:{name:column.name,typeId:0,typeName:column.type},row,columnIndex:index})}>Inspect</button>
                {!column.generated && (!column.primaryKey || isNew) && <span className="cell-actions">
                  <button disabled={readOnly || !column.nullable || column.primaryKey} aria-label={`Set row ${row + 1} ${column.name} NULL`} onClick={() => edit(row, index, null)}>NULL</button>
                  {isNew && <button disabled={readOnly} aria-label={`Use default for row ${row + 1} ${column.name}`} onClick={() => edit(row, index, undefined)}>DEFAULT</button>}
                  {value === null && <button disabled={readOnly} aria-label={`Set row ${row + 1} ${column.name} empty text`} onClick={() => edit(row, index, '')}>Empty</button>}
                </span>}
              </span>
            })}
          </div>
        })}
      </div>
      {!grid.rows.length && !inserted.length && <p className="zero-rows">No rows match this page. Use Insert row to add a record.</p>}
    </div>
    <div className="result-footer"><span>{grid.rows.length} rows loaded{grid.truncated ? ' · More rows available' : ''}</span><span>Staged edits stay in memory until applied</span></div>
    {inspecting&&<ValueInspector cell={inspecting} actions={changes.length||busy||expired||transaction?undefined:actions} onClose={()=>setInspecting(undefined)}/>}
  </div>
}
