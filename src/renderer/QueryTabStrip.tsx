import { useEffect, useRef, useState } from 'react'
import { Pin, X } from './WorkbenchIcons'
import { MaterialIcon } from './MaterialIcon'
import type { WorkspaceTab } from '../shared/contracts'
import type { QueryTabState } from './query-tabs'
import { ContextMenu, type MenuAnchor } from './ContextMenu'
import { dropIndex, tabMoveBounds, tabMoveIndex } from '../shared/tab-order'

export function QueryTabStrip({ tabs, activeId, states, disabled, closeDisabled, dirty, path, onSelect, onMove, onPin, onClose, onSplit, splitDisabled }: {
  tabs: WorkspaceTab[]; activeId: string; states: Record<string, QueryTabState>; disabled: boolean; closeDisabled: boolean
  dirty(tab: WorkspaceTab): boolean; path(id: string): string | undefined
  onSelect(id: string): void; onMove(id: string, index: number): void; onPin(id: string, pinned: boolean): void; onClose(id: string): void
  onSplit(id: string, orientation: 'vertical' | 'horizontal'): void; splitDisabled: boolean
}) {
  const drag = useRef<string | null>(null)
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null)
  const [menu, setMenu] = useState<(Omit<MenuAnchor, 'items'> & { id: string }) | null>(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => { document.getElementById(`tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [activeId])
  function clearDrag() { drag.current = null; setOver(null) }
  useEffect(() => { if (disabled) clearDrag() }, [disabled])
  function move(id: string, destination: number) {
    const source = tabs.findIndex(tab => tab.id === id), index = tabMoveIndex(tabs, id, destination)
    if (disabled || source < 0 || index < 0 || source === index) return
    const previousFocus = document.activeElement
    onMove(id, index)
    setAnnouncement(`${tabs[source].title} moved to position ${index + 1} of ${tabs.length}.`)
    requestAnimationFrame(() => {
      // A later click or keyboard action takes precedence over focus recovery.
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) return
      const button = document.getElementById(`tab-${id}`); button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  const index = menu ? tabs.findIndex(tab => tab.id === menu.id) : -1
  const bounds = menu ? tabMoveBounds(tabs, menu.id) : undefined
  const menuItems = menu && bounds ? [
    { label: tabs[index].pinned ? 'Unpin tab' : 'Pin tab', disabled, action: () => {
      onPin(menu.id, !tabs[index].pinned)
      setAnnouncement(`${tabs[index].title} ${tabs[index].pinned ? 'unpinned' : 'pinned. Unpin before closing'}.`)
    } },
    { label: 'Move tab left', disabled: disabled || index <= bounds.first, action: () => move(menu.id, index - 1) },
    { label: 'Move tab right', disabled: disabled || index >= bounds.last, action: () => move(menu.id, index + 1) },
    { label: 'Move tab to start', disabled: disabled || index <= bounds.first, action: () => move(menu.id, bounds.first) },
    { label: 'Move tab to end', disabled: disabled || index >= bounds.last, action: () => move(menu.id, bounds.last) },
    { label: 'Split editor side by side', disabled: disabled || splitDisabled, action: () => onSplit(menu.id, 'vertical') },
    { label: 'Split editor stacked', disabled: disabled || splitDisabled, action: () => onSplit(menu.id, 'horizontal') }
  ] : []
  return <>
    <div className="query-tab-list" role="tablist" aria-label="Query tabs" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null) }}>
      {tabs.map((item, tabIndex) => {
        const runtime = states[item.id], activity = runtime?.transferBusy ? 'Data transfer' : runtime?.backupBusy ? 'Backup / restore' : runtime?.switching ? 'Switching database' : runtime?.gridBusy ? 'Editing data' : runtime?.gridChanges.length ? `${runtime.gridChanges.length} staged` : runtime?.running ? 'Running' : runtime?.connecting ? 'Connecting' : runtime?.session?.transaction === 'failed' ? 'Transaction failed' : runtime?.session?.transaction === 'transaction' ? 'In transaction' : runtime?.session?.transaction === 'unknown' ? 'State unknown' : ''
        return <div key={item.id} className={`editor-tab ${item.id === activeId ? 'selected' : ''} ${item.pinned ? 'pinned' : ''} ${item.pinned && tabs[tabIndex + 1] && !tabs[tabIndex + 1].pinned ? 'pinned-end' : ''} ${over?.id === item.id ? over.after ? 'drop-after' : 'drop-before' : ''}`}
          onDragOver={event => {
            if (disabled || !drag.current) return
            if (dropIndex(tabs, drag.current, item.id, false) < 0) { setOver(null); event.dataTransfer.dropEffect = 'none'; return }
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'
            const bounds = event.currentTarget.getBoundingClientRect(), after = event.clientX >= bounds.left + bounds.width / 2
            setOver({ id: item.id, after })
            const list = event.currentTarget.parentElement!, viewport = list.getBoundingClientRect()
            if (event.clientX < viewport.left + 32) list.scrollLeft -= 24
            else if (event.clientX > viewport.right - 32) list.scrollLeft += 24
          }}
          onDrop={event => {
            if (disabled || !drag.current) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect(), source = drag.current
            const destination = dropIndex(tabs, source, item.id, event.clientX >= bounds.left + bounds.width / 2)
            clearDrag(); if (destination >= 0) move(source, destination)
          }}>
          <button role="tab" id={`tab-${item.id}`} aria-controls="query-panel" aria-selected={item.id === activeId} aria-label={item.title}
            aria-description={[item.pinned ? 'Pinned. Unpin from the tab menu or Commands before closing.' : '', dirty(item) ? 'Unsaved SQL changes.' : '', activity ? `${activity}.` : '', `Connection: ${runtime?.session?.name ?? item.profile.name}.`, 'Use the tab menu to reorder or split.'].filter(Boolean).join(' ')}
            title={`${path(item.id) ?? item.title}\n${item.pinned ? 'Pinned. Unpin before closing.\n' : ''}Drag to reorder within this group, or use Ctrl/Cmd+Shift+Left/Right while the tab is focused.`} tabIndex={item.id === activeId ? 0 : -1}
            draggable={!disabled && tabs.length > 1} onDragStart={event => { if (disabled) { event.preventDefault(); return }; drag.current = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dbcommander-tab', item.id); setMenu(null) }} onDragEnd={clearDrag}
            onClick={() => onSelect(item.id)} onContextMenu={event => { event.preventDefault(); setMenu({ id: item.id, owner: event.currentTarget, x: event.clientX, y: event.clientY }) }}
            onKeyDown={event => {
              if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
                event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ id: item.id, owner: event.currentTarget, x: bounds.left, y: bounds.bottom }); return
              }
              if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation(); move(item.id, event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : tabIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return
              }
              if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                event.preventDefault(); const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabIndex + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]
                onSelect(next.id); document.getElementById(`tab-${next.id}`)?.focus()
              }
            }}>
            {item.pinned ? <Pin className="tab-pin" size={14} aria-hidden="true"/> : <MaterialIcon name="database"/>}{dirty(item) && <span className="sql-dirty" aria-label="Unsaved SQL changes" title="Unsaved SQL changes">●</span>}<span>{item.title}<small>{runtime?.session?.name ?? item.profile.name}</small></span>{activity && <span className={`tab-activity ${runtime?.running ? 'running' : ''}`} title={activity}>{activity}</span>}
          </button>{!item.pinned && <button className="close-tab" aria-label={`Close ${item.title}`} disabled={closeDisabled || disabled} onClick={() => onClose(item.id)}><X size={12}/></button>}
        </div>
      })}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {menu && index >= 0 && <ContextMenu label="Query tab actions" anchor={{ ...menu, items: menuItems }} onClose={() => setMenu(null)}/>}
  </>
}
