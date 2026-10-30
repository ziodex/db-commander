import type { SessionInfo } from '../shared/contracts'
import { backupCapabilities } from '../shared/backup'
import { FolderOpen } from './WorkbenchIcons'

export interface BackupDraft {
  action: 'backup' | 'restore'; artifact: string; target: string; directory: string
  sourceSchema: string; toolDirectory: string; content: 'all' | 'schema'
}
export function BackupSetup({ session, draft, busy, busyLabel, blocked, change, choose, submit }: {
  session: SessionInfo; draft: BackupDraft; busy: boolean; busyLabel: string; blocked: boolean
  change(patch: Partial<BackupDraft>): void; choose(purpose: 'artifact' | 'target' | 'tools'): Promise<void>; submit(): void
}) {
  const capability = backupCapabilities[session.engine], embedded = ['sqlite', 'duckdb'].includes(session.engine)
  const local = capability.location === 'local', restoring = draft.action === 'restore'
  return <form onSubmit={event => { event.preventDefault(); submit() }}>
    <fieldset disabled={busy} className="backup-fields">
      <label>Operation<select value={draft.action} onChange={event => change({ action: event.target.value as BackupDraft['action'], content: 'all' })}><option value="backup">Back up database</option><option value="restore">Restore to a new target</option></select></label>
      <h3>{restoring ? 'Choose the backup to restore' : 'Choose where to save the backup'}</h3>
      <p className="backup-location-hint">{local ? 'File on this computer. Choose a file or enter its full path.' : capability.location === 'cloud' ? 'Database on the connected Azure logical server. No local file is created.' : capability.location === 'directory' ? 'File in an Oracle DIRECTORY on the database server. This is separate from folders on this computer.' : 'File on the SQL Server host, accessed by its service account. This is separate from files on this computer.'}</p>
      <div className="backup-path-control"><label>{capability.location === 'cloud' ? 'Recovery copy database name' : capability.location === 'directory' ? 'Dump filename' : capability.location === 'server' ? 'Backup file on database server' : 'Backup file'}<input required value={draft.artifact} onChange={event => change({ artifact: event.target.value })} placeholder={local ? `Full path to .${capability.extension} file` : capability.location === 'server' ? '/var/opt/mssql/backup/database.bak' : capability.location === 'directory' ? 'database.dmp' : 'database_recovery'} /></label>
        {local && <button type="button" onClick={() => void choose('artifact')}><FolderOpen size={16} />{restoring ? 'Browse backup files' : 'Choose backup destination'}</button>}
      </div>
      {session.engine === 'oracle' && <div className="form-row"><label>Oracle DIRECTORY<input required value={draft.directory} onChange={event => change({ directory: event.target.value })} /></label><label>Source schema<input required value={draft.sourceSchema} onChange={event => change({ sourceSchema: event.target.value })} /></label></div>}
      {restoring && <><h3>Choose a new restore target</h3><div className="backup-path-control"><label>{embedded ? 'New database file' : session.engine === 'oracle' ? 'New schema name (case sensitive)' : 'New database name'}<input required value={draft.target} onChange={event => change({ target: event.target.value })} /></label>{embedded && <button type="button" onClick={() => void choose('target')}><FolderOpen size={16} />Choose restore destination</button>}</div><p>Existing targets are refused. The current database stays connected.</p></>}
      {!restoring && capability.schemaOnly && <label>Backup contents<select value={draft.content} onChange={event => change({ content: event.target.value as BackupDraft['content'] })}><option value="all">Schema and data</option><option value="schema">Schema only</option></select></label>}
      {['postgres', 'mysql', 'mariadb'].includes(session.engine) && <details open className="backup-tools"><summary>Native client tools</summary><p>Use matching client tools from PATH, or choose their installation folder.</p><div className="backup-path-control"><label>Native tools directory (optional)<input value={draft.toolDirectory} onChange={event => change({ toolDirectory: event.target.value })} placeholder="Leave blank to search PATH" /></label><button type="button" onClick={() => void choose('tools')}><FolderOpen size={16} />Choose tools folder</button></div></details>}
    </fieldset>
    {blocked && <p>Finish this tab’s query, transaction or database operation and apply or discard staged edits first.</p>}
    <div className="dialog-actions backup-actions"><button type="submit" className="primary-button" disabled={blocked || busy}>{busy ? busyLabel : 'Review job'}</button></div>
  </form>
}
