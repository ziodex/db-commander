import { useState } from 'react'
import { backupCapabilities, type BackupJob } from '../shared/backup'

export function BackupJobDetails({ job, canConnect, onConnect, onConfigure, onError }: {
  job: BackupJob; canConnect: boolean; onConnect(job: BackupJob): void; onConfigure(): void; onError(error: unknown): void
}) {
  const [saving, setSaving] = useState(false)
  const local = backupCapabilities[job.engine].location === 'local', embedded = ['sqlite', 'duckdb'].includes(job.engine)
  const elapsed = job.finishedAt ? Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)) : undefined
  return <div className="backup-job-detail">
    <h3>{job.action === 'backup' ? 'Backup' : 'Restore'} · {job.database}</h3>
    <p className="backup-status" role="status">{job.status}</p><p>{job.phase}</p>
    <dl><div><dt>Started</dt><dd>{new Date(job.startedAt).toLocaleString()}</dd></div>{elapsed !== undefined && <div><dt>Duration</dt><dd>{elapsed.toLocaleString()} seconds</dd></div>}<div><dt>{local ? 'Local backup file' : 'Server backup location'}</dt><dd>{job.artifact}</dd></div>{job.target && <div><dt>Restore target</dt><dd>{job.target}</dd></div>}</dl>
    {job.status === 'completed' && <p>{job.action === 'backup' ? 'The native backup finished. Test a restore before relying on it; completion is not a guarantee that every application requirement is covered.' : 'The native restore finished. Check the restored schema and data before using it. Connecting below does not run your previous SQL.'}</p>}
    {job.status === 'unknown' && <p className="backup-error">The outcome is unknown. Inspect the artifact and target before starting another job. Nothing is retried automatically.</p>}
    {job.engine === 'oracle' && job.action === 'restore' && job.status === 'completed' && <p>The restored target is a schema-only account. Inspect it through an authorized administrator connection; it cannot sign in as a new database login.</p>}
    {job.historyError && <><p role="alert" className="backup-error">{job.historyError}</p><button disabled={saving} onClick={async () => { setSaving(true); try { await window.dbCommander.retryBackupHistory() } catch (error) { onError(error) } finally { setSaving(false) } }}>{saving ? 'Saving job history…' : 'Retry saving job history'}</button></>}
    <div className="backup-result-actions">
      {job.status === 'running' && <button disabled={job.cancellationRequested} onClick={() => void window.dbCommander.cancelBackup(job.id).catch(onError)}>{job.cancellationRequested ? 'Cancellation requested' : 'Cancel job'}</button>}
      {job.status === 'completed' && local && <button onClick={() => void window.dbCommander.revealBackupFile({ jobId: job.id }).catch(onError)}>Show backup file</button>}
      {job.status === 'completed' && job.action === 'restore' && embedded && <button onClick={() => void window.dbCommander.revealBackupFile({ jobId: job.id, target: true }).catch(onError)}>Show restored file</button>}
      {job.status === 'completed' && job.action === 'restore' && job.engine !== 'oracle' && <button disabled={!canConnect} onClick={() => onConnect(job)}>Connect to restored database</button>}
    </div>
    {job.status === 'completed' && job.action === 'restore' && job.engine !== 'oracle' && !canConnect && <p>Keep the original connection open and a query-tab slot available, or connect to the restored target manually.</p>}
    <details><summary>Job diagnostics</summary><pre>{job.log.join('\n\n')}</pre></details>
    <button onClick={onConfigure}>Configure another job</button>
  </div>
}
