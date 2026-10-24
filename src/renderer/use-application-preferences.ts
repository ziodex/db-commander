import { useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../shared/contracts'
import type { EditorSettings } from '../shared/editor-settings'

export function useApplicationPreferences(api: DesktopApi, legacy: EditorSettings) {
  const [preferences, setPreferences] = useState<EditorSettings | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    let cancelled = false
    const initial = revision.current
    const unsubscribe = api.onPreferencesChanged(settings => { revision.current++; setPreferences(settings) })
    void api.preferences().then(settings => {
      if (!cancelled && revision.current === initial) setPreferences(settings)
    }).catch(console.error)
    return () => { cancelled = true; unsubscribe() }
  }, [api])
  return {
    // Existing workspace preferences are retained until the first application-wide Apply.
    settings: preferences ?? legacy,
    apply: async (settings: EditorSettings) => { await api.savePreferences(settings) }
  }
}
