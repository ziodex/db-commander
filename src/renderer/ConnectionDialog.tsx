import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Check, ChevronRight, Database, FolderOpen, X } from './WorkbenchIcons'
import { ModalDialog } from './ModalDialog'
import { ConnectionOptions } from './ConnectionOptions'
import { defaultPorts } from '../shared/database-engines'
import { engineNames, type ConnectionConfig, type ConnectionProfile, type DatabaseEngine } from '../shared/contracts'
import { credentialBinding, passwordEligible, type PasswordChoice, type PasswordStatus } from '../shared/credentials'
import { connectionProfile, sameConnectionProfile } from '../shared/connection-profiles'

const api = window.dbCommander

export function ConnectionDialog({ profile, profileId, busy, error, saveOnly, onClose, onConnect, onSave }: { profile: ConnectionProfile; profileId?: string; busy: boolean; error: string; saveOnly?: boolean; onClose(): void; onConnect(config: ConnectionConfig, saveProfile: boolean, choice: PasswordChoice): Promise<void>; onSave(config: ConnectionConfig, choice: PasswordChoice): Promise<void> }) {
  const [form, setForm] = useState<ConnectionConfig>({ ...profile, password: '' })
  const [fileError, setFileError] = useState('')
  const [saveConnection, setSaveConnection] = useState(true)
  const [vaultStatus, setVaultStatus] = useState<PasswordStatus | null>(null)
  const [remember, setRemember] = useState(false), [useSaved, setUseSaved] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [testing, setTesting] = useState(false), testInFlight = useRef(false)
  const [testResult, setTestResult] = useState<{ form: ConnectionConfig; useSaved: boolean; success: boolean; message: string } | null>(null)
  const testSession = useRef<string | null>(null)
  const testFocus = useRef<HTMLButtonElement | null>(null)
  const blocked = busy || removing || testing
  const receiveVaultStatus = useEffectEvent((status: PasswordStatus) => {
      setVaultStatus(status)
      if (!form.password) { setRemember(status.saved); setUseSaved(status.saved && status.available) }
  })
  useEffect(() => {
    let disposed = false
    void api.passwordStatus(profileId).then(status => {
      if (disposed) return
      receiveVaultStatus(status)
    }).catch(() => { if (!disposed) setVaultStatus({ available: false, saved: false, backend: 'Operating system credential store', reason: 'Credential store status could not be checked. You can still connect with a session-only password.' }) })
    return () => { disposed = true }
  }, [profileId])
  const sameBinding = credentialBinding(form) === credentialBinding(profile)
  const addsProfile = !saveOnly && Boolean(profileId) && !sameConnectionProfile(profile, connectionProfile(form))
  const canUseSaved = Boolean(vaultStatus?.saved && vaultStatus.available && sameBinding && passwordEligible(form))
  const testUsesSaved = Boolean(profileId && canUseSaved && useSaved && !form.password)
  const visibleTestResult = testResult?.form === form && testResult.useSaved === testUsesSaved ? testResult : null
  useEffect(() => () => {
    // A pending open still closes itself below, even if the window is removed.
    // If a close failed, retain its identity for retry and try once on dismissal.
    if (testSession.current) void api.disconnect(testSession.current).catch(() => {})
  }, [])
  useLayoutEffect(() => {
    if (testing) return
    const button = testFocus.current
    testFocus.current = null
    if (button?.isConnected && (document.activeElement === document.body || document.activeElement === button.closest('dialog'))) button.focus()
  }, [testing])
  async function removePassword() {
    if (!profileId || blocked || testInFlight.current) return
    setRemoving(true); setFileError('')
    try {
      await api.removeProfilePassword(profileId)
      setVaultStatus(previous => previous ? { ...previous, saved: false } : previous); setRemember(false); setUseSaved(false)
    } catch (error) { setFileError((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { setRemoving(false) }
  }
  const update = (key: keyof ConnectionConfig, value: string | number) => setForm(previous => ({ ...previous, [key]: value }))
  const changeEngine = (engine: DatabaseEngine) => setForm(previous => ({ ...previous, engine,
    port: previous.port === defaultPorts[previous.engine] ? defaultPorts[engine] : previous.port,
    name: previous.name === `Local ${engineNames[previous.engine]}` ? `Local ${engineNames[engine]}` : previous.name,
    database: engine === 'oracle' && ['postgres', 'dbcommander', 'SQLite', 'DuckDB'].includes(previous.database) ? 'FREEPDB1' : ['postgres', 'FREEPDB1', 'SQLite', 'DuckDB'].includes(previous.database) ? 'dbcommander' : previous.database,
    ca: engine === 'oracle' ? '' : previous.ca, ssh: ['sqlite', 'duckdb'].includes(engine) ? undefined : previous.ssh, sshSecrets: undefined,
    user: previous.user === 'postgres' ? 'dbcommander' : previous.user, password: '', accessToken: undefined, authentication: undefined,
    tls: engine === 'azure-sql' || ['sqlite', 'duckdb'].includes(previous.engine) ? 'verify-full' : previous.tls
  }))
  const embedded = ['sqlite', 'duckdb'].includes(form.engine), duckdb = form.engine === 'duckdb'
  const modeKey = duckdb ? 'duckdbMode' : 'sqliteMode', mode = form[modeKey] ?? 'read-write'
  const input = (label: string, key: 'name' | 'host' | 'database' | 'user' | 'password', type = 'text') => <label>{label}<input required={key !== 'password' && (key !== 'database' || form.engine === 'oracle')} autoFocus={key === 'name'} autoComplete={key === 'password' ? 'new-password' : 'off'} type={type} value={form[key]} onChange={event => update(key, event.target.value)} /></label>
  async function chooseFile() {
    try { const path = await (duckdb ? api.chooseDuckdbFile : api.chooseSqliteFile)(mode === 'create'); if (path) update('filePath', path); setFileError('') }
    catch (error) { setFileError((error as Error).message) }
  }
  function connectionConfig(): ConnectionConfig {
    return embedded ? { ...form, [modeKey]: mode, database: engineNames[form.engine], host: 'local', port: 1, user: 'local', password: '', accessToken: undefined, authentication: undefined, tls: 'disable', ca: undefined, ssh: undefined, sshSecrets: undefined } : form
  }
  async function testConnection(event: MouseEvent<HTMLButtonElement>) {
    if (blocked || testInFlight.current || (embedded && mode === 'create') || !event.currentTarget.form?.reportValidity()) return
    const config = connectionConfig(), useSavedPassword = testUsesSaved
    const button = event.currentTarget, restoreFocus = document.activeElement === button
    setFileError(''); setTestResult(null)
    if (config.authentication === 'entra-token' && !config.accessToken?.trim()) {
      setTestResult({ form, useSaved: useSavedPassword, success: false, message: 'Enter a current access token to test this connection. The token is never saved.' }); return
    }
    testFocus.current = restoreFocus ? button : null
    testInFlight.current = true; setTesting(true)
    try {
      // A test owns its temporary session. It never replaces a query tab's
      // connection, saves the draft/credentials, or executes the editor's SQL.
      if (testSession.current) { await api.disconnect(testSession.current); testSession.current = null }
      const session = useSavedPassword && profileId
        ? await api.connectSavedPassword(profileId, connectionProfile(config), config.sshSecrets)
        : await api.connect(config)
      testSession.current = session.id
      await api.disconnect(session.id); testSession.current = null
      setTestResult({ form, useSaved: useSavedPassword, success: true, message: 'Connection successful. Test connection closed.' })
    } catch (error) {
      let message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not test the connection.'
      for (const secret of [config.password, config.accessToken, config.sshSecrets?.password, config.sshSecrets?.passphrase]) if (secret) message = message.split(secret).join('[redacted]')
      setTestResult({ form, useSaved: useSavedPassword, success: false, message: `${testSession.current ? 'Connection opened, but the test connection could not be closed' : 'Connection failed'}: ${message}` })
    } finally {
      testInFlight.current = false; setTesting(false)
    }
  }
  function submit() {
    if (blocked || testInFlight.current) return
    const config = connectionConfig()
    const choice = { remember: Boolean((saveOnly || saveConnection) && remember && passwordEligible(config)), useSaved: Boolean(!saveOnly && canUseSaved && useSaved && !config.password) }
    if (choice.remember && !config.password && !(vaultStatus?.saved && sameBinding && !addsProfile)) { setFileError(addsProfile ? 'Enter a password to remember it for the new profile, or uncheck Remember password. The existing saved password is kept.' : 'Enter a password to remember it for these connection settings.'); return }
    setFileError('')
    void (saveOnly ? onSave(config, choice) : onConnect(config, saveConnection, choice))
  }
  return <ModalDialog className="connection-dialog connection-form" aria-labelledby="connection-title" onDismiss={() => { if (!blocked && !testInFlight.current) onClose() }}><form onSubmit={event => { event.preventDefault(); submit() }}>
    <div className="dialog-heading"><div><h2 id="connection-title">{saveOnly ? `Save ${engineNames[form.engine]} profile` : `Connect to ${engineNames[form.engine]}`}</h2></div><button type="button" aria-label="Close connection dialog" disabled={blocked} onClick={onClose}><X size={18} /></button></div>
    <div className="connection-fields"><fieldset disabled={blocked}>
      <div className="form-row"><label>Database engine<select value={form.engine} onChange={event => changeEngine(event.target.value as DatabaseEngine)}>{Object.entries(engineNames).map(([engine, name]) => <option key={engine} value={engine}>{name}</option>)}</select></label>
      {input('Connection name', 'name')}</div>
      {embedded ? <>
        <label>Open mode<select value={mode} onChange={event => update(modeKey, event.target.value)}><option value="read-write">Open existing database</option><option value="read-only">Open read-only</option><option value="create">Create new database</option><option value="memory">Temporary in-memory database</option></select></label>
        {mode !== 'memory' && <><label>Database file<input required value={form.filePath ?? ''} placeholder={`Absolute path to a ${engineNames[form.engine]} database`} onChange={event => update('filePath', event.target.value)} /></label><button type="button" onClick={() => void chooseFile()}><FolderOpen size={14} />{mode === 'create' ? 'Choose new database file' : 'Browse database files'}</button></>}
        <div className="privacy-note"><Database size={15} /><p>{mode === 'memory' ? 'Temporary data lasts only for this connection. ' : mode === 'create' ? 'Creates a new file; existing files are never replaced. ' : mode === 'read-only' ? (duckdb ? 'The selected database is read-only. SQL can still read or write other local files. ' : 'Database writes and attaching other files are disabled. ') : 'Changes are saved directly to this database file. '}{duckdb ? 'Stop interrupts the query and keeps the connection open. Extension downloads require explicit SQL.' : 'Stop closes the SQLite session. Reconnect to continue; temporary data is lost.'}</p></div>
      </> : <>
        <div className="form-row host-row">{input('Host', 'host')}<label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={event => update('port', Number(event.target.value))} /></label></div>
        <div className="form-row">{input(form.engine === 'oracle' ? 'Service name' : 'Database', 'database')}{input(form.authentication === 'entra-token' ? 'Account label' : 'User', 'user')}</div>
        <small>{form.engine === 'postgres' ? 'Database is optional. Leave blank to use postgres; specify a database if postgres is unavailable.' : form.engine === 'mysql' || form.engine === 'mariadb' ? 'Database is optional. Leave blank to connect without a default database.' : form.engine === 'sqlserver' ? 'Database is optional. Leave blank to use the login’s default database.' : form.engine === 'azure-sql' ? 'Database is optional with access to master. Contained users must specify a database.' : 'Service or PDB name is required.'}</small>
        {form.engine === 'azure-sql' && <label>Authentication<select value={form.authentication ?? 'sql-password'} onChange={event => setForm(previous => ({ ...previous, authentication: event.target.value as ConnectionConfig['authentication'], password: '', accessToken: '' }))}><option value="sql-password">SQL login</option><option value="entra-token">Microsoft Entra access token</option></select></label>}
        {form.authentication === 'entra-token' ? <label>Access token<input aria-label="Access token" required={!saveOnly} type="password" autoComplete="off" value={form.accessToken ?? ''} onChange={event => update('accessToken', event.target.value)} /><small>{saveOnly ? 'Optional for saving a profile; required to test the connection. Never saved.' : 'For https://database.windows.net/. Paste a current token; renewal is manual.'}</small></label> : input('Password', 'password', 'password')}
        {passwordEligible(form) && <div className="password-options">
          {vaultStatus?.saved && <>
            <small>{addsProfile ? `“${profile.name}” has a saved password. Enter a password again to remember it for this new connection.` : 'Password saved. Leave blank to keep it, or enter a replacement.'}</small>
            {!sameBinding && <small>{saveOnly ? 'Connection settings changed. Enter a password explicitly; saving these settings removes the previous saved password.' : 'Connection settings changed. Enter a password explicitly; the existing saved connection and password are kept.'}</small>}
            <label className="save-profile-option"><input type="checkbox" checked={canUseSaved && useSaved && !form.password} disabled={!canUseSaved || Boolean(form.password)} onChange={event => setUseSaved(event.target.checked)} />Use saved password</label>
            <button type="button" onClick={() => void removePassword()}>Remove saved password</button>
          </>}
          {(saveOnly || saveConnection) && <label className="save-profile-option"><input type="checkbox" checked={remember} disabled={!vaultStatus?.available && !remember} onChange={event => setRemember(event.target.checked)} />Remember password</label>}
          <small>{vaultStatus ? vaultStatus.reason ?? `Optional storage in ${vaultStatus.backend}.` : 'Checking operating system credential store…'}</small>
        </div>}
        <label>Transport security<select disabled={form.engine === 'azure-sql'} value={form.tls} onChange={event => update('tls', event.target.value)}><option value="verify-full">TLS · verify certificate and hostname</option><option value="disable">Disable TLS · local development only</option></select></label>
        {form.engine === 'oracle' && <small>Use the listener’s TCPS port for TLS (often 2484). Private CAs: set NODE_EXTRA_CA_CERTS to a PEM file before launching the app. DML needs Commit or Rollback; DDL commits implicitly.</small>}
        {form.tls === 'verify-full' && form.engine !== 'oracle' && <details><summary>Custom CA certificate</summary><label><span className="sr-only">CA certificate PEM</span><textarea aria-label="CA certificate PEM" placeholder="Paste a trusted PEM certificate. Leave empty for system trust." value={form.ca} onChange={event => update('ca', event.target.value)} /></label></details>}

      </>}
      {!saveOnly && <label className="save-profile-option"><input type="checkbox" checked={saveConnection} onChange={event => setSaveConnection(event.target.checked)} />Save connection profile</label>}
      {!saveOnly && saveConnection && profileId && <small>{addsProfile ? `A new saved connection will be added. “${profile.name}” will be kept. Use Edit profile to update an existing entry.` : `Uses the saved connection “${profile.name}”.`}</small>}
      <details className="connection-options" open={saveOnly || Boolean(profile.folder || profile.environment || profile.favorite || profile.protected)}><summary>Profile options</summary>
        <ConnectionOptions config={form} onChange={setForm}/>
        <label className="history-profile-option"><input type="checkbox" aria-label="Record history for this connection" checked={form.recordHistory!==false} onChange={e=>setForm({...form,recordHistory:e.target.checked})}/>Record history for this connection</label>
        <small>Connection details and query history are stored locally. Access tokens are never saved.</small>
      </details>
      {!embedded && <details className="connection-options" open={Boolean(profile.ssh)}><summary>SSH tunnel{form.ssh ? ` · ${form.ssh.host || 'Enabled'}` : ''}</summary><ConnectionOptions config={form} onChange={setForm} sshOnly/></details>}
    </fieldset></div>
    {(fileError || (!testing && !visibleTestResult && error)) && <p className="dialog-error" role="alert">{fileError || error}</p>}
    {testing && <p className="connection-test-feedback" role="status">Testing connection…</p>}
    {visibleTestResult && <p className={`connection-test-feedback ${visibleTestResult.success ? 'success' : 'failure'}`} role={visibleTestResult.success ? 'status' : 'alert'}>{visibleTestResult.success ? <Check size={16}/> : <X size={16}/>}<span>{visibleTestResult.message}</span></p>}
    {embedded && mode === 'create' && <p className="connection-test-note">To test a connection, choose an existing database or temporary in-memory mode. Testing never creates a database file.</p>}
    <div className="dialog-actions"><button className="test-connection-button" type="button" disabled={blocked || (embedded && mode === 'create') || (!vaultStatus && passwordEligible(form))} onClick={event => void testConnection(event)}>{testing ? 'Testing…' : 'Test connection'}</button><button type="button" disabled={blocked} onClick={onClose}>Cancel</button><button className="primary-button" disabled={blocked || (!vaultStatus && passwordEligible(form))} type="submit">{busy ? (saveOnly ? 'Saving…' : 'Connecting…') : saveOnly ? 'Save profile' : 'Connect'}<ChevronRight size={15} /></button></div>
  </form></ModalDialog>
}
