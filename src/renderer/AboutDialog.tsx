import { useEffect, useState } from 'react'
import type { DesktopApi } from '../shared/contracts'
import { ModalDialog } from './ModalDialog'

export function AboutDialog({ api }: { api: Pick<DesktopApi, 'onAbout'> }) {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => api.onAbout(setVersion), [api])
  if (version === null) return null
  return <ModalDialog className="confirmation-dialog" aria-labelledby="about-title" onDismiss={() => setVersion(null)}>
    <h2 id="about-title">About Db Commander</h2>
    <p><strong>Version {version}</strong></p>
    <p>An open-source desktop SQL workbench for browsing databases, writing queries and working with your data.</p>
    <p>Developer preview · Apache License 2.0<br/>Db Commander contributors</p>
    <div className="dialog-actions"><button autoFocus className="primary-button" onClick={() => setVersion(null)}>Close</button></div>
  </ModalDialog>
}
