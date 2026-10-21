import { useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../shared/contracts'
import type { ConnectionSafety } from '../shared/connection-options'

export function SessionSafetyBar({ session, onChange }: { session: SessionInfo; onChange(safety: ConnectionSafety): void }) {
  const [now, setNow] = useState(Date.now()), [show, setShow] = useState(false), [confirmation, setConfirmation] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), safety = session.safety
  useEffect(() => { if (!safety?.protected) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [safety?.protected])
  useEffect(() => { if (show) dialog.current?.showModal() }, [show])
  if (!safety?.environment && !safety?.protected && !safety?.ssh) return null
  const unlocked = safety.unlockedUntil > now
  async function change(lock = false) {
    setBusy(true); setError('')
    try { const next = await (lock ? window.dbCommander.lockSession(session.id) : window.dbCommander.unlockSession(session.id, confirmation)); onChange(next); setNow(Date.now()); setShow(false); setConfirmation('') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <><div className={`session-safety environment-${safety.environment ?? 'unlabeled'}`} aria-label="Connection safeguards"><strong>{safety.environment ?? 'Unlabeled'}</strong><span>{session.name} · {session.database || 'Server'}</span>
    {safety.ssh && <span title={`${safety.ssh.host}:${safety.ssh.port} · ${safety.ssh.fingerprint}`}>SSH verified</span>}
    {safety.protected && <><span>{unlocked ? `Unlocked · ${Math.ceil((safety.unlockedUntil - now) / 60000)} min remaining` : 'Protected · Locked'}</span><button disabled={busy} onClick={() => unlocked ? void change(true) : (setShow(true), setError(''), setConfirmation(''))}>{unlocked ? 'Lock connection' : 'Unlock connection'}</button></>}
    {error && !show && <span role="alert">{error}</span>}
  </div>{show && <dialog ref={dialog} className="connection-dialog protection-dialog" aria-label="Unlock protected connection" onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); if (!busy) setShow(false) }}>
    <h2>Unlock protected connection</h2><p>This enables SQL execution, schema changes, data edits, imports and restores for 10 minutes in this tab. It does not grant database permissions. Browsing is available while locked.</p><p><strong>{session.name} · {session.database || 'Server'} · {session.host}</strong></p>
    <label>Type connection name<input autoFocus autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label>{error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={() => setShow(false)}>Keep locked</button><button className="primary-button" disabled={busy || confirmation !== session.name} onClick={() => void change()}>Unlock this tab</button></div>
  </dialog>}</>
}
