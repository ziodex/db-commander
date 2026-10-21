import { useLayoutEffect, useState } from 'react'

type Appearance = 'dark' | 'light' | 'system'
export function useAppearance(preference: Appearance = 'dark'): 'dark' | 'light' {
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const changed = () => setSystemDark(media.matches)
    changed(); media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  const resolved = preference === 'system' ? systemDark ? 'dark' : 'light' : preference
  useLayoutEffect(() => { document.documentElement.dataset.theme = resolved }, [resolved])
  return resolved
}
