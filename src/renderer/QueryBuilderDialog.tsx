import { useEffect, useRef, useState } from 'react'
import type { GridTable, SchemaSnapshot, SessionInfo } from '../shared/contracts'
import { aggregates, builderOperators, builderTableKey, emptyBuilder, type BuilderColumn, type BuilderQuery, type BuilderPreview } from '../shared/query-builder'

export function QueryBuilderDialog({ session, snapshot, initialTable, blocked, onClose, onRefresh, onReview, onOpen }: {
  session: SessionInfo; snapshot: SchemaSnapshot | null; initialTable?: GridTable; blocked?: string;
  onClose(): void; onRefresh(): Promise<void>; onReview(query: BuilderQuery): Promise<BuilderPreview>; onOpen(sql: string): void
}) {
  const tables = (snapshot?.objects ?? []).filter(o => ['table','view','materialized view'].includes(o.kind) && o.columns.length)
  const location = (table: GridTable): GridTable => ({ schema:table.schema, name:table.name, ...(table.catalog ? {catalog:table.catalog} : {}) })
  function from(table?: GridTable): BuilderQuery {
    const selected = tables.find(t => table && builderTableKey(t) === builderTableKey(table))
    return { ...emptyBuilder(), ...(selected ? { sources:[{table:location(selected)}], projections:selected.columns.slice(0,3).map(c => ({column:{source:0,column:c.name},aggregate:'none' as const,alias:c.name})) } : {}) }
  }
  const [query,setQuery] = useState<BuilderQuery>(() => from(initialTable)), [preview,setPreview] = useState<BuilderPreview>(), [joinTable,setJoinTable] = useState('')
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false)
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  // A refreshed catalog invalidates any prior SQL review without discarding the design.
  useEffect(() => { setPreview(undefined); setMessage('') }, [snapshot])
  function change(next: BuilderQuery) { setQuery(next); setPreview(undefined); setError(''); setMessage('') }
  const columns = query.sources.flatMap((s,source) => (tables.find(t => builderTableKey(t) === builderTableKey(s.table))?.columns ?? []).map(c => ({source,column:c.name,type:c.type})))
  const refKey = (ref?: BuilderColumn) => ref ? JSON.stringify([ref.source,ref.column]) : ''
  const ref = (value: string): BuilderColumn => { const [source,column] = JSON.parse(value); return {source,column} }
  const columnSelect = (label: string, value: BuilderColumn | undefined, update: (ref:BuilderColumn)=>void, before = query.sources.length) => <select aria-label={label} value={refKey(value)} onChange={e => update(ref(e.target.value))}><option value="" disabled>Select a column…</option>{columns.filter(c => c.source < before).map(c => <option key={refKey(c)} value={refKey(c)}>t{c.source+1}.{c.column} · {c.type}</option>)}</select>
  function addJoin() {
    const table = tables.find(t => builderTableKey(t) === joinTable)
    if (!table || !columns[0]) return
    change({...query,sources:[...query.sources,{table:location(table),join:{type:'inner',on:[{left:{source:columns[0].source,column:columns[0].column},right:table.columns[0].name}]}}]})
  }
  function removeSource() {
    const length = query.sources.length-1
    change({...query,sources:query.sources.slice(0,-1), projections:query.projections.filter(p => !p.column || p.column.source < length), filters:query.filters.filter(p => p.column.source < length), having:[],order:[]})
  }
  function addJoinKey(source: number) {
    const left = columns.find(c => c.source < source), right = columns.find(c => c.source === source)
    if (!left || !right) return
    change({...query,sources:query.sources.map((s,i) => i === source ? {...s,join:{...s.join!,on:[...s.join!.on,{left:{source:left.source,column:left.column},right:right.column}]}} : s)})
  }
  function output(index: number, patch: Partial<BuilderQuery['projections'][number]>) { change({...query,projections:query.projections.map((p,i) => i===index ? {...p,...patch} : p)}) }
  function removeOutput(index: number) { change({...query,projections:query.projections.filter((_,i) => i!==index),having:[],order:[]}) }
  const operatorLabel:Record<string,string> = {eq:'=',ne:'≠',lt:'<',lte:'≤',gt:'>',gte:'≥',like:'LIKE', 'is-null':'IS NULL','not-null':'IS NOT NULL'}
  async function work(action:()=>Promise<void>) { if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('');try{await action()}catch(e){setError((e as Error).message)}finally{pending.current=false;setBusy(false)} }
  function filters(having=false) {
    const items = having ? query.having : query.filters
    const update = (i:number, patch:object) => change({...query,[having?'having':'filters']:items.map((p,j) => i===j ? {...p,...patch} : p)})
    const tag = having ? 'Having' : 'Filter'
    return <section className="builder-section"><h3>{having ? 'HAVING aggregate filters' : 'WHERE row filters'}</h3>
      <label>Match<select aria-label={`${tag} logic`} value={having?query.havingLogic:query.filterLogic} onChange={e=>change({...query,[having?'havingLogic':'filterLogic']:e.target.value})}><option value="and">All conditions (AND)</option><option value="or">Any condition (OR)</option></select></label>
      {items.map((p,i)=><div className="builder-row" key={i}>
        {having ? <select aria-label={`${tag} ${i+1} output`} value={(p as BuilderQuery['having'][number]).projection} onChange={e=>update(i,{projection:Number(e.target.value)})}>{query.projections.map((o,j)=>o.aggregate!=='none'&&<option key={j} value={j}>{o.alias} · {o.aggregate}</option>)}</select> : columnSelect(`${tag} ${i+1} column`,(p as BuilderQuery['filters'][number]).column,c=>update(i,{column:c}))}
        <select aria-label={`${tag} ${i+1} operator`} value={p.operator} onChange={e=>update(i,{operator:e.target.value,parameter:['is-null','not-null'].includes(e.target.value)?'':p.parameter||`${having?'having':'filter'}_${i+1}`})}>{builderOperators.map(op=><option key={op} value={op}>{operatorLabel[op]}</option>)}</select>
        {!['is-null','not-null'].includes(p.operator)&&<input aria-label={`${tag} ${i+1} parameter`} maxLength={64} placeholder="Parameter name" value={p.parameter} onChange={e=>update(i,{parameter:e.target.value})}/>}
        <button aria-label={`Remove ${tag.toLowerCase()} ${i+1}`} onClick={()=>change({...query,[having?'having':'filters']:items.filter((_,j)=>i!==j)})}>Remove</button>
      </div>)}
      <button disabled={items.length >= (having?8:16) || (having ? !query.projections.some(p=>p.aggregate!=='none') : !columns.length)} onClick={()=>change({...query,[having?'having':'filters']:[...items,{...(having?{projection:query.projections.findIndex(p=>p.aggregate!=='none')}:{column:{source:columns[0].source,column:columns[0].column}}),operator:'eq',parameter:`${having?'having':'filter'}_${items.length+1}`} ]})}>Add {having?'HAVING condition':'filter'}</button>
    </section>
  }
  return <dialog ref={dialog} className="connection-dialog query-builder-dialog" aria-label="Visual query builder" onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
    <div className="dialog-heading"><div><h2>Visual query builder</h2><p>{session.name} · {session.database} · {session.engine}</p></div><button aria-label="Close query builder" disabled={busy} onClick={onClose}>×</button></div>
    <p>Build a SELECT from visible schema objects. Review SQL, then open it in a separate query tab. No SQL runs here; filter values are entered when you run the query.</p>
    {blocked&&!busy&&<p role="alert">{blocked}</p>}
    <button disabled={busy||!!blocked} onClick={()=>void work(async()=>{setPreview(undefined);await onRefresh()})}>Refresh builder schema</button>
    {snapshot?.truncated&&<p role="alert">Schema metadata is incomplete; use the SQL editor for this database.</p>}
    <fieldset disabled={busy} className="builder-design">
      <section className="builder-section"><h3>Sources and joins</h3>
        <label>Base table or view<select aria-label="Builder base table" value={query.sources[0]?builderTableKey(query.sources[0].table):''} onChange={e=>change(from(tables.find(t=>builderTableKey(t)===e.target.value)))}><option value="">Select a table or view…</option>{tables.map(t=><option key={builderTableKey(t)} value={builderTableKey(t)}>{[t.catalog,t.schema,t.name].filter(Boolean).join('.')} · {t.kind}</option>)}</select></label>
        <div className="builder-sources" aria-label="Query sources">{query.sources.map((source,i)=><div className="builder-source" key={i}>
          <h4>{i>0?'↳ ':''}t{i+1} · {source.table.name}</h4><p>{[source.table.catalog,source.table.schema].filter(Boolean).join('.')}</p>
          {source.join&&<><label>Join<select aria-label={`Join t${i+1} type`} value={source.join.type} onChange={e=>change({...query,sources:query.sources.map((s,j)=>j===i?{...s,join:{...s.join!,type:e.target.value as 'inner'|'left'}}:s)})}><option value="inner">INNER JOIN</option><option value="left">LEFT JOIN</option></select></label>
            {source.join.on.map((pair,k)=><div className="builder-row" key={k}>{columnSelect(`Join t${i+1} key ${k+1} left`,pair.left,c=>change({...query,sources:query.sources.map((s,j)=>j===i?{...s,join:{...s.join!,on:s.join!.on.map((p,l)=>l===k?{...p,left:c}:p)}}:s)}),i)}<span>=</span><select aria-label={`Join t${i+1} key ${k+1} right`} value={pair.right} onChange={e=>change({...query,sources:query.sources.map((s,j)=>j===i?{...s,join:{...s.join!,on:s.join!.on.map((p,l)=>l===k?{...p,right:e.target.value}:p)}}:s)})}>{columns.filter(c=>c.source===i).map(c=><option key={c.column}>{c.column}</option>)}</select><button aria-label={`Remove join t${i+1} key ${k+1}`} disabled={source.join!.on.length===1} onClick={()=>change({...query,sources:query.sources.map((s,j)=>j===i?{...s,join:{...s.join!,on:s.join!.on.filter((_,l)=>l!==k)}}:s)})}>Remove key</button></div>)}
            <button disabled={source.join.on.length>=8||!columns.some(c=>c.source<i)||!columns.some(c=>c.source===i)} onClick={()=>addJoinKey(i)}>Add join key t{i+1}</button>
          </>}
        </div>)}</div>
        <div className="builder-row"><select aria-label="Join table" value={joinTable} onChange={e=>setJoinTable(e.target.value)}><option value="">Choose a joined table…</option>{tables.map(t=><option key={builderTableKey(t)} value={builderTableKey(t)}>{[t.catalog,t.schema,t.name].filter(Boolean).join('.')}</option>)}</select><button disabled={!query.sources.length||query.sources.length>=5||!joinTable} onClick={addJoin}>Add join</button><button disabled={query.sources.length<2} onClick={removeSource}>Remove last join</button></div>
        <p>Up to five sources, including self joins. Each join uses one or more equality keys. Removing a join also removes its outputs/filters and resets HAVING/sorting.</p>
      </section>
      <section className="builder-section"><h3>Output columns and aggregates</h3>
        {query.projections.map((p,i)=><div className="builder-row" key={i}><select aria-label={`Output ${i+1} aggregate`} value={p.aggregate} onChange={e=>output(i,{aggregate:e.target.value as typeof p.aggregate,column:e.target.value==='count-all'?undefined:p.column??(columns[0]?{source:columns[0].source,column:columns[0].column}:undefined)})}>{aggregates.map(a=><option key={a}>{a}</option>)}</select>{p.aggregate!=='count-all'&&columnSelect(`Output ${i+1} column`,p.column,c=>output(i,{column:c}))}<input aria-label={`Output ${i+1} alias`} maxLength={128} value={p.alias} onChange={e=>output(i,{alias:e.target.value})}/><button aria-label={`Remove output ${i+1}`} onClick={()=>removeOutput(i)}>Remove</button></div>)}
        <button disabled={!columns.length||query.projections.length>=32} onClick={()=>change({...query,projections:[...query.projections,{column:{source:columns[0].source,column:columns[0].column},aggregate:'none',alias:`output_${query.projections.length+1}`} ]})}>Add output</button>
        <p>Up to 32 outputs. When aggregates are present, all non-aggregate outputs form GROUP BY. Removing an output resets HAVING and sorting.</p>
      </section>
      {filters()}{filters(true)}
      <section className="builder-section"><h3>Ordering and limit</h3>
        {query.order.map((order,i)=><div className="builder-row" key={i}><select aria-label={`Sort ${i+1} output`} value={order.projection} onChange={e=>change({...query,order:query.order.map((o,j)=>j===i?{...o,projection:Number(e.target.value)}:o)})}>{query.projections.map((p,j)=><option key={j} value={j}>{p.alias}</option>)}</select><select aria-label={`Sort ${i+1} direction`} value={order.direction} onChange={e=>change({...query,order:query.order.map((o,j)=>j===i?{...o,direction:e.target.value as 'asc'|'desc'}:o)})}><option value="asc">Ascending</option><option value="desc">Descending</option></select><button aria-label={`Remove sort ${i+1}`} onClick={()=>change({...query,order:query.order.filter((_,j)=>i!==j)})}>Remove</button></div>)}
        <button disabled={!query.projections.length||query.order.length>=8} onClick={()=>change({...query,order:[...query.order,{projection:0,direction:'asc'}]})}>Add sort</button>
        <label className="builder-check"><input type="checkbox" checked={query.distinct} onChange={e=>change({...query,distinct:e.target.checked})}/>DISTINCT output rows</label><label>Maximum returned rows<input aria-label="Builder row limit" type="number" min={1} max={1000} value={query.limit} onChange={e=>change({...query,limit:Number(e.target.value)})}/></label>
      </section>
      <button className="primary-button" disabled={!!blocked||!query.sources.length||!query.projections.length||snapshot?.truncated} onClick={()=>void work(async()=>{setPreview(undefined);setPreview(await onReview(query));setMessage('SQL reviewed against current schema. No query executed.')})}>Review builder SQL</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {preview&&<section className="builder-review"><h3>Reviewed SELECT</h3><p>{preview.database} · Metadata read {new Date(preview.fetchedAt).toLocaleTimeString()} · Parameters: {preview.parameters.map(p=>':'+p).join(', ')||'none'}</p><details><summary>Scope and execution notes</summary>{preview.warnings.map(w=><p key={w}>{w}</p>)}</details><textarea aria-label="Builder SQL preview" readOnly spellCheck={false} value={preview.sql}/><div className="dialog-actions"><button disabled={busy} onClick={()=>void work(async()=>{await window.dbCommander.copyDefinition(preview.sql);setMessage('Builder SQL copied.')})}>Copy builder SQL</button><button disabled={busy} onClick={()=>void work(async()=>{if(await window.dbCommander.saveSql(preview.sql))setMessage('Builder SQL saved.')})}>Save builder SQL</button><button disabled={busy||!!blocked} onClick={()=>{try{onOpen(preview.sql)}catch(e){setError((e as Error).message)}}}>Open SQL in new tab</button></div></section>}
  </dialog>
}
