import { useEffect, useRef, useState } from 'react'
import { ModalDialog } from './ModalDialog'
import { X } from './WorkbenchIcons'
import { backupCapabilities, backupRequestSchema, type BackupInspection, type BackupJob, type BackupRequest } from '../shared/backup'
import { engineNames, type SessionInfo } from '../shared/contracts'
import { BackupSetup, type BackupDraft } from './BackupSetup'
import { BackupChecks } from './BackupChecks'
import { BackupJobDetails } from './BackupJobDetails'

export function BackupDialog({ session, jobs, blocked, onClose, onConnect, canConnect }: {
  session: SessionInfo | null; jobs: BackupJob[]; blocked: boolean; onClose(): void; onConnect?(job: BackupJob): void; canConnect?(job: BackupJob): boolean
}) {
  const [draft, setDraft] = useState<BackupDraft>({ action: 'backup', artifact: '', target: '', directory: 'DATA_PUMP_DIR', sourceSchema: session?.user.toUpperCase() ?? '', toolDirectory: '', content: 'all' })
  const [review, setReview] = useState<BackupRequest | null>(null), [inspection, setInspection] = useState<BackupInspection | null>(null)
  const [trusted, setTrusted] = useState(false), [checking, setChecking] = useState(false), [starting, setStarting] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState(''), [filter, setFilter] = useState(''), [status, setStatus] = useState('all')
  const epoch = useRef(0), reviewHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => { epoch.current++ }, [])
  useEffect(() => { if (review) reviewHeading.current?.focus() }, [review])
  const capability = session ? backupCapabilities[session.engine] : null, job = jobs.find(job => job.id === selected)
  const source = session ? ['sqlite', 'duckdb'].includes(session.engine) ? session.host : `${session.host}${session.port ? `:${session.port}` : ''} / ${session.database || 'Server connection'}` : ''
  function report(error: unknown) { setError(error instanceof Error ? error.message : 'The operation could not finish.') }
  function change(patch: Partial<BackupDraft>) { epoch.current++; setDraft(previous => ({ ...previous, ...patch })); setInspection(null); setReview(null); setTrusted(false); setError('') }
  async function choose(purpose: 'artifact' | 'target' | 'tools') {
    if (choosing || checking || starting) return
    const token = epoch.current
    setChoosing(true)
    try {
      const value = purpose === 'tools' ? await window.dbCommander.chooseBackupTools(session!.id) : await window.dbCommander.chooseBackupFile({ sessionId: session!.id, save: purpose === 'target' || draft.action === 'backup', target: purpose === 'target' })
      if (value && token === epoch.current) change({ [purpose === 'tools' ? 'toolDirectory' : purpose]: value })
    } catch (error) { report(error) }
    finally { setChoosing(false) }
  }
  async function inspect() {
    if (!session || checking || choosing || blocked) return
    const token = ++epoch.current
    setChecking(true); setError(''); setTrusted(false); setInspection(null)
    try {
      const request = backupRequestSchema.parse({ sessionId: session.id, action: draft.action, artifact: draft.artifact.trim(), ...(draft.action === 'restore' ? { target: draft.target.trim() } : {}), ...(draft.toolDirectory.trim() ? { toolDirectory: draft.toolDirectory.trim() } : {}), ...(session.engine === 'oracle' ? { directory: draft.directory, sourceSchema: draft.sourceSchema } : {}), content: draft.action === 'restore' ? 'all' : draft.content, confirmed: true })
      const checked = await window.dbCommander.inspectBackup(request)
      if (token !== epoch.current) return
      setInspection(checked); if (checked.ready) setReview(request)
    } catch (error) { if (token === epoch.current) report(error) }
    finally { if (token === epoch.current) setChecking(false) }
  }
  async function start() {
    if (!review || !trusted || !inspection?.ready || blocked || starting) return
    setStarting(true); setError('')
    try { const job = await window.dbCommander.startBackup(review); setSelected(job.id); setReview(null); setInspection(null) }
    catch (error) { report(error); setReview(null); setInspection(null); setTrusted(false) }
    finally { setStarting(false) }
  }
  const visibleJobs = [...jobs].reverse().filter(item => (status === 'all' || item.status === status) && `${item.database} ${item.server ?? ''} ${item.artifact} ${item.target ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  return <ModalDialog className="connection-dialog backup-dialog" aria-label="Database backup and restore" onDismiss={onClose}>
    <div className="dialog-heading"><div><h2>{job ? 'Backup and restore job' : draft.action === 'restore' ? 'Restore database' : 'Back up database'}</h2><p>{job ? `${engineNames[job.engine]} · ${job.server ?? 'Previous server'} · ${job.database}` : session ? `${engineNames[session.engine]} · ${source}` : 'Connect a database to configure a new job. Previous jobs remain available below.'}</p></div><button aria-label="Close backup dialog" onClick={onClose}><X size={18} /></button></div>
    {error && <p role="alert" className="backup-error">{error}</p>}
    {job ? <BackupJobDetails key={job.id} job={job} canConnect={Boolean(canConnect?.(job))} onConnect={job => onConnect?.(job)} onConfigure={() => { setSelected(null); setTrusted(false); setInspection(null); setReview(null) }} onError={report} /> : session && capability && <>
      <ol className="backup-steps" aria-label="Backup workflow"><li aria-current={!review ? 'step' : undefined}>Configure</li><li aria-current={review ? 'step' : undefined}>Check and review</li><li>Run and verify</li></ol>
      <p className="backup-description">{capability.description}</p>
      {inspection && <BackupChecks inspection={inspection} />}
      {review ? <div className="backup-review">
        <h3 ref={reviewHeading} tabIndex={-1}>Review {review.action}</h3>
        <dl><div><dt>Format</dt><dd>{capability.format}</dd></div><div><dt>Server / source</dt><dd>{source}</dd></div><div><dt>{review.action === 'backup' ? 'Destination' : 'Backup source'}</dt><dd>{review.artifact}</dd></div>{review.target && <div><dt>New restore target</dt><dd>{review.target}</dd></div>}{session.engine === 'oracle' && <div><dt>Server directory / schema</dt><dd>{review.directory} / {review.sourceSchema}</dd></div>}<div><dt>Contents</dt><dd>{review.action === 'restore' ? 'Contents of the selected backup; no scope conversion' : review.content === 'schema' ? 'Schema only' : 'Schema and data'}</dd></div></dl>
        <p>{review.action === 'restore' ? 'Creates a new target. Existing targets are refused. A failed restore can leave partial objects; inspect the target before trying again. Backup code runs with your database privileges.' : 'The artifact contains sensitive database content. Store it securely and test a restore before relying on it.'}</p>
        <label className="save-profile-option"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} />{session.engine === 'azure-sql' ? 'I understand this creates a billed Azure database copy.' : review.action === 'restore' ? 'I trust this backup and have reviewed the new target.' : 'I have reviewed the destination and backup scope.'}</label>
        <div className="dialog-actions backup-actions"><button disabled={starting} onClick={() => { setReview(null); setInspection(null); setTrusted(false) }}>Back</button><button className="primary-button" disabled={!trusted || blocked || starting} onClick={() => void start()}>{starting ? 'Starting…' : `Start ${review.action}`}</button></div>
      </div> : <BackupSetup session={session} draft={draft} busy={checking || choosing} busyLabel={choosing ? 'Opening file chooser…' : 'Checking requirements…'} blocked={blocked} change={change} choose={choose} submit={() => void inspect()} />}
    </>}
    {!!jobs.length && <section className="backup-job-list" aria-label="Backup job history"><h3>Recent jobs</h3><div className="form-row"><label>Find a job<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Database, server or location" /></label><label>Job status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{['running','completed','failed','cancelled','unknown'].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>{visibleJobs.map(item => <button key={item.id} title={`${item.server ?? 'Previous server'} · ${item.target ?? item.artifact}`} disabled={checking || starting} onClick={() => { setSelected(item.id); setError('') }}><span>{item.action} · {item.database}<small>{new Date(item.startedAt).toLocaleString()}</small></span><span>{item.status}</span></button>)}{!visibleJobs.length && <p>No jobs match these filters.</p>}</section>}
  </ModalDialog>
}
