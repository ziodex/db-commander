import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { CatalogBrowser } from './CatalogBrowser'
import type { ReadCatalog } from './use-catalog-page'
import { useCallback, useEffect, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { objectKey, type CatalogObject } from '../shared/catalog'
import { ChevronDown, ChevronRight, RefreshCw } from './WorkbenchIcons'
import { MaterialIcon } from './MaterialIcon'
import type { GridTable } from '../shared/contracts'
import { canSwitchDatabase, tabOperationBusy, type QueryTabState } from './query-tabs'

type MenuTarget = { kind: 'database'; name: string } | { kind: 'table'; table: GridTable; objectId?: string; object?: CatalogObject }
type ExplorerMenu = Omit<MenuAnchor, 'items'> & { target: MenuTarget }

export function DatabaseExplorer({ state, readCatalog, catalogPaused, browseDisabled, onRefreshDatabases, onRefreshSchema, onSwitch, onFilter, onAppendSelect, onEdit, onBrowse, onInspect, onSchemaChange, onDiagram, onBackup, onCompare, onCompareData, onBuilder, onActivity }: {
  readCatalog: ReadCatalog
  catalogPaused: boolean
  browseDisabled: boolean
  onActivity():void
  onBuilder(table?: GridTable): void
  onCompareData(table?: GridTable): void
  onBackup(): void; onCompare(): void
  onDiagram(): void
  onSchemaChange(target?: CatalogObject): void
  onInspect(object: CatalogObject): void; state: QueryTabState; onRefreshDatabases(): void; onRefreshSchema(): void; onSwitch(database: string): void
  onFilter(value: string): void; onAppendSelect(table: GridTable): void; onEdit(table: GridTable): void; onBrowse(table: GridTable): void
}) {
  const [menu,setMenu]=useState<ExplorerMenu|null>(null)
  const session = state.session!, catalog = state.databases, reason = canSwitchDatabase(state)
  const busy = tabOperationBusy(state)
  useEffect(()=>setMenu(null),[session.id,session.database])
  useEffect(()=>{if(menu&&!menu.owner.isConnected)setMenu(null)},[menu,state.schema,state.databases,state.tableSearch])
  const context = useCallback((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, target: MenuTarget) => {
    if ('key' in event && !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
    event.preventDefault(); event.stopPropagation()
    const owner=event.currentTarget, bounds=owner.getBoundingClientRect()
    const pointer = 'clientX' in event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
    setMenu({owner,x:pointer?event.clientX:bounds.left,y:pointer?event.clientY:bounds.bottom,target})
  }, [])
  const relationContext = useCallback((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, table: GridTable, objectId?: string, object?: CatalogObject) => context(event, { kind: 'table', table, objectId, object }), [context])
  function tableItems(table: GridTable, object?: CatalogObject): MenuItem[] {
    return [
      {label:`Object details ${table.name}`,disabled:busy||!object,action:()=>object&&onInspect(object)},
      {label:`Append SELECT SQL for ${table.name}`,disabled:busy,title:'Append SQL to the current editor for review. This does not execute it.',action:()=>onAppendSelect(table)},
      {label:`Browse data ${table.name}`,disabled:browseDisabled||busy||session.transaction!=='idle'||Boolean(state.gridChanges.length),title:'Open the browse query and results in a new tab.',action:()=>onBrowse(table)},
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
    const object = target.object ?? state.schema?.catalog?.objects.find(object => objectKey(object) === target.objectId)
    return tableItems(target.table, object)
  }
  const names = [...new Set([...(catalog?.databases ?? []), ...(session.database ? [session.database] : [])])].sort()
  function objects() {
    return <CatalogBrowser state={state} paused={catalogPaused} read={readCatalog} onFilter={onFilter} onInspect={onInspect} onContext={relationContext}/>
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
          {name === session.database ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<MaterialIcon name="database"/><span>{name}</span>
        </button>
        {name === session.database && <button aria-label="Refresh schema" disabled={busy} onClick={onRefreshSchema}><RefreshCw size={12} /></button>}
      </div>
      {name === session.database && objects()}
    </div>)}
  </div>
}
