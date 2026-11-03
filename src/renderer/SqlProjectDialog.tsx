import { useState } from 'react'
import type { SqlProject } from '../shared/sql-files'
import { ModalDialog } from './ModalDialog'

export function SqlProjectDialog({ project, busy, error, onChoose, onRefresh, onDetach, onOpen, onClose }: {
  project?: SqlProject | null; busy: boolean; error: string
  onChoose(): void; onRefresh(): void; onDetach(): void; onOpen(id: string): void; onClose(): void
}) {
  const [search, setSearch] = useState('')
  const files = project?.files.filter(file => file.relativePath.toLowerCase().includes(search.trim().toLowerCase())) ?? []
  return <ModalDialog className="connection-dialog sql-project-dialog" aria-label="SQL project" onDismiss={() => { if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>SQL project</h2><p>Open SQL files from a local folder, including a source-controlled checkout.</p></div></div>
    <div className="comparison-controls">
      <button disabled={busy} onClick={onChoose}>{project ? 'Change project folder…' : 'Choose project folder…'}</button>
      {(project || error) && <><button disabled={busy} onClick={onRefresh}>Refresh project files</button><button disabled={busy} onClick={onDetach}>Forget project folder</button></>}
    </div>
    {busy && <p role="status">Working with project files…</p>}
    {error && <p role="alert" className="dialog-error">{error}</p>}
    {project && <>
      <p className="sql-project-path"><strong>{project.name}</strong><span title={project.path}>{project.path}</span></p>
      <label>Find SQL files<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search relative paths"/></label>
      <p role="status">{files.length} of {project.files.length} listed files{project.limited ? ' · Scan limit reached' : ''}</p>
      {project.inaccessible && <p>Some subfolders could not be read. Refresh after checking access.</p>}
      {project.limited && <p>For more results, choose a smaller folder. The scan lists up to 500 SQL files across 4,000 entries and 12 levels of subfolders.</p>}
      {files.length ? <ul className="sql-project-files">{files.map(file => <li key={file.id}><button disabled={busy} onClick={() => onOpen(file.id)}>{file.relativePath}</button></li>)}</ul> :
        <p>{project.files.length ? 'No listed files match this search.' : 'No visible .sql files in the scanned folders.'}</p>}
    </>}
    {project === null && !busy && <p>Choose a folder to browse its SQL files. Opened files use the normal editor, Save and conflict checks.</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Close</button></div>
  </ModalDialog>
}
