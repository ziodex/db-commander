import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { columnWidth, DEFAULT_COLUMN_WIDTH, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from './column-sizing'
import { defaultColumns, resolveColumnLayout, visibleColumnIndices, type ColumnLayout } from '../shared/column-layout'
export { defaultColumns, type ColumnLayout } from '../shared/column-layout'
export interface SavedColumnControls {
  notice: string; disabled: boolean; exists: boolean; layout?: ColumnLayout
  save(layout: ColumnLayout): Promise<void>; remove(): Promise<void>
}
export function useColumns(columns: {name:string}[], width: number, rowWidth: number, view?: ColumnLayout, onView?: (view: ColumnLayout) => void) {
  const [local,setLocal] = useState(() => defaultColumns(columns.length))
  const signature = JSON.stringify(columns.map(c => c.name))
  useEffect(() => { setLocal(defaultColumns(columns.length)) },[signature, columns.length])
  const stored = view ?? local, layout = resolveColumnLayout(columns.length, stored)
  const latest = useRef(layout); latest.current = layout
  const set = (next: ColumnLayout) => { latest.current = next; setLocal(next); onView?.(next) }
  const setWidths = (widths: Record<number, number>) => set({ ...latest.current, widths: { ...latest.current.widths, ...widths } })
  const resetWidth = (index: number) => { const widths = { ...latest.current.widths }; delete widths[index]; set({ ...latest.current, widths }) }
  const visible = visibleColumnIndices(layout)
  const size = (i: number) => columnWidth(layout.widths[i] ?? width, width)
  const style = { gridTemplateColumns: `${rowWidth}px ${visible.map(i=>`${size(i)}px`).join(' ')}`, minWidth:rowWidth+visible.reduce((sum,i)=>sum+size(i),0) }
  const cellStyle = (i: number): CSSProperties => layout.pinned.includes(i) ? { position:'sticky', left:rowWidth+visible.slice(0,visible.indexOf(i)).filter(j=>layout.pinned.includes(j)).reduce((sum,j)=>sum+size(j),0), zIndex:2, background:'var(--surface-raised)' } : {}
  return { layout,set,setWidths,resetWidth,visible,size,style,cellStyle }
}
export function ColumnControls({ columns, layout, onChange, onFit, saved }: {columns:{name:string}[];layout:ColumnLayout;onChange(value:ColumnLayout):void;onFit?(indices:number[]):void;saved?:SavedColumnControls}) {
  const [open,setOpen] = useState(false)
  return <><button onClick={()=>setOpen(true)}>Columns</button>{open && <ColumnDialog columns={columns} layout={layout} onChange={onChange} onFit={onFit} saved={saved} onClose={()=>setOpen(false)}/>}</>
}
function ColumnDialog({columns,layout,onChange,onClose,onFit,saved}: {columns:{name:string}[];layout:ColumnLayout;onChange(value:ColumnLayout):void;onClose():void;onFit?(indices:number[]):void;saved?:SavedColumnControls}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const [saving,setSaving]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('')
  async function persist(action: () => Promise<void>, message: string) {
    setSaving(true);setError('');setNotice('')
    try { await action();setNotice(message) } catch(error) { setError(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) }
  }
  useEffect(()=>{const node=dialog.current!;node.showModal();return()=>node.close()},[])
  function move(index:number,delta:number) {const order=[...layout.order];[order[index],order[index+delta]]=[order[index+delta],order[index]];onChange({...layout,order})}
  return <dialog ref={dialog} className="connection-dialog column-dialog" aria-label="Column controls" onKeyDown={e=>e.stopPropagation()} onCancel={onClose}>
    <div className="dialog-heading"><h2>Columns</h2><button aria-label="Close column controls" onClick={onClose}>×</button></div>
    <p>Display only. Copy follows displayed columns; file exports retain their source’s fetched columns in original order. {saved ? 'Changes stay in this tab unless you save a table layout for future sessions.' : 'Settings apply only to this result view.'} Pinned columns appear first.</p>
    <p>Drag a header edge to resize. Double-click an edge or press Enter on it to fit the header and up to 200 loaded rows. No additional data is fetched.</p>
    {saved && <div className="saved-column-layout" role="group" aria-label="Saved table layout">
      <p>{saved.notice}</p>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="dialog-actions">
        <button disabled={saving||saved.disabled} onClick={()=>void persist(()=>saved.save(layout),'Table layout saved.')}>{saved.exists?'Update saved layout':'Save table layout'}</button>
        <button disabled={saving||saved.disabled||!saved.layout} onClick={()=>{onChange(saved.layout!);setNotice('Saved layout applied to this tab.')}}>Use saved layout</button>
        <button disabled={saving||saved.disabled||!saved.exists} onClick={()=>void persist(saved.remove,'Saved layout removed. Open tabs keep their current columns.')}>Remove saved layout</button>
      </div>
    </div>}
    {layout.order.map((i,position)=><div className="column-option" key={i}>
      <label><input type="checkbox" aria-label={`Show column ${i+1} ${columns[i].name}`} checked={!layout.hidden.includes(i)} disabled={!layout.hidden.includes(i)&&layout.hidden.length===columns.length-1} onChange={e=>onChange({...layout,hidden:e.target.checked?layout.hidden.filter(j=>j!==i):[...layout.hidden,i]})}/>{i+1}. {columns[i].name}</label>
      <label><input type="checkbox" aria-label={`Pin column ${i+1}`} checked={layout.pinned.includes(i)} onChange={e=>onChange({...layout,pinned:e.target.checked?[...layout.pinned,i]:layout.pinned.filter(j=>j!==i)})}/>Pin</label>
      <label>Width<ColumnWidth index={i} width={layout.widths[i]??DEFAULT_COLUMN_WIDTH} onChange={width=>onChange({...layout,widths:{...layout.widths,[i]:width}})}/></label>
      {onFit && <button aria-label={`Fit column ${i+1} ${columns[i].name}`} onClick={()=>onFit([i])}>Fit</button>}
      <button aria-label={`Move column ${i+1} left`} disabled={!position} onClick={()=>move(position,-1)}>←</button><button aria-label={`Move column ${i+1} right`} disabled={position===columns.length-1} onClick={()=>move(position,1)}>→</button>
    </div>)}
    <div className="dialog-actions">{onFit && <button onClick={()=>onFit(layout.order.filter(i=>!layout.hidden.includes(i)))}>Fit visible columns</button>}<button onClick={()=>onChange(defaultColumns(columns.length))}>Reset columns</button><button onClick={onClose}>Done</button></div>
  </dialog>
}
function ColumnWidth({index,width,onChange}:{index:number;width:number;onChange(width:number):void}) {
  const [text,setText]=useState(String(width))
  useEffect(()=>setText(String(width)),[width])
  return <input type="number" aria-label={`Width column ${index+1}`} min={MIN_COLUMN_WIDTH} max={MAX_COLUMN_WIDTH} step={1} value={text} onChange={e=>setText(e.target.value)} onBlur={()=>{const next=columnWidth(Number(text)||MIN_COLUMN_WIDTH);setText(String(next));onChange(next)}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/>
}
