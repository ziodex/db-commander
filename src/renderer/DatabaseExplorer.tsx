import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { explorerTree } from './explorer-tree'
import { ExplorerCatalogActions, ExplorerCatalogTree } from './ExplorerCatalogTree'
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { objectKinds, objectKey, type CatalogObject } from '../shared/catalog'
import { ChevronDown, ChevronRight, Database, RefreshCw, Search } from 'lucide-react'
import type { GridTable } from '../shared/contracts'
import { canSwitchDatabase, type QueryTabState } from './query-tabs'

type MenuTarget = { kind: 'database'; name: string } | { kind: 'table'; table: GridTable; objectId?: string }
type ExplorerMenu = Omit<MenuAnchor, 'items'> & { target: MenuTarget }

export function DatabaseExplorer({ state, onRefreshDatabases, onRefreshSchema, onSwitch, onFilter, onAppendSelect, onEdit, onBrowse, onInspect, onSchemaChange, onDiagram, onBackup, onCompare, onCompareData, onBuilder, onActivity }: {
  onActivity():void
  onBuilder(table?: GridTable): void
  onCompareData(table?: GridTable): void
  onBackup(): void; onCompare(): void
  onDiagram(): void
  onSchemaChange(target?: CatalogObject): void
  onInspect(object: CatalogObject): void; state: QueryTabState; onRefreshDatabases(): void; onRefreshSchema(): void; onSwitch(database: string): void
  onFilter(value: string): void; onAppendSelect(table: GridTable): void; onEdit(table: GridTable): void; onBrowse(table: GridTable): void
}) {
  const [kind, setKind] = useState('all'), [menu,setMenu]=useState<ExplorerMenu|null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsedMatches, setCollapsedMatches] = useState<Set<string>>(() => new Set())
  const session = state.session!, catalog = state.databases, reason = canSwitchDatabase(state)
  const busy = state.backupBusy || state.transferBusy || state.running || state.schemaLoading || state.gridBusy || state.switching || state.databasesLoading
  useEffect(() => setExpanded(new Set()), [session.id, session.database])
  useEffect(() => setCollapsedMatches(new Set()), [state.tableSearch, kind, session.id, session.database])
  useEffect(()=>setMenu(null),[session.id,session.database])
  useEffect(()=>{if(menu&&!menu.owner.isConnected)setMenu(null)},[menu,state.schema,state.databases,state.tableSearch,kind])
  const context = useCallback((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, target: MenuTarget) => {
    if ('key' in event && !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
    event.preventDefault(); event.stopPropagation()
    const owner=event.currentTarget, bounds=owner.getBoundingClientRect()
    const pointer = 'clientX' in event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
    setMenu({owner,x:pointer?event.clientX:bounds.left,y:pointer?event.clientY:bounds.bottom,target})
  }, [])
  const relationContext = useCallback((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, table: GridTable, objectId?: string) => context(event, { kind: 'table', table, objectId }), [context])
  function tableItems(table: GridTable, object?: CatalogObject): MenuItem[] {
    return [
      {label:`Object details ${table.name}`,disabled:busy||!object,action:()=>object&&onInspect(object)},
      {label:`Append SELECT SQL for ${table.name}`,disabled:busy,title:'Append SQL to the current editor for review. This does not execute it.',action:()=>onAppendSelect(table)},
      {label:`Browse data ${table.name}`,disabled:busy||session.transaction!=='idle'||Boolean(state.gridChanges.length),action:()=>onBrowse(table)},
      {label:`Edit data ${table.name}`,disabled:busy||session.transaction!=='idle'||Boolean(state.gridChanges.length),action:()=>onEdit(table)},
      {label:`Build query from ${table.name}`,disabled:busy,action:()=>onBuilder(table)},
      ...(object?.kind==='table'?[{label:`Compare data ${table.name}`,disabled:busy,action:()=>onCompareData(table)}, {label:`Alter table ${table.name}`,disabled:busy||Boolean(state.gridChanges.length),action:()=>onSchemaChange(object)}]:[])
    ]
  }
  function databaseItems(name: string): MenuItem[] {
    const current=name===session.database
    return [
      {label:`Switch to database ${name}`,disabled:current||!catalog?.switchable||Boolean(reason),action:()=>onSwitch(name)},
      {label:'Database backup and restore',disabled:!current,title:current?'Backup or restore this database':'Select this database first to back up or restore it safely.',action:onBackup},
      {label:'Sessions and locks',disabled:!current||state.closing||state.switching,action:onActivity},
      {label:'Visual query builder',disabled:!current||busy,action:()=>onBuilder()},
      {label:'Compare table data',disabled:!current||busy,action:()=>onCompareData()},
      {label:'Compare schemas',disabled:!current||busy,action:onCompare},
      {label:'Schema changes',disabled:!current||busy,action:()=>onSchemaChange()},
      {label:'ER diagram',disabled:!current||busy,action:onDiagram},
      {label:'Refresh schema',disabled:!current||busy,action:onRefreshSchema}
    ]
  }
  function menuItems(target: MenuTarget): MenuItem[] {
    if (target.kind === 'database') return databaseItems(target.name)
    const object = state.schema?.catalog?.objects.find(object => objectKey(object) === target.objectId)
    return tableItems(target.table, object)
  }
  const names = [...new Set([...(catalog?.databases ?? []), ...(session.database ? [session.database] : [])])].sort()
  const filtered = Boolean(state.tableSearch.trim()) || kind !== 'all'
  const groups = useMemo(() => explorerTree(state.schema?.catalog?.objects ?? [], state.tables, state.tableSearch, kind), [state.schema?.catalog?.objects, state.tables, state.tableSearch, kind])
  const toggleRelation = useCallback((key: string) => (filtered ? setCollapsedMatches : setExpanded)(current => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next
  }), [filtered])
  function objects() {
    return <>
      <label className="schema-search"><Search size={13} /><input aria-label="Filter database objects" placeholder="Filter objects…" value={state.tableSearch} onChange={event => onFilter(event.target.value)} /></label>
      <label className="object-kind-filter">Object kind<select aria-label="Object kind" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All objects</option>{objectKinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <div className="schema-list">
        {state.schemaLoading && <p className="sidebar-description" role="status">Loading schema…</p>}
        {state.schemaError && <p className="sidebar-description" role="alert">Schema unavailable: {state.schemaError} Use Refresh schema to retry.</p>}
        {state.schema?.truncated && <p className="sidebar-description">Schema preview limit reached; some objects or columns are omitted.</p>}
        {state.schema?.catalog?.notice && <details className="explorer-info"><summary>Catalog details</summary><p>{state.schema.catalog.notice}</p></details>}
        {state.schema?.catalog?.truncated && <p className="sidebar-description">Catalog limit reached (2,000 objects). Some objects are omitted.</p>}
        <ExplorerCatalogActions value={{ busy, onInspect }}>
          <ExplorerCatalogTree groups={groups} search={state.tableSearch} kind={kind} filtered={filtered} expanded={expanded} collapsedMatches={collapsedMatches} onToggle={toggleRelation} onContext={relationContext}/>
        </ExplorerCatalogActions>
        {!groups.length && !state.schemaLoading && <p className="sidebar-description">No matching objects.</p>}
      </div>
    </>
  }
  return <div className="database-explorer">
    {menu&&<ContextMenu anchor={{...menu,items:menuItems(menu.target)}} onClose={()=>setMenu(null)}/>}
    <div className="database-heading" title="Right-click a database or table for actions (Shift+F10)."><span>Databases</span><button aria-label="Refresh databases" disabled={busy || state.connecting || state.closing} onClick={onRefreshDatabases}><RefreshCw size={12} /></button></div>
    {state.databasesLoading && <p className="sidebar-description" role="status">Loading databases…</p>}
    {state.databasesError && <p className="sidebar-description" role="alert">Databases unavailable: {state.databasesError} Use Refresh databases to retry.</p>}
    {catalog?.notice && <details className="explorer-info"><summary>Database details</summary><p>{catalog.notice}</p></details>}
    {catalog?.switchable && reason && !busy && <p className="sidebar-description">{reason}</p>}
    {!session.database && <p className="sidebar-description">No default database. Choose a database below or use qualified SQL names.</p>}
    {names.map(name => <div className="database-branch" key={name}>
      <div className={`database-node ${name === session.database ? 'current' : ''}`}>
        <button aria-label={`Switch to database ${name}`} aria-current={name === session.database ? 'true' : undefined} aria-disabled={name !== session.database && (!catalog?.switchable || Boolean(reason))} aria-haspopup="menu" onContextMenu={e=>context(e,{kind:'database',name})} onKeyDown={e=>context(e,{kind:'database',name})} title={name === session.database ? 'Current database · Right-click for actions (Shift+F10)' : reason ?? 'Open this database with a fresh session'} onClick={() => { if(name!==session.database && catalog?.switchable && !reason) onSwitch(name) }}>
          {name === session.database ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Database size={13} /><span>{name}</span>
        </button>
        {name === session.database && <button aria-label="Refresh schema" disabled={busy} onClick={onRefreshSchema}><RefreshCw size={12} /></button>}
      </div>
      {name === session.database && objects()}
    </div>)}
  </div>
}
