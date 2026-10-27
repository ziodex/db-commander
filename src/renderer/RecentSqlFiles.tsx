import { useEffect, useRef } from 'react'
import type { RecentSqlFile } from '../shared/sql-files'

export function RecentSqlFiles({ files, error, busy, onOpen, onClear, onClose }: {
  files: RecentSqlFile[]; error: string; busy: boolean; onOpen(id: string): void; onClear(): void; onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { previous?.focus() }
  }, [])
  return <div className="modal-backdrop"><div ref={ref} className="confirmation-dialog recent-sql-files" role="dialog" aria-modal="true" aria-label="Recent SQL files" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
    if (event.key === 'Tab') {
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
  }}><h2>Recent SQL files</h2>{error && <p role="alert">{error}</p>}{files.length ? <ul>{files.map(file => <li key={file.id}><button disabled={busy} onClick={() => onOpen(file.id)} title={file.path}><strong>{file.name}</strong><span>{file.path}</span></button></li>)}</ul> : <p>No recent SQL files.</p>}<div className="dialog-actions"><button disabled={busy || !files.length} onClick={onClear}>Clear recent files</button><button disabled={busy} onClick={onClose}>Close</button></div></div></div>
}
