import { useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG_PAGE_SIZE, objectKey, objectKinds, type CatalogObject, type CatalogPage, type CatalogPageRequest } from '../shared/catalog'
import { tabOperationBusy, type QueryTabState } from './query-tabs'
import { useCatalogPage, type ReadCatalog } from './use-catalog-page'
import { ExplorerCatalogActions, ExplorerCatalogTree } from './ExplorerCatalogTree'
import { explorerTree } from './explorer-tree'
import { Search } from './WorkbenchIcons'
import type { GridTable } from '../shared/contracts'
import type { KeyboardEvent, MouseEvent } from 'react'

type Cursor = CatalogPageRequest['cursor']
function Paging({ page, disabled, onPage, label = 'catalog', emptyLabel = 'Loading…' }: { page?: CatalogPage; disabled: boolean; onPage(cursor: Cursor): void; label?: string; emptyLabel?: string }) {
  const previous = useRef<HTMLButtonElement>(null), next = useRef<HTMLButtonElement>(null), pendingFocus = useRef<'previous' | 'next' | undefined>(undefined)
  useEffect(() => {
    if (!page || disabled || !pendingFocus.current) return
    const preferred = pendingFocus.current === 'previous' ? previous.current : next.current
    const alternative = pendingFocus.current === 'previous' ? next.current : previous.current
    pendingFocus.current = undefined
    if (document.activeElement === document.body || document.activeElement === previous.current || document.activeElement === next.current) {
      const target = preferred?.disabled ? alternative : preferred
      if (target && !target.disabled) target.focus()
    }
  }, [page, disabled])
  return <nav className="catalog-paging" aria-label={`${label} pages`}>
    <button ref={previous} disabled={disabled || !page?.previous} onClick={() => { pendingFocus.current = 'previous'; onPage({ object: page!.previous!, direction: 'before' }) }} aria-label={`Previous ${label} page`}>Previous</button>
    <span>{page ? `${page.objects.length} on this page` : emptyLabel}</span>
    <button ref={next} disabled={disabled || !page?.next} onClick={() => { pendingFocus.current = 'next'; onPage({ object: page!.next!, direction: 'after' }) }} aria-label={`Next ${label} page`}>Next</button>
  </nav>
}
function Children({ parent, sessionId, revision, blocked, busy, read }: { parent: CatalogObject; sessionId: string; revision?: string; blocked: boolean; busy: boolean; read: ReadCatalog }) {
  const [cursor, setCursor] = useState<Cursor>()
  const request = useMemo(() => ({ sessionId, parent, search: '', rootsOnly: false, cursor }), [sessionId, parent, cursor])
  const { page, error, loading, retry } = useCatalogPage(request, revision, blocked, read, busy && !blocked)
  const groups = useMemo(() => explorerTree([...(page?.parents ?? []), ...(page?.objects ?? [])], []), [page])
  return <>
    {loading && <p className="sidebar-description" role="status">Loading table objects…</p>}
    {error && <p className="sidebar-description" role="alert">{error} <button disabled={busy} onClick={retry}>Retry table objects</button></p>}
    {page && <>
      <ExplorerCatalogTree groups={groups} search="" kind="all" filtered={false} expanded={new Set()} collapsedMatches={new Set()} onToggle={() => {}} onContext={() => {}}/>
      {!page.objects.length && <p className="sidebar-description">No visible indexes, keys or triggers for this table.</p>}
    </>}
    {(loading || page?.next || page?.previous) && <Paging page={page} disabled={busy || loading} onPage={setCursor} label={`children of ${parent.name}`}/>}
  </>
}
export function CatalogBrowser({ state, read, onFilter, onInspect, onContext }: {
  state: QueryTabState; read: ReadCatalog; onFilter(value: string): void; onInspect(object: CatalogObject): void
  onContext(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, table: GridTable, objectId?: string, object?: CatalogObject): void
}) {
  const [kind, setKind] = useState('all'), [position, setPosition] = useState<{ scope: string; cursor: Cursor }>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedMatches, setCollapsedMatches] = useState<Set<string>>(new Set())
  const scope = JSON.stringify([state.session!.id, state.session!.database, state.tableSearch.trim(), kind, state.schema?.fetchedAt])
  const cursor = position?.scope === scope ? position.cursor : undefined
  const request = useMemo(() => ({ sessionId: state.session!.id, search: state.tableSearch.trim(), kind: kind === 'all' ? undefined : kind as CatalogObject['kind'], rootsOnly: !state.tableSearch.trim() && kind === 'all', cursor }), [state.session, state.tableSearch, kind, cursor])
  const busy = tabOperationBusy(state), blocked = tabOperationBusy({ ...state, catalogLoading: false })
  const { page, error, loading, retry } = useCatalogPage(request, state.schema?.fetchedAt, blocked, read, Boolean(state.catalogLoading))
  const groups = useMemo(() => explorerTree([...(page?.parents ?? []), ...(page?.objects ?? [])], []), [page])
  function toggle(key: string) {
    if (busy) return
    if ((request.search || kind !== 'all') && groups.some(g => g.relations.some(r => r.key === key && r.collections.length))) {
      const visible = new Set(groups.flatMap(group => group.relations.map(relation => relation.key)))
      setCollapsedMatches(previous => { const next = new Set([...previous].filter(value => visible.has(value))); if (next.has(key)) next.delete(key); else next.add(key); return next })
      return
    }
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else { next.clear(); next.add(key) }
      return next
    })
  }
  return <>
    <label className="schema-search"><Search size={13}/><input aria-label="Filter database objects" placeholder="Search all objects…" maxLength={256} value={state.tableSearch} onChange={event => { onFilter(event.target.value); setExpanded(new Set()); setCollapsedMatches(new Set()) }}/></label>
    <label className="object-kind-filter">Object kind<select aria-label="Object kind" value={kind} onChange={event => { setKind(event.target.value); setExpanded(new Set()); setCollapsedMatches(new Set()) }}><option value="all">All objects</option>{objectKinds.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <Paging page={page} emptyLabel={error ? 'Unavailable' : blocked ? 'Waiting…' : 'Loading…'} disabled={busy || loading} onPage={next => { setPosition({ scope, cursor: next }); setExpanded(new Set()); setCollapsedMatches(new Set()) }}/>
    <div className="schema-list catalog-results" aria-busy={loading && !blocked}>
      {state.schemaError && <p className="sidebar-description" role="alert">Completion preview unavailable: {state.schemaError} Use Refresh schema to retry.</p>}
      {loading && <p className="sidebar-description" role="status">{blocked ? 'Catalog will load when the connection is idle.' : 'Loading catalog…'}</p>}
      {error && <p className="sidebar-description" role="alert">Catalog unavailable: {error} <button disabled={busy} onClick={retry}>Retry catalog</button></p>}
      {page && <>
        <details className="explorer-info"><summary>Catalog details</summary><p>Search covers all visible database metadata. Objects load in pages of {CATALOG_PAGE_SIZE}; expand a table to load its indexes, keys and triggers.</p><p>{page.notice}</p><p>Pages are live metadata reads, not a consistent schema snapshot. Refresh after concurrent schema changes. Completion and other tools retain their own documented preview limits. Opening another table replaces the expanded table details.</p></details>
        <ExplorerCatalogActions value={{ busy, onInspect }}>
          <ExplorerCatalogTree groups={groups} search="" kind="all" filtered={Boolean(request.search) || kind !== 'all'} expanded={expanded} collapsedMatches={collapsedMatches} onToggle={toggle} onContext={(event, table, objectId) => onContext(event, table, objectId, [...(page.parents ?? []), ...page.objects].find(o => objectKey(o) === objectId))}
            renderChildren={object => <Children key={objectKey(object)} parent={object} sessionId={state.session!.id} revision={state.schema?.fetchedAt} blocked={blocked} busy={busy} read={read}/>}/>
        </ExplorerCatalogActions>
        {!page.objects.length && <p className="sidebar-description">No visible objects match this search. Try another name or object kind.</p>}
      </>}
    </div>
  </>
}
