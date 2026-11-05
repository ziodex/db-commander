import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { CatalogPage, CatalogPageRequest } from '../shared/catalog'
import { rendererError } from './workspace-runtime'

export type ReadCatalog = (request: CatalogPageRequest) => Promise<CatalogPage>

/** One replaceable page; unmounted tabs/children and superseded searches retain
 * no response. Session ownership and serialization remain in the controller. */
export function useCatalogPage(request: CatalogPageRequest, revision: string | undefined, blocked: boolean, load: ReadCatalog, occupied = false) {
  const [retry, setRetry] = useState(0)
  const [settlement, setSettlement] = useState(0)
  const inFlight = useRef(false), mounted = useRef(false)
  const key = JSON.stringify([request, revision, retry]), settled = useRef('')
  const [result, setResult] = useState<{ key: string; page?: CatalogPage; error?: string }>({ key: '' })
  const read = useEffectEvent(() => load(request))
  const waiting = blocked || occupied && !inFlight.current, delay = request.search ? 200 : 0
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (waiting || inFlight.current || settled.current === key) return
    let current = true
    const start = () => {
      inFlight.current = true
      void read().then(page => {
        if (current) { settled.current = key; setResult({ key, page }) }
      }, error => {
        if (current) { settled.current = key; setResult({ key, error: rendererError(error) }) }
      }).finally(() => {
        inFlight.current = false
        if (mounted.current) setSettlement(n => n + 1)
      })
    }
    // An initial/explicit page read reserves its physical owner before paint.
    // A deferred zero-delay start would briefly advertise Run/Close as idle.
    const timer = delay ? setTimeout(start, delay) : undefined
    if (!delay) start()
    return () => { current = false; clearTimeout(timer) }
    // The key contains the complete immutable request and refresh identity.
  }, [key, waiting, delay, settlement])
  const active = result.key === key ? result : undefined
  return { page: active?.page, error: active?.error, loading: !active, retry: () => setRetry(n => n + 1) }
}
