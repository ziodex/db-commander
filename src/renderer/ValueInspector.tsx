import { useMemo, useState } from 'react'
import { ModalDialog } from './ModalDialog'
import { formatJson, hexDump, INSPECT_LIMIT, inspectionPrefix, type CellInspection, type ForeignKey } from '../shared/inspection'
import type { Cell, Column } from '../shared/contracts'

export interface InspectCell { value: Cell; column: Column; row: number; columnIndex: number; mark?: {truncated?:boolean;unavailable?:boolean;binary?:boolean} }
export interface InspectionActions { load?(row:number,column:number):Promise<CellInspection>; references?():Promise<ForeignKey[]>; follow?(row:number,referenceId:string):Promise<void> }
export function ValueInspector({ cell, actions, onClose }: {cell:InspectCell;actions?:InspectionActions;onClose():void}) {
  const [mode,setMode]=useState('text'),[offset,setOffset]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[refs,setRefs]=useState<ForeignKey[]>()
  const binary=Boolean(cell.mark?.binary)||/bytea|blob|binary|raw|image/i.test(cell.column.typeName??'')||cell.column.typeId===17
  const canonical=binary&&cell.value!==null&&/^(?:0x|\\x)[\da-f]*$/i.test(cell.value)?cell.value.slice(2):undefined
  const [value,setValue]=useState<CellInspection>({value:canonical??cell.value,encoding:canonical!==undefined?'hex':'text',truncated:Boolean(cell.mark?.truncated),source:'snapshot',notice:cell.mark?.unavailable?'This page contains a type placeholder. Load the live value to inspect it.':'Captured value. Opening this inspector does not execute SQL.'})
  const displayed=useMemo<{text:string;notice?:string;error?:string;bytes?:number;outline?:{depth:number;label:string}[]}>(()=>{
    const text=value.value===null?'':inspectionPrefix(value.value)
    try {
      if(mode==='json') {if(value.encoding==='hex')throw new Error('Binary data must be decoded explicitly in SQL before JSON inspection.');try{return {text:formatJson(text)}}catch(error){if(error instanceof SyntaxError)return {text,error:'This value is not valid JSON. Choose Text to inspect the original value.'};throw error}}
      if(mode==='xml') {
        if(value.encoding==='hex')throw new Error('Binary data must be decoded explicitly in SQL before XML inspection.')
        if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('DTD and entity declarations are not processed. Use Text to inspect the original XML.')
        const document=new DOMParser().parseFromString(text,'application/xml')
        if(document.querySelector('parsererror'))throw new Error('Invalid XML. Use Text to inspect the original value.')
        const outline:{depth:number;label:string}[]=[],pending=[{node:document.documentElement as Node,depth:0}]
        while(pending.length&&outline.length<500){const {node,depth}=pending.pop()!;if(depth>50)continue
          if(node.nodeType===1){const element=node as Element;outline.push({depth,label:'<'+element.tagName+[...element.attributes].map(a=>` ${a.name}="${a.value.slice(0,256)}"`).join('')+'>'})}
          else if(node.textContent?.trim())outline.push({depth,label:node.textContent.slice(0,256)})
          for(let i=node.childNodes.length-1;i>=0;i--)pending.push({node:node.childNodes[i],depth:depth+1})
        }
        return {text,outline,notice:`Valid XML · root ${document.documentElement.tagName}. Outline limited to 500 nodes / 50 levels. Original whitespace and attributes are preserved in the text; external content is never loaded.`}
      }
      if(mode==='hex') {const result=hexDump(text,value.encoding,offset);return {...result,notice:value.encoding==='hex'?'Database binary bytes':'UTF-8 bytes of the displayed text representation'}}
      return {text:value.value===null?'NULL':text}
    }catch(error){return {text,error:(error as Error).message}}
  },[mode,value,offset])
  async function work(action:()=>Promise<void>) {setBusy(true);setError('');setMessage('');try{await action()}catch(error){setError((error as Error).message)}finally{setBusy(false)}}
  const limited=value.truncated||(value.value?.length??0)>INSPECT_LIMIT
  return <ModalDialog className="connection-dialog value-dialog" aria-label="Value inspector" onDismiss={()=>{if(!busy)onClose()}}>
    <div className="dialog-heading"><div><h2>{cell.column.name}</h2><p>Row {cell.row+1} · column {cell.columnIndex+1} · {cell.column.typeName??`Type ${cell.column.typeId}`} · {value.value===null?'SQL NULL':value.value===''?'Empty value':`${value.encoding==='hex'?(value.value.length/2)+' bytes':value.value.length+' characters'}`}</p></div><button disabled={busy} aria-label="Close value inspector" onClick={onClose}>×</button></div>
    <p>{value.notice}</p>{limited&&<p role="alert">Partial value: inspection is limited to 262,144 characters or 131,072 binary bytes. Copy/save includes only the displayed capture; use full-result export for larger values.</p>}
    <div className="inspection-actions"><label>View as<select aria-label="Value format" disabled={busy||value.value===null} value={mode} onChange={e=>{setMode(e.target.value);setOffset(0)}}><option value="text">Text</option><option value="json">JSON</option><option value="xml">XML</option><option value="hex">Hex</option></select></label>
      {actions?.load&&<button disabled={busy} onClick={()=>void work(async()=>{setValue(await actions.load!(cell.row,cell.columnIndex));setOffset(0)})}>Load live value</button>}
      <button disabled={busy||value.value===null||Boolean(displayed.error)} onClick={()=>void work(async()=>{await window.dbCommander.copyDefinition(displayed.text);setMessage('Displayed value copied.')})}>Copy displayed value</button>
      <button disabled={busy||value.value===null||Boolean(displayed.error)} onClick={()=>void work(async()=>{if(await window.dbCommander.saveValue({text:displayed.text,format:mode==='json'?'json':mode==='xml'?'xml':'text'}))setMessage('Displayed value saved.')})}>Save displayed value</button>
      {actions?.references&&<button disabled={busy} onClick={()=>void work(async()=>{setRefs(await actions.references!())})}>Find foreign keys</button>}
    </div>
    {error&&<p role="alert">{error}</p>}{displayed.error&&<p role="alert">{displayed.error}</p>}{displayed.notice&&<p>{displayed.notice}</p>}{message&&<p role="status">{message}</p>}{busy&&<p role="status">Loading…</p>}
    {mode==='hex'&&<div className="inspection-actions"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-4096))}>Previous bytes</button><span>Byte offset {offset} · {displayed.bytes??0} captured bytes</span><button disabled={offset+4096>=(displayed.bytes??0)} onClick={()=>setOffset(offset+4096)}>Next bytes</button></div>}
    {displayed.outline&&<div className="xml-outline" aria-label="XML structure">{displayed.outline.map((node,index)=><div key={index} style={{paddingLeft:Math.min(20,node.depth)*16}}>{node.label}</div>)}</div>}
    <textarea className="value-content" aria-label="Inspected value" readOnly spellCheck={false} value={displayed.text}/>
    {refs&&<section aria-label="Foreign-key navigation"><h3>References from this column</h3><p>Follows the captured row’s declared key into a filtered table page. Composite keys use all columns; NULL keys cannot be followed.</p>{refs.filter(ref=>ref.columns.includes(cell.column.name)).map(ref=><button key={ref.id} disabled={busy||!actions?.follow} onClick={()=>void work(async()=>{await actions!.follow!(cell.row,ref.id);onClose()})}>Follow {ref.name} → {ref.target.schema}.{ref.target.name}</button>)}{!refs.some(ref=>ref.columns.includes(cell.column.name))&&<p>No declared foreign key is visible for this column.</p>}</section>}
  </ModalDialog>
}
