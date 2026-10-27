import { useEffect, useRef, useState } from 'react'
import { objectKinds } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { comparisonSql, type CompareSchemaRequest, type SchemaComparison } from '../shared/schema-compare'
import type { QueryTabState } from './query-tabs'
import { MigrationExportDialog } from './MigrationExportDialog'

export function SchemaCompareDialog({ target, tabs, load, onClose, onOpen }: {
  target: SessionInfo; tabs: {id:string;title:string;state:QueryTabState}[]; load(request:CompareSchemaRequest):Promise<SchemaComparison>; onClose():void; onOpen(sql:string):void
}) {
  const candidates=tabs.filter(t=>t.state.session?.engine===target.engine), initial=candidates.find(t=>t.state.session?.id!==target.id)??candidates[0]
  const [sourceId,setSourceId]=useState(initial?.state.session?.id??target.id)
  const defaults=(id:string)=>{const state=tabs.find(t=>t.state.session?.id===id)?.state,s=state?.session!,o=state?.schema?.catalog?.objects.find(o=>o.kind==='table');return {schema:o?.schema??(s.engine==='postgres'?'public':['sqlserver','azure-sql'].includes(s.engine)?'dbo':s.engine==='oracle'?s.user.toUpperCase():['mysql','mariadb'].includes(s.engine)?s.database:'main'),catalog:o?.catalog??(s.engine==='duckdb'?s.database:'')}}
  const [sourceScope,setSourceScope]=useState(()=>defaults(sourceId)),[targetScope,setTargetScope]=useState(()=>defaults(target.id)),[filter,setFilter]=useState(''),[kinds,setKinds]=useState<string[]>(['table','view'])
  const [result,setResult]=useState<SchemaComparison|null>(null),[selected,setSelected]=useState<string[]>([]),[focus,setFocus]=useState(''),[status,setStatus]=useState('differences'),[destructive,setDestructive]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const dialog=useRef<HTMLDialogElement>(null),active=useRef(true),pending=useRef(false)
  const [migration,setMigration]=useState(false)
  useEffect(()=>{const node=dialog.current!;active.current=true;node.showModal();return()=>{active.current=false;node.close()}},[])
  function invalidate(){setResult(null);setSelected([]);setDestructive(false);setError('');setMessage('')}
  async function compare(){if(pending.current)return;pending.current=true;setBusy(true);invalidate();try{const next=await load({source:{sessionId:sourceId,schema:sourceScope.schema,...(sourceScope.catalog?{catalog:sourceScope.catalog}:{})},target:{sessionId:target.id,schema:targetScope.schema,...(targetScope.catalog?{catalog:targetScope.catalog}:{})},filter,kinds:kinds as CompareSchemaRequest['kinds']});if(active.current){setResult(next);setSelected(next.objects.filter(o=>o.status!=='matching'&&o.status!=='unknown').map(o=>o.key));setFocus(next.objects[0]?.key??'');setMessage(`${next.objects.length} objects compared. No SQL executed.`)}}catch(e){if(active.current)setError((e as Error).message)}finally{pending.current=false;if(active.current)setBusy(false)}}
  const sql=result?comparisonSql(result,selected,destructive):'',item=result?.objects.find(o=>o.key===focus)
  const selectedState=tabs.find(t=>t.state.session?.id===sourceId)?.state
  const blocked=!selectedState?.session||[selectedState,tabs.find(t=>t.state.session?.id===target.id)?.state].some(s=>!s||s.running||s.schemaLoading||s.gridBusy||s.backupBusy||s.transferBusy||s.switching||s.databasesLoading||s.closing||s.connecting||s.gridChanges.length||s.session?.transaction!=='idle'||s.session.engine!=='oracle'&&s.session.autocommit===false)
  return <dialog ref={dialog} className="connection-dialog schema-compare-dialog" aria-label="Compare schemas" onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
    <div className="dialog-heading"><div><h2>Compare schemas</h2><p>Source → target: {target.name} · {target.host}{target.port?`:${target.port}`:''} / {target.database}. Match object names within namespaces.</p></div><button disabled={busy} aria-label="Close schema comparison" onClick={onClose}>×</button></div>
    <fieldset disabled={busy} className="comparison-scope"><legend>Comparison scope</legend>
      <label>Source tab<select value={sourceId} onChange={e=>{setSourceId(e.target.value);setSourceScope(defaults(e.target.value));invalidate()}}>{candidates.map(t=><option key={t.id} value={t.state.session!.id}>{t.title} · {t.state.session!.name} · {t.state.session!.host} / {t.state.session!.database}</option>)}</select></label>
      <label>Source schema<input value={sourceScope.schema} onChange={e=>{setSourceScope({...sourceScope,schema:e.target.value});invalidate()}}/></label>
      <label>Target schema<input value={targetScope.schema} onChange={e=>{setTargetScope({...targetScope,schema:e.target.value});invalidate()}}/></label>
      {target.engine==='duckdb'&&<><label>Source catalog<input value={sourceScope.catalog} onChange={e=>{setSourceScope({...sourceScope,catalog:e.target.value});invalidate()}}/></label><label>Target catalog<input value={targetScope.catalog} onChange={e=>{setTargetScope({...targetScope,catalog:e.target.value});invalidate()}}/></label></>}
      <label>Object name contains<input maxLength={200} value={filter} onChange={e=>{setFilter(e.target.value);invalidate()}}/></label>
      <label>Object kinds<select multiple value={kinds} onChange={e=>{setKinds([...e.target.selectedOptions].map(o=>o.value));invalidate()}}>{objectKinds.map(k=><option key={k}>{k}</option>)}</select></label>
    </fieldset>
    <p>Up to 40 objects per side. Connect the source in another query tab, or select different namespaces in this tab. Empty namespaces may be entered explicitly.</p>
    {blocked&&!busy&&<p role="alert">Finish both tabs’ operations, commit or roll back, and apply or discard staged edits before comparing.</p>}
    <button disabled={busy||blocked||!sourceScope.schema||!targetScope.schema||!kinds.length} onClick={()=>void compare()}>{busy?'Comparing schemas…':'Compare schemas'}</button>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {result&&<>
      <details><summary>Scope and limitations</summary>{result.notices.map((n,i)=><p key={i}>{n}</p>)}</details>
      <label>Show objects<select value={status} onChange={e=>setStatus(e.target.value)}><option value="differences">Differences and unknown</option><option value="all">All objects</option>{['source-only','target-only','changed','matching','unknown'].map(s=><option key={s}>{s}</option>)}</select></label>
      <div className="comparison-list" role="group" aria-label="Compared objects">{result.objects.filter(o=>status==='all'||status==='differences'&&o.status!=='matching'||o.status===status).map(o=><div key={o.key}><input type="checkbox" aria-label={`Include ${o.kind} ${o.name}`} disabled={o.status==='matching'||o.status==='unknown'} checked={selected.includes(o.key)} onChange={e=>setSelected(s=>e.target.checked?[...s,o.key]:s.filter(k=>k!==o.key))}/><button aria-pressed={focus===o.key} onClick={()=>setFocus(o.key)}>{o.name}{o.parent?` on ${o.parent}`:''}{o.signature?` (${o.signature})`:''} · {o.kind} · {o.status}</button></div>)}</div>
      {item&&<section><h3>{item.name} · {item.status}</h3>{item.notices.map((n,i)=><p key={i}>{n}</p>)}<div className="comparison-definitions">{(['source','target'] as const).map(side=><details key={side}><summary>{side==='source'?'Source':'Target'} definition and metadata</summary><pre aria-label={`${side} definition`}>{item[side]?.definition.sql??'No readable definition.'}</pre><pre>{JSON.stringify(item[side]?.sections??[],null,2)}</pre></details>)}</div></section>}
      <label className="comparison-check"><input type="checkbox" checked={destructive} onChange={e=>setDestructive(e.target.checked)}/>Include destructive DROP TABLE suggestions; I understand these remove target data.</label>
      <label>Review SQL<textarea aria-label="Comparison SQL preview" readOnly value={sql}/></label>
      {sql.length>1_000_000&&<p role="alert">Select fewer objects before copying, saving or opening SQL. SQL documents are limited to 1 MB.</p>}
      <div className="dialog-actions"><button disabled={!selected.length||sql.length>1_000_000} onClick={()=>{void window.dbCommander.copyDefinition(sql).then(()=>setMessage('SQL copied.'),e=>setError(e.message))}}>Copy comparison SQL</button><button disabled={!selected.length||sql.length>1_000_000} onClick={()=>{void window.dbCommander.saveSql(sql).then(path=>{if(path)setMessage('Comparison SQL saved.')},e=>setError(e.message))}}>Save comparison SQL</button><button disabled={!selected.length||sql.length>1_000_000} onClick={()=>onOpen(sql)}>Open SQL in target tab</button></div>
      <p>Opens a new query tab using the target connection. Review and execute deliberately; comparison never applies changes.</p>
      <button disabled={!selected.length || !result.migrationSourceId} onClick={()=>setMigration(true)}>Export migration…</button>
      {migration && result.migrationSourceId && <MigrationExportDialog sourceId={result.migrationSourceId} engine={result.engine} selected={selected} includeDestructive={destructive} onClose={()=>setMigration(false)}/>}
    </>}
  </dialog>
}
