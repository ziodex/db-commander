import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ApplicationMenuItem } from '../shared/application-menu'
import type { DesktopApi } from '../shared/contracts'
import { Check, ChevronRight } from './WorkbenchIcons'

function MenuPopup({ items, label, owner, nested = false, depth = 0, onClose, onChoose, onSwitch, onOpenSubmenu, onBack }: {
  items: ApplicationMenuItem[]; label: string; owner: HTMLElement; nested?: boolean
  depth?: number; onOpenSubmenu?(item: ApplicationMenuItem): void; onBack?(): void
  onClose(restore?: boolean): void; onChoose(item: ApplicationMenuItem): void; onSwitch(direction: number): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [child, setChild] = useState<{ item: ApplicationMenuItem; owner: HTMLButtonElement } | null>(null)
  const search = useRef({ text: '', time: 0 })
  useLayoutEffect(() => {
    const menu = ref.current!, anchor = owner.getBoundingClientRect(), bounds = menu.getBoundingClientRect()
    const x = nested ? anchor.right + bounds.width > innerWidth ? anchor.left - bounds.width : anchor.right : anchor.left
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - bounds.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(nested ? anchor.top : anchor.bottom, innerHeight - bounds.height - 4))}px`
    menu.querySelector<HTMLButtonElement>('button[data-path]:not(:disabled)')?.focus()
  }, [owner, nested])
  function openSubmenu(item: ApplicationMenuItem, owner: HTMLButtonElement) {
    if (onOpenSubmenu) onOpenSubmenu(item)
    else setChild({ item, owner })
  }
  function keyDown(event: KeyboardEvent) {
    event.stopPropagation()
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); setChild(null)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      const item = items.find(item => item.path === buttons[index]?.dataset.path)
      if (item?.items) openSubmenu(item, buttons[index])
      else onSwitch(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (onBack) onBack()
      else if (nested) onClose(true)
      else onSwitch(-1)
    } else if (event.key === 'Escape') {
      event.preventDefault(); onClose(true)
    } else if (event.key === 'Tab') {
      owner.focus(); onClose(false)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && event.key !== ' ') {
      event.preventDefault()
      const now = Date.now(), text = event.key.toLowerCase()
      search.current = { text: now - search.current.time < 700 && search.current.text !== text ? search.current.text + text : text, time: now }
      const ordered = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
      ordered.find(button => button.dataset.label?.toLowerCase().startsWith(search.current.text))?.focus()
    }
  }
  return createPortal(<div className="application-menu-popup" style={{ zIndex: 1100 + depth }} ref={ref} role="menu" aria-label={label} onKeyDown={keyDown} onContextMenu={event => event.preventDefault()}>
    {onBack && <><button role="menuitem" aria-label="Back to application menu" onClick={onBack}><ChevronRight className="application-menu-back" size={14}/><span>{label}</span></button><div role="separator"/></>}
    {items.map(item => item.type === 'separator' ? <div key={item.path} role="separator" /> : <button key={item.path} data-path={item.path} data-label={item.label}
      role={item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem'} aria-label={item.label}
      aria-keyshortcuts={item.accelerator?.replace(/Ctrl/g, 'Control')}
      aria-checked={item.type === 'checkbox' || item.type === 'radio' ? item.checked : undefined}
      aria-haspopup={item.items ? 'menu' : undefined} aria-expanded={item.items ? child?.item.path === item.path : undefined} disabled={!item.enabled}
      onPointerEnter={event => { if (item.enabled) { event.currentTarget.focus(); if (!onOpenSubmenu) setChild(item.items ? { item, owner: event.currentTarget } : null) } }}
      onClick={event => { if (item.items) openSubmenu(item, event.currentTarget); else onChoose(item) }}>
      <span className="application-menu-check">{item.checked && <Check size={14}/>}</span><span>{item.label}</span>
      {item.accelerator && <span className="application-menu-shortcut">{item.accelerator}</span>}{item.items && <ChevronRight size={14}/>}
    </button>)}
    {child?.item.items && <MenuPopup items={child.item.items} label={child.item.label} owner={child.owner} nested depth={depth + 1}
      onClose={restore => { setChild(null); if (restore) child.owner.focus() }} onChoose={onChoose} onSwitch={onSwitch}/>}
  </div>, document.body)
}

export function ApplicationMenuBar({ menus: initialMenus, api }: { menus: ApplicationMenuItem[]; api: DesktopApi }) {
  const [menus, setMenus] = useState(initialMenus)
  const [active, setActive] = useState<number | 'compact' | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 900px)').matches)
  const nav = useRef<HTMLElement>(null), compactButton = useRef<HTMLButtonElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const previousFocus = useRef<HTMLElement | null>(null)
  const refreshVersion = useRef(0)
  function rememberFocus() {
    const element = document.activeElement as HTMLElement | null
    if (element && !nav.current?.contains(element) && !element.closest('.application-menu-popup')) previousFocus.current = element
  }
  function close(restore = false) {
    refreshVersion.current++; setActive(null)
    if (restore && previousFocus.current?.isConnected) previousFocus.current.focus()
  }
  function open(index: number | 'compact') {
    rememberFocus(); setActive(index)
    if (typeof index === 'number') setFocusIndex(index)
    const version = ++refreshVersion.current
    void api.applicationMenu().then(next => { if (next && version === refreshVersion.current) setMenus(next) }).catch(console.error)
  }
  function switchMenu(direction: number) { open(((typeof active === 'number' ? active : focusIndex) + direction + menus.length) % menus.length) }
  const menuKey = useEffectEvent((index: number | null) => {
    if (index !== null && menus[index]) { open(index); return }
    if (nav.current?.contains(document.activeElement) || active !== null) close(true)
    else { rememberFocus(); (compact ? compactButton.current : buttons.current[focusIndex])?.focus() }
  })
  const dismiss = useEffectEvent((event?: Event) => {
    if (event?.type === 'pointerdown') {
      const target = event.target as HTMLElement
      if (nav.current?.contains(target) || target.closest('.application-menu-popup')) return
    }
    close()
  })
  useEffect(() => api.onApplicationMenuKey(menuKey), [api])
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)')
    const changed = () => { setCompact(media.matches); dismiss() }
    media.addEventListener('change', changed)
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss)
    return () => { media.removeEventListener('change', changed); document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss) }
  }, [])
  const owner = active === 'compact' || compact ? compactButton.current : active === null ? null : buttons.current[active]
  function choose(item: ApplicationMenuItem) {
    close(true)
    void api.executeApplicationMenu(item.path).catch(console.error)
  }
  return <nav ref={nav} className="application-menubar" role="menubar" aria-label="Application menu" onPointerDown={rememberFocus} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true) }
    else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !compact) {
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? menus.length - 1 : (focusIndex + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length
      setFocusIndex(index); buttons.current[index]?.focus()
      if (active !== null) open(index)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(compact ? 'compact' : focusIndex) }
    else if (event.key === 'Tab') close()
  }}>
    {compact ? <button ref={compactButton} role="menuitem" aria-label="Application menu" title="Application menu (Alt)" aria-haspopup="menu" aria-expanded={active !== null}
      onClick={() => active === null ? open('compact') : close(true)}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
      : menus.map((menu, index) => <button key={menu.path} ref={element => { buttons.current[index] = element }} role="menuitem" tabIndex={focusIndex === index ? 0 : -1}
        aria-haspopup="menu" aria-expanded={active === index} disabled={!menu.enabled} onFocus={() => setFocusIndex(index)}
        onPointerEnter={() => { if (active !== null && active !== index) open(index) }} onClick={() => active === index ? close(true) : open(index)}>{menu.label}</button>)}
    {active !== null && owner && <MenuPopup key={String(active)} items={active === 'compact' ? menus : menus[active]?.items ?? []}
      label={active === 'compact' ? 'Application menu' : menus[active].label} owner={owner} onClose={close} onChoose={choose} onSwitch={switchMenu}
      onOpenSubmenu={active === 'compact' ? item => open(menus.findIndex(menu => menu.path === item.path)) : undefined}
      onBack={compact && active !== 'compact' ? () => open('compact') : undefined}/>}
  </nav>
}
