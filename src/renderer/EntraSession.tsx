import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { entraProgressText, type EntraProgress } from '../shared/entra'
import { rendererError } from './workspace-runtime'

const api = window.dbCommander

/** Workspace-level ownership keeps the browser attempt actionable across tabs. */
export function EntraSession({ sessionId }: { sessionId?: string }) {
  const [progress, setProgress] = useState<EntraProgress>()
  const [renewing, setRenewing] = useState<string>()
  const [result, setResult] = useState<{ sessionId?: string; message: string; failed?: boolean }>()
  const action = useRef<HTMLButtonElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const inProgress = useRef(false)
  useEffect(() => api.onEntraSignIn(event => {
    if (event.surface !== 'workspace') return
    if (event.phase === 'finished') setProgress(current => current?.id === event.id ? undefined : current)
    else { setResult(current => current?.sessionId === undefined ? undefined : current); setProgress(event) }
  }), [])
  const canCancel = Boolean(progress)
  const visible = Boolean(sessionId || progress || renewing)
  useLayoutEffect(() => {
    if (canCancel && !inProgress.current && !document.querySelector('dialog[open]')) {
      const previous = document.activeElement
      if (previous instanceof HTMLElement && previous !== document.body && previous !== action.current) origin.current = previous
      action.current?.focus()
    } else if (!canCancel && inProgress.current && !visible) {
      const previous = origin.current
      if (previous?.isConnected && document.activeElement === document.body) previous.focus()
      origin.current = null
    }
    inProgress.current = canCancel
  }, [canCancel, visible])

  async function activate() {
    if (progress) {
      try { await api.cancelEntraSignIn(progress.id) }
      catch { setResult({ sessionId, message: 'Sign-in could not be cancelled. Return to the browser or wait for the request to expire.', failed: true }) }
      return
    }
    if (!sessionId || renewing) return
    const id = crypto.randomUUID()
    setRenewing(sessionId); setResult(undefined)
    try {
      await api.renewEntraSession(sessionId, { id, surface: 'workspace' })
      setResult({ sessionId, message: 'Microsoft Entra sign-in renewed for new database connections.' })
    } catch (error) { setResult({ sessionId, message: rendererError(error), failed: true }) }
    finally { setRenewing(undefined) }
  }

  if (!visible) return null
  const receipt = result && result.sessionId === sessionId ? result : undefined
  return <div className="session-safety" data-entra="" aria-label="Connection authentication">
    <span>Microsoft Entra</span>
    {(sessionId || progress) && <button ref={action} aria-disabled={!!renewing && !progress}
      onClick={() => void activate()}>{progress ? 'Cancel sign-in' : 'Renew sign-in'}</button>}
    {progress && progress.phase !== 'finished' ? <span role="status">{entraProgressText[progress.phase]}</span>
      : renewing ? <span role="status">Renewing sign-in…</span> : null}
    {receipt && <span role={receipt.failed ? 'alert' : 'status'}>{receipt.message}</span>}
  </div>
}
