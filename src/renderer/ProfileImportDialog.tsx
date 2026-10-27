import { useState } from 'react'
import { MAX_PROFILES, engineNames, type SavedConnectionProfile } from '../shared/contracts'
import { planProfileImport, type ProfileImport } from '../shared/profile-files'
import { ModalDialog } from './ModalDialog'

export function ProfileImportDialog({ preview, existing, busy, onImport, onClose }: {
  preview: ProfileImport; existing: SavedConnectionProfile[]; busy: boolean
  onImport(selected: number[], duplicates: 'skip' | 'copy'): Promise<void>; onClose(): void
}) {
  const [selected, setSelected] = useState(preview.document.profiles.map((_, index) => index)), [duplicates, setDuplicates] = useState<'skip' | 'copy'>('skip'), [error, setError] = useState('')
  const plan = planProfileImport(existing.map(profile => profile.config), preview.document.profiles, selected, duplicates), count = plan.filter(item => !item.skip).length
  const overflow = existing.length + count > MAX_PROFILES
  return <ModalDialog className="connection-dialog profile-import-dialog" aria-label="Import connections" onDismiss={() => { if (!busy) onClose() }}>
    <div className="dialog-heading"><h2>Import connections</h2><button aria-label="Close connection import" disabled={busy} onClick={onClose}>×</button></div>
    <p>{preview.sourceName} · Review {preview.document.profiles.length} saved {preview.document.profiles.length === 1 ? 'connection' : 'connections'}.</p>
    <p>Passwords and sign-in tokens are excluded. Import saves new connections without connecting. Files include server names, usernames, certificates and local paths; review them before sharing.</p>
    <label>Existing names<select aria-label="Duplicate connection names" disabled={busy} value={duplicates} onChange={event => setDuplicates(event.target.value as 'skip' | 'copy')}><option value="skip">Skip existing names</option><option value="copy">Keep both with new names</option></select></label>
    <div className="profile-import-list" role="group" aria-label="Connections to import">{preview.document.profiles.map((config, index) => {
      const action = plan.find(item => item.index === index)
      return <label key={index}><input type="checkbox" aria-label={`Import connection ${index + 1}: ${config.name}`} checked={selected.includes(index)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, index] : previous.filter(value => value !== index))}/><span><strong>{config.name}</strong><small>{engineNames[config.engine]} · {['sqlite', 'duckdb'].includes(config.engine) ? config.filePath || 'In memory' : `${config.host}:${config.port} · ${config.database || 'Server'}`}</small>{action?.skip ? <small>Existing name — skipped</small> : action?.renamed ? <small>Import as {action.config.name}</small> : null}</span></label>
    })}</div>
    {overflow && <p role="alert">Only {MAX_PROFILES - existing.length} saved connection slots remain. Select fewer connections.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><span>{count} to import · Existing profiles are kept</span><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !count || overflow} onClick={async () => { setError(''); try { await onImport(selected, duplicates) } catch (error) { setError((error as Error).message) } }}>Import selected connections</button></div>
  </ModalDialog>
}
