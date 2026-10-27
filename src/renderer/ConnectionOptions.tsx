import type { ConnectionConfig } from '../shared/contracts'
import { useState } from 'react'
import { protectedProfile } from '../shared/connection-options'

export function ConnectionOptions({ config, onChange, sshOnly = false }: { config: ConnectionConfig; onChange(config: ConnectionConfig): void; sshOnly?: boolean }) {
  const [error, setError] = useState('')
  const set = (patch: Partial<ConnectionConfig>) => onChange({ ...config, ...patch })
  if (!sshOnly) return <section className="profile-options" aria-label="Profile organization">
    <div className="form-row"><label>Profile folder<input placeholder="Unfiled" maxLength={100} value={config.folder ?? ''} onChange={e => set({ folder: e.target.value })}/></label>
      <label>Environment<select aria-label="Environment" value={config.environment ?? ''} onChange={e => set({ environment: e.target.value ? e.target.value as ConnectionConfig['environment'] : undefined })}><option value="">Unlabeled</option>{['development','test','staging','production'].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
    <label className="save-profile-option"><input type="checkbox" checked={Boolean(config.favorite)} onChange={e => set({ favorite: e.target.checked })}/>Favorite profile</label>
    <label className="save-profile-option"><input type="checkbox" checked={protectedProfile(config)} disabled={config.environment === 'production'} onChange={e => set({ protected: e.target.checked })}/>Protect this connection</label>
    <small>Production connections are always protected. Unlock each tab for 10 minutes to run SQL. Changes apply to new connections.</small>
  </section>
  const ssh = config.ssh
  const update = (patch: Partial<NonNullable<ConnectionConfig['ssh']>>) => set({ ssh: { ...ssh!, ...patch } })
  return <section className="ssh-options" aria-label="SSH tunnel settings">
    <label className="save-profile-option"><input type="checkbox" checked={Boolean(ssh)} onChange={e => set({ ssh: e.target.checked ? { host: '', port: 22, user: '', fingerprint: '', authentication: 'private-key', privateKeyPath: '' } : undefined, sshSecrets: undefined })}/>Use SSH tunnel</label>
    {ssh && <><div className="form-row"><label>SSH host<input required value={ssh.host} onChange={e => update({ host: e.target.value })}/></label><label>SSH port<input required type="number" min={1} max={65535} value={ssh.port} onChange={e => update({ port: Number(e.target.value) })}/></label></div>
      <label>SSH user<input required autoComplete="off" value={ssh.user} onChange={e => update({ user: e.target.value })}/></label>
      <label>SSH host-key fingerprint<input required placeholder="SHA256:…" value={ssh.fingerprint} onChange={e => update({ fingerprint: e.target.value })}/><small>Obtain the SHA256 fingerprint from a trusted administrator. Unknown or changed keys are rejected.</small></label>
      <label>SSH authentication<select value={ssh.authentication} onChange={e => { set({ ssh: { ...ssh, authentication: e.target.value as typeof ssh.authentication }, sshSecrets: undefined }) }}><option value="private-key">Private key file</option><option value="agent">SSH agent</option><option value="password">Password</option></select></label>
      {ssh.authentication === 'private-key' && <><label>SSH private key path<input required value={ssh.privateKeyPath ?? ''} onChange={e => update({ privateKeyPath: e.target.value })}/></label><button type="button" onClick={() => void window.dbCommander.chooseSshKey().then(path => { if (path) update({ privateKeyPath: path }); setError('') }).catch(e => setError((e as Error).message))}>Choose SSH key</button><label>SSH key passphrase<input type="password" autoComplete="new-password" value={config.sshSecrets?.passphrase ?? ''} onChange={e => set({ sshSecrets: { passphrase: e.target.value } })}/></label></>}
      {ssh.authentication === 'password' && <label>SSH password<input type="password" autoComplete="new-password" value={config.sshSecrets?.password ?? ''} onChange={e => set({ sshSecrets: { password: e.target.value } })}/></label>}
      {ssh.authentication === 'agent' && <small>Uses SSH_AUTH_SOCK, or the Windows OpenSSH agent. Agent forwarding is disabled.</small>}
      <label>Database host from SSH server<input placeholder={config.host} value={ssh.destinationHost ?? ''} onChange={e => update({ destinationHost: e.target.value || undefined })}/><small>Leave blank to use Host above. If overridden, database TLS still verifies Host above.</small></label>
      <small>SSH passwords and key passphrases are session-only. Private key contents are never saved in the workspace. Oracle tunnels require verified TLS; Azure SQL redirects require Proxy connection policy.</small>
      {error && <p role="alert">{error}</p>}
    </>}
  </section>
}
