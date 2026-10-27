import { useEffect, useRef, useState } from 'react'
import { Search, X } from './WorkbenchIcons'
import { ModalDialog } from './ModalDialog'

interface WorkspaceCommand {
  label: string
  keywords?: string
  disabled?: boolean
  action(): void
}

export function CommandPalette({ commands, onClose }: { commands: WorkspaceCommand[]; onClose(): void }) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const previous = useRef(document.activeElement as HTMLElement | null)
  const words = query.toLowerCase().trim().split(/\s+/)
  const matches = commands.filter(command => words.every(word => `${command.label} ${command.keywords ?? ''}`.toLowerCase().includes(word)))
  useEffect(() => { input.current?.focus() }, [])
  function execute(command: WorkspaceCommand) {
    if (!command.disabled) {
      // A newly opened dialog must capture the original trigger, not a command
      // input that is about to be removed.
      input.current?.closest('dialog')?.close()
      previous.current?.focus(); onClose(); command.action()
    }
  }
  return <ModalDialog className="command-palette" aria-label="Commands" onDismiss={onClose} onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }} onKeyDown={event => {
      if (event.key === 'Escape' || (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.command-results button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        buttons[index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } else if (event.key === 'Enter' && event.target === input.current) {
        event.preventDefault(); const first = matches.find(command => !command.disabled); if (first) execute(first)
      }
    }}>
      <div className="command-search"><Search size={16}/><input ref={input} aria-label="Search commands" placeholder="Search commands…" value={query} onChange={event => setQuery(event.target.value)}/><button aria-label="Close commands" onClick={onClose}><X size={16}/></button></div>
      <div className="command-results">{matches.map(command => <button key={command.label} disabled={command.disabled} onClick={() => execute(command)}>{command.label}</button>)}</div>
      <p className="command-count" role="status">{matches.length ? `${matches.length} commands · ↑ ↓ to navigate · Enter to select` : 'No matching commands.'}</p>
  </ModalDialog>
}
