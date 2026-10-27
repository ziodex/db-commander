import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
export interface MenuItem { label: string; action(): void; disabled?: boolean; title?: string; group?: string }
export interface MenuAnchor { x: number; y: number; owner: HTMLElement; items: MenuItem[] }
export function ContextMenu({ anchor, onClose, label = 'Explorer actions', ownerIsTrigger = false }: { anchor: MenuAnchor; onClose(): void; label?: string; ownerIsTrigger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const dismissMenu = useEffectEvent(onClose)
  useLayoutEffect(() => {
    const menu = ref.current!, bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4,Math.min(anchor.x,innerWidth-bounds.width-4))}px`
    menu.style.top = `${Math.max(4,Math.min(anchor.y,innerHeight-bounds.height-4))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = (event: Event) => { if (!menu.contains(event.target as Node) && !(ownerIsTrigger && anchor.owner.contains(event.target as Node))) dismissMenu() }
    const close = () => dismissMenu()
    document.addEventListener('pointerdown',dismiss,true); window.addEventListener('resize',close); window.addEventListener('blur',close)
    return () => { document.removeEventListener('pointerdown',dismiss,true); window.removeEventListener('resize',close); window.removeEventListener('blur',close) }
  }, [anchor.owner, anchor.x, anchor.y, ownerIsTrigger])
  function close(restore = true) { onClose(); if (restore) anchor.owner.focus() }
  const groups: { label?: string; items: MenuItem[] }[] = []
  for (const item of anchor.items) {
    if (!groups.length || groups.at(-1)!.label !== item.group) groups.push({ label: item.group, items: [] })
    groups.at(-1)!.items.push(item)
  }
  const command = (item: MenuItem) => <button key={item.label} role="menuitem" disabled={item.disabled} title={item.title} onClick={()=>{close();item.action()}}>{item.label}</button>
  return createPortal(<div ref={ref} className="explorer-context-menu" role="menu" aria-label={label} style={{left:anchor.x,top:anchor.y}} onContextMenu={e=>e.preventDefault()} onKeyDown={e=>{
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); return }
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus() }
  }}>{groups.map((group,index)=>group.label ? <div key={index} role="group" aria-label={group.label} className="menu-command-group"><div className="menu-section-label" aria-hidden="true">{group.label}</div>{group.items.map(command)}</div> : group.items.map(command))}</div>,document.body)
}
