import { useEffect, useState, type ReactNode } from 'react'
import type { ApplicationMenuItem, TitleBarAppearance } from '../shared/application-menu'
import type { DesktopApi } from '../shared/contracts'
import { ApplicationMenuBar } from './ApplicationMenuBar'
import { DbCommanderMark } from './DbCommanderMark'
import './titlebar.css'

export function TitleBar({ api, appearance, children }: { api: DesktopApi; appearance: TitleBarAppearance; children: ReactNode }) {
  const [menus, setMenus] = useState<ApplicationMenuItem[] | null>(null)
  useEffect(() => { let cancelled = false; void api.applicationMenu().then(value => { if (!cancelled) setMenus(value) }).catch(console.error); return () => { cancelled = true } }, [api])
  useEffect(() => {
    if (menus === null) return
    const sync = () => { void api.updateTitleBar(appearance).catch(console.error) }
    sync(); window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [api, appearance, menus])
  const mark = <span className="brand-mark"><DbCommanderMark /></span>
  return <header className={`titlebar${menus !== null ? ' integrated-titlebar' : ''}`}>
    {mark}
    {menus !== null && <ApplicationMenuBar menus={menus} api={api}/>}
    <div className="titlebar-spacer"/>
    {children}
  </header>
}
