import { useState, type ReactNode } from 'react'
import { ChevronDown } from './WorkbenchIcons'
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'

export function ActionMenu({ label, items, children }: { label: string; items: MenuItem[]; children?: ReactNode }) {
  const [anchor, setAnchor] = useState<Omit<MenuAnchor, 'items'> | null>(null)
  return <>
    <button aria-label={label} title={label} className={children ? 'icon-action' : undefined} aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={event => {
      const owner = event.currentTarget, bounds = owner.getBoundingClientRect()
      setAnchor(previous => previous ? null : { owner, x: bounds.left, y: bounds.bottom })
    }}>{children ?? <>{label}<ChevronDown size={12}/></>}</button>
    {anchor && <ContextMenu label={label} ownerIsTrigger anchor={{ ...anchor, items }} onClose={() => setAnchor(null)}/>}
  </>
}
