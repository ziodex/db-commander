import { useEffect, useState } from 'react'

const api = window.dbCommander
export function EntraSession({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState(false), [waiting, setWaiting] = useState(false)
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  useEffect(() => api.onEntraSignIn(setWaiting), [])
  async function renew() {
    setPending(true); setMessage(''); setError('')
    try {
      await api.renewEntraSession(sessionId)
      setMessage('Microsoft Entra sign-in renewed for new database connections.')
    } catch (error) {
      setError((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
    } finally { setPending(false) }
  }
  return <>
    <span>Microsoft Entra</span>
    <button disabled={pending} onClick={() => void renew()}>Renew sign-in</button>
    {pending && waiting && <button onClick={() => void api.cancelEntraSignIn().catch(() => setError('The sign-in could not be cancelled.'))}>Cancel sign-in</button>}
    {pending && <span role="status">{waiting ? 'Finish sign-in in your browser.' : 'Renewing sign-in…'}</span>}
    {message && <span role="status">{message}</span>}
    {error && <span role="alert">{error}</span>}
  </>
}
