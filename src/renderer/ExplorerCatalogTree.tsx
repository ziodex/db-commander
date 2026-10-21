import { createContext, memo, useContext, useId, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, Table2 } from 'lucide-react'
import { objectKey, type CatalogObject } from '../shared/catalog'
import type { GridTable } from '../shared/contracts'
import type { ExplorerGroup, ObjectCollection } from './explorer-tree'

// Live actions remain current without rebuilding every catalog row when the
// editor changes. Only visible collections subscribe to these actions.
const Actions = createContext<{ busy: boolean; onInspect(object: CatalogObject): void } | null>(null)
export const ExplorerCatalogActions = Actions.Provider

function Collections({ collections, search, kind, filtered, nested = false }: {
  collections: ObjectCollection[]; search: string; kind: string; filtered: boolean; nested?: boolean
}) {
  const actions = useContext(Actions)!
  return collections.map(collection => <details className="catalog-kind" key={`${collection.title}:${search}:${kind}`} open={filtered}>
    <summary>{collection.title}</summary>
    {collection.objects.map(object => <button key={objectKey(object)} title={[object.name, object.constraintType, object.signature, object.parent ? `on ${object.parent}` : undefined].filter(Boolean).join(' · ')} aria-label={`Object details ${object.name}${object.signature ? ` (${object.signature})` : ''}${object.parent ? ` on ${object.parent}` : ''}`} disabled={actions.busy} onClick={() => actions.onInspect(object)}>
      <span>{object.name}<small>{object.constraintType ?? object.signature ?? (!nested ? object.parent : undefined)}</small></span>
    </button>)}
  </details>)
}

/** SQL edits leave the catalog structure unchanged, including its DOM rows. */
export const ExplorerCatalogTree = memo(function ExplorerCatalogTree({ groups, search, kind, filtered, expanded, collapsedMatches, onToggle, onContext }: {
  groups: ExplorerGroup[]; search: string; kind: string; filtered: boolean
  expanded: Set<string>; collapsedMatches: Set<string>
  onToggle(key: string): void
  onContext(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, table: GridTable, objectId?: string): void
}) {
  const treeId = useId()
  return groups.map(group => <details className="schema-group" key={group.key} open><summary>{group.label}</summary>
    {group.relations.map(({ key, table, object, collections }) => {
      const open = filtered ? !collapsedMatches.has(key) : expanded.has(key), childrenId = `${treeId}-${encodeURIComponent(key)}`
      const context = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => onContext(event, table, object && objectKey(object))
      return <div className="relation-node" key={key}>
        <div className="schema-object">
          {collections.length > 0 ? <button className="object-expand" aria-label={`${open ? 'Collapse' : 'Expand'} ${table.kind} ${table.name}`} aria-expanded={open} aria-controls={childrenId} onClick={() => onToggle(key)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button> : <span className="object-expand-spacer" />}
          <button className="object-label" aria-label={`${table.name} ${group.label}`} title={`${table.name} · Open table actions (Enter or Shift+F10)`} aria-haspopup="menu" onContextMenu={context} onKeyDown={context} onClick={context}><Table2 size={13}/><span>{table.name}</span><small>{table.kind}</small></button>
        </div>
        {collections.length > 0 && <div className="relation-children" id={childrenId} hidden={!open}>{open && <Collections collections={collections} search={search} kind={kind} filtered={filtered} nested/>}</div>}
      </div>
    })}
    {group.collections.length > 0 && <Collections collections={group.collections} search={search} kind={kind} filtered={filtered}/>}
  </details>)
})
