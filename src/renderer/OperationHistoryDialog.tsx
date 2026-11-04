import { useEffect, useRef, useState } from 'react'
import { engineNames } from '../shared/database-engines'
import { operationLabels, type OperationEntry, type OperationKind, type OperationStatus } from '../shared/operation-history'
import { X } from './WorkbenchIcons'
import { ModalDialog } from './ModalDialog'

const statuses = {
  running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  unknown: 'Outcome unknown', 'not-applied': 'Not applied', requested: 'Request accepted',
  partial: 'Partially applied', issues: 'Completed with issues'
} satisfies Record<OperationStatus, string>
const pageSize = 15

function useOperationHistory() {
  const [entries, setEntries] = useState<OperationEntry[]>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false, pending = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined
    function refresh() {
      if (disposed || pending || timer) return
      timer = setTimeout(() => {
        timer = undefined
        pending = true
        dirty = false
        void window.dbCommander.operationHistory().then(rows => {
          if (!disposed) { setEntries(rows); setError(false) }
        }, () => { if (!disposed) { setEntries(undefined); setError(true) } }).finally(() => {
          pending = false
          if (dirty) refresh()
        })
      }, 80)
    }
    const unsubscribe = window.dbCommander.onOperationHistoryChanged(() => { dirty = true; refresh() })
    refresh()
    return () => { disposed = true; clearTimeout(timer); unsubscribe() }
  }, [attempt])
  return { entries, error, retry: () => { setError(false); setAttempt(value => value + 1) } }
}

export function OperationHistoryDialog({ onClose, onBackup }: { onClose(): void; onBackup(id: string): void }) {
  const { entries, error, retry } = useOperationHistory()
  const close = useRef<HTMLButtonElement>(null)
  const [kind, setKind] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(0)
  const visible = (entries ?? []).filter(entry => (!kind || kind === entry.kind) && (!status || status === entry.status))
  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, pages - 1)
  return <ModalDialog className="connection-dialog activity-dialog operation-history" aria-labelledby="operation-history-title" onDismiss={onClose}>
    <div className="dialog-heading">
      <div><h2 id="operation-history-title">Operation history</h2><p>This workspace window</p></div>
      <button ref={close} autoFocus aria-label="Close operation history" onClick={onClose}><X size={16}/></button>
    </div>
    <div className="activity-controls operation-filters">
      <label>Operation<select value={kind} onChange={event => { setKind(event.target.value); setPage(0) }}>
        <option value="">All operations</option>
        {(Object.keys(operationLabels) as OperationKind[]).map(key => <option key={key} value={key}>{operationLabels[key]}</option>)}
      </select></label>
      <label>Outcome<select value={status} onChange={event => { setStatus(event.target.value); setPage(0) }}>
        <option value="">All outcomes</option>
        {(Object.keys(statuses) as OperationStatus[]).map(key => <option key={key} value={key}>{statuses[key]}</option>)}
      </select></label>
    </div>
    {error && <div className="activity-controls">
      <p role="alert">Operation history could not be refreshed.</p>
      <button className="primary-button" onClick={() => { close.current?.focus(); retry() }}>Retry history</button>
    </div>}
    {!error && !entries && <p role="status">Loading operations…</p>}
    {entries && !visible.length && <p>{entries.length ? 'No operations match these filters.' : 'No operations have been recorded in this workspace.'}</p>}
    {!!visible.length && <>
      <div className="activity-table operation-table" tabIndex={0} aria-label="Recent operations">
        <table>
          <thead><tr><th>Operation</th><th>Outcome</th><th>Timing</th><th>Progress</th></tr></thead>
          <tbody>{visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(entry => <tr key={entry.id}>
            <td>{operationLabels[entry.kind]}{entry.engine && <small>{engineNames[entry.engine]}</small>}</td>
            <td>{statuses[entry.status]}
              {entry.status === 'running' && entry.cancellationRequested && <small>Cancellation requested</small>}
              {entry.status === 'unknown' && <small>Verify the outcome before retrying</small>}
              {entry.journalWarning && <small>Backup journal needs attention</small>}
            </td>
            <td>{new Date(entry.startedAt).toLocaleString()}{entry.finishedAt && <small>Ended {new Date(entry.finishedAt).toLocaleString()}</small>}</td>
            <td>
              {entry.rows !== undefined && <span>{entry.rows.toLocaleString()} rows processed</span>}
              {entry.destinationTransaction === 'open' && <small>Destination transaction was open at completion</small>}
              {entry.destinationTransaction === 'unknown' && <small>Destination transaction state was unknown</small>}
              {entry.id.startsWith('backup:') && <button onClick={() => onBackup(entry.id.slice(7))}>Open job details</button>}
              {entry.rows === undefined && !entry.id.startsWith('backup:') && '—'}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      {pages > 1 && <div className="activity-paging">
        <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous operations page</button>
        <span>Page {currentPage + 1} of {pages}</span>
        <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next operations page</button>
      </div>}
    </>}
    <p className="diagnostic-note">Running operations appear first. Recent activity stays in this window. Backup and restore entries come from the existing job history.</p>
    <p className="diagnostic-note">Query entries follow recording settings. Transfer counts can include rows later rolled back.</p>
  </ModalDialog>
}
