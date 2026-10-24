import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, RefreshCw, X } from './WorkbenchIcons'
import type { DesktopApi } from '../shared/contracts'
import type { UpdateStatus } from '../shared/updates'

type UpdateApi = Pick<DesktopApi, 'updateStatus' | 'onUpdateStatus' | 'dismissUpdate' | 'openUpdatePage'>

export function UpdateBanner({ api }: { api: UpdateApi }) {
  const [status, setStatus] = useState<UpdateStatus>()
  const [error, setError] = useState('')
  const previousFocus = useRef<HTMLElement | null>(null)
  const banner = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false, received = false
    const unsubscribe = api.onUpdateStatus(value => {
      received = true
      if (!disposed) { setStatus(value); setError('') }
    })
    void api.updateStatus().then(value => { if (!disposed && !received) setStatus(value) }).catch(() => {})
    return () => { disposed = true; unsubscribe() }
  }, [api])
  const release = status?.dismissed ? undefined : status?.available
  if (!status || !release && !status.message) return null
  async function openRelease() {
    try { await api.openUpdatePage(); setError('') }
    catch { setError('Could not open your browser. Try again.') }
  }
  async function dismiss() {
    if (banner.current?.contains(document.activeElement)) {
      const target = previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLElement>('.command-button')
      target?.focus()
    }
    try { await api.dismissUpdate(release?.version) }
    catch { setError('Could not dismiss this notice. Try again.') }
  }
  return <div className="update-banner" ref={banner} aria-label="Application updates" onFocusCapture={event => {
    if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) previousFocus.current = event.relatedTarget
  }}>
    <div className="update-banner-copy" role="status">
      {release ? <><strong>Db Commander {release.version} is available.</strong><span> Installation is manual. Update when you’re ready.</span>{status.message && <p>{status.message}</p>}</> : <span>{status.message}</span>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="update-banner-actions">
      {(release || !status.checking) && <button onClick={() => void openRelease()}>{release ? 'Release notes & download' : 'View releases'}<ArrowUpRight size={14} /></button>}
      {status.checking && <RefreshCw size={14} aria-label="Checking for updates" />}
      <button aria-label="Dismiss update notification" title="Dismiss update notification" onClick={() => void dismiss()}><X size={16} /></button>
    </div>
  </div>
}
