import { ModalDialog } from './ModalDialog'
import { useState } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { backupCapabilities, type BackupJob, type BackupRequest } from '../shared/backup'
import { engineNames, type SessionInfo } from '../shared/contracts'

export function BackupDialog({ session, jobs, blocked, onClose }: { session: SessionInfo | null; jobs: BackupJob[]; blocked: boolean; onClose(): void }) {
  const [action, setAction] = useState<'backup' | 'restore'>('backup')
  const [artifact, setArtifact] = useState(''), [target, setTarget] = useState('')
  const [directory, setDirectory] = useState('DATA_PUMP_DIR'), [sourceSchema, setSourceSchema] = useState(session?.user.toUpperCase() ?? '')
  const [toolDirectory, setToolDirectory] = useState(''), [content, setContent] = useState<'all' | 'schema'>('all')
  const [review, setReview] = useState<BackupRequest | null>(null), [trusted, setTrusted] = useState(false)
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState(''), [starting, setStarting] = useState(false)
  const [savingHistory, setSavingHistory] = useState(false)
  const capability = session ? backupCapabilities[session.engine] : null
  const job = jobs.find(job => job.id === selected)
  const embedded = session && ['sqlite', 'duckdb'].includes(session.engine)
  async function choose(forTarget = false) {
    try { const file = await window.dbCommander.chooseBackupFile({ sessionId: session!.id, save: forTarget || action === 'backup' }); if (file) (forTarget ? setTarget : setArtifact)(file) }
    catch (error) { setError((error as Error).message) }
  }
  async function start() {
    if (!review) return
    setStarting(true); setError('')
    try { const job = await window.dbCommander.startBackup(review); setSelected(job.id); setReview(null) }
    catch (error) { setError((error as Error).message) }
    finally { setStarting(false) }
  }
  return <ModalDialog className="connection-dialog backup-dialog" aria-label="Database backup and restore" onDismiss={onClose}>
    <div className="dialog-heading"><div><h2>Database backup and restore</h2><p>{job ? `${engineNames[job.engine]} · ${job.server ?? 'Previous server'} · ${job.database}` : session ? `${engineNames[session.engine]} · ${session.host} · ${session.database || 'Server connection'}` : 'Connect a database to start a job.'}</p></div><button aria-label="Close backup dialog" onClick={onClose}><X size={18} /></button></div>
    {error && <p role="alert" className="backup-error">{error}</p>}
    {job ? <div className="backup-job-detail">
      <h3>{job.action === 'backup' ? 'Backup' : 'Restore'} · {job.database}</h3>
      <p className="backup-status" role="status">{job.status}</p><p>{job.phase}</p>
      {job.historyError && <><p role="alert" className="backup-error">{job.historyError}</p><button disabled={savingHistory} onClick={async () => {
        setSavingHistory(true)
        try { await window.dbCommander.retryBackupHistory() } catch (error) { setError((error as Error).message) }
        finally { setSavingHistory(false) }
      }}>{savingHistory ? 'Saving job history…' : 'Retry saving job history'}</button></>}
      <p className="backup-path">{job.artifact}{job.target && <> → {job.target}</>}</p>
      {job.status === 'running' && <button disabled={job.cancellationRequested} onClick={() => void window.dbCommander.cancelBackup(job.id).catch(error => setError(error.message))}>{job.cancellationRequested ? 'Cancellation requested' : 'Cancel job'}</button>}
      <details><summary>Job diagnostics</summary><pre>{job.log.join('\n\n')}</pre></details>
      <button onClick={() => { setSelected(null); setTrusted(false) }}>Configure another job</button>
    </div> : session && capability && <>
      <p className="backup-description">{capability.description}</p>
      {review ? <div className="backup-review">
        <h3>Review {review.action}</h3><dl><dt>Format</dt><dd>{capability.format}</dd><dt>Server / source</dt><dd>{session.host}:{session.port} / {session.database}</dd><dt>{review.action === 'backup' ? 'Destination' : 'Backup source'}</dt><dd>{review.artifact}</dd>{review.target && <><dt>New restore target</dt><dd>{review.target}</dd></>}{session.engine === 'oracle' && <><dt>Server directory / schema</dt><dd>{review.directory} / {review.sourceSchema}</dd></>}<dt>Contents</dt><dd>{review.content === 'schema' ? 'Schema only' : 'Schema and data'}</dd></dl>
        <p>{review.action === 'restore' ? 'Creates a new target. Existing targets are refused. A failed restore can leave partial objects; inspect the target before trying again. Backup code runs with your database privileges.' : 'The artifact contains sensitive database content. Store it securely and test a restore before relying on it.'}</p>
        <label className="save-profile-option"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} />{session.engine === 'azure-sql' ? 'I understand this creates a billed Azure database copy.' : review.action === 'restore' ? 'I trust this backup and have reviewed the new target.' : 'I have reviewed the destination and backup scope.'}</label>
        <div className="dialog-actions"><button disabled={starting} onClick={() => setReview(null)}>Back</button><button className="primary-button" disabled={!trusted || blocked || starting} onClick={() => void start()}>{starting ? 'Starting…' : `Start ${review.action}`}</button></div>
      </div> : <form onSubmit={event => { event.preventDefault(); setError(''); setTrusted(false); setReview({ sessionId: session.id, action, artifact: artifact.trim(), ...(action === 'restore' ? { target: target.trim() } : {}), ...(toolDirectory.trim() ? { toolDirectory: toolDirectory.trim() } : {}), ...(session.engine === 'oracle' ? { directory, sourceSchema } : {}), content: action === 'restore' ? 'all' : content, confirmed: true }) }}>
        <label>Operation<select value={action} onChange={event => { setAction(event.target.value as 'backup' | 'restore'); setContent('all') }}><option value="backup">Back up database</option><option value="restore">Restore to a new target</option></select></label>
        <label>{capability.location === 'cloud' ? 'Recovery copy database name' : capability.location === 'directory' ? 'Dump filename' : capability.location === 'server' ? 'Backup file on database server' : 'Backup file'}<input required value={artifact} onChange={event => setArtifact(event.target.value)} placeholder={capability.location === 'local' ? `Absolute path to .${capability.extension} file` : capability.location === 'server' ? '/var/opt/mssql/backup/database.bak' : capability.location === 'directory' ? 'database.dmp' : 'database_recovery'} /></label>
        {capability.location === 'local' && <button type="button" onClick={() => void choose()}><FolderOpen size={14} />{action === 'backup' ? 'Choose backup destination' : 'Browse backup files'}</button>}
        {session.engine === 'oracle' && <div className="form-row"><label>Oracle DIRECTORY<input required value={directory} onChange={event => setDirectory(event.target.value)} /></label><label>Source schema<input required value={sourceSchema} onChange={event => setSourceSchema(event.target.value)} /></label></div>}
        {action === 'restore' && <><label>{embedded ? 'New database file' : session.engine === 'oracle' ? 'New schema name (case sensitive)' : 'New database name'}<input required value={target} onChange={event => setTarget(event.target.value)} /></label>{embedded && <button type="button" onClick={() => void choose(true)}><FolderOpen size={14} />Choose restore destination</button>}</>}
        {action === 'backup' && capability.schemaOnly && <label>Backup contents<select value={content} onChange={event => setContent(event.target.value as 'all' | 'schema')}><option value="all">Schema and data</option><option value="schema">Schema only</option></select></label>}
        {['postgres', 'mysql', 'mariadb'].includes(session.engine) && <label>Native tools directory (optional)<input value={toolDirectory} onChange={event => setToolDirectory(event.target.value)} placeholder="Leave blank to search PATH" /></label>}
        {blocked && <p>Finish this tab’s query, transaction or database operation and apply or discard staged edits first.</p>}
        <div className="dialog-actions"><button type="submit" className="primary-button" disabled={blocked}>Review job</button></div>
      </form>}
    </>}
    {!!jobs.length && <div className="backup-job-list"><h3>Recent jobs</h3>{[...jobs].reverse().map(item => <button key={item.id} title={`${item.server ?? 'Previous server'} · ${item.target ?? item.artifact}`} onClick={() => setSelected(item.id)}><span>{item.action} · {item.database}</span><span>{item.status}</span></button>)}</div>}
  </ModalDialog>
}
