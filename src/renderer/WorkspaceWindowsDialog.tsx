import { useEffect, useRef, useState } from 'react'
import { MAX_OPEN_WINDOWS, MAX_SAVED_WINDOWS, type WorkspaceWindows } from '../shared/workspace-windows'

export function WorkspaceWindowsDialog({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false)
  const [data, setData] = useState<WorkspaceWindows>(), [name, setName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null
    let alive = true
    element.showModal()
    const refresh = () => { void window.dbCommander.workspaceWindows().then(value => { if (alive) setData(value) }).catch(error => { if (alive) setError(error.message) }) }
    refresh(); window.addEventListener('focus', refresh)
    return () => { alive = false; window.removeEventListener('focus', refresh); element.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  async function operate(id?: string) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      if (id) await window.dbCommander.openWorkspaceWindow(id)
      else await window.dbCommander.createWorkspaceWindow(name.trim())
      onClose()
    } catch (error) { setError((error as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="connection-dialog workspace-windows-dialog" aria-label="Workspace windows" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!pending.current) onClose() }}>
    <div className="dialog-heading"><h2>Workspace windows</h2><button disabled={busy} aria-label="Close workspace windows" onClick={onClose}>×</button></div>
    <p>Each window keeps its own queries, profiles, settings, history and database sessions. Reopening a saved window restores its editors without connecting.</p>
    {data && <ul className="workspace-window-list">{data.windows.map(item => <li key={item.id}><span>{item.name}{item.id === data.currentId ? ' (this window)' : item.open ? ' (open)' : ''}</span><button disabled={busy || item.id === data.currentId || !item.open && data.windows.filter(item => item.open).length >= MAX_OPEN_WINDOWS} onClick={() => void operate(item.id)}>{item.open ? 'Focus' : 'Open'}</button></li>)}</ul>}
    <form onSubmit={event => { event.preventDefault(); void operate() }}>
      <label>New workspace name<input autoFocus required maxLength={80} value={name} disabled={busy || !data} onChange={event => setName(event.target.value)}/></label>
      <p>Up to {MAX_OPEN_WINDOWS} windows can be open and {MAX_SAVED_WINDOWS} saved. New windows start with an empty workspace. The Primary workspace opens at startup.</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button><button type="submit" className="primary-button" disabled={busy || !data || !name.trim() || data.windows.length >= MAX_SAVED_WINDOWS || data.windows.filter(item => item.open).length >= MAX_OPEN_WINDOWS}>{busy ? 'Opening…' : 'Create window'}</button></div>
    </form>
  </dialog>
}
