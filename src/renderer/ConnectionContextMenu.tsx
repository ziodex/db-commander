import { useState, type ReactNode } from 'react'
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'

export function ConnectionContextMenu({ name, className, items, children }: {
  name: string; className?: string; items: MenuItem[]; children: ReactNode
}) {
  const [anchor, setAnchor] = useState<Omit<MenuAnchor, 'items'> | null>(null)
  return <div className={className} onContextMenu={event => {
    event.preventDefault(); event.stopPropagation()
    const owner = event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (owner) setAnchor({ owner, x: event.clientX, y: event.clientY })
  }} onKeyDown={event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault(); event.stopPropagation()
    const owner = event.target as HTMLElement, rect = owner.getBoundingClientRect()
    setAnchor({ owner, x: rect.left, y: rect.bottom })
  }}>
    {children}
    {anchor && <ContextMenu label={`Connection actions for ${name}`} anchor={{ ...anchor, items }} onClose={() => setAnchor(null)}/>}
  </div>
}
