import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Keep the file identity check strict, while accepting Windows short-path aliases. */
export function rendererOrigin(rendererPath: string, devUrl?: string) {
  const developmentOrigin = devUrl ? new URL(devUrl).origin : undefined
  const file = developmentOrigin ? undefined : realpathSync(rendererPath)
  const url = devUrl || pathToFileURL(file!).href
  return {
    url,
    accepts(candidate: string | undefined): boolean {
      if (!candidate) return false
      try {
        const parsed = new URL(candidate)
        if (developmentOrigin) return parsed.origin === developmentOrigin
        parsed.hash = ''
        if (parsed.href === url) return true
        if (parsed.protocol !== 'file:' || parsed.host || parsed.search) return false
        // Chromium and Node may use different spellings of the same installed
        // path (for example VSSADM~1 versus the full Windows account directory).
        // Compare the exact resolved file, never a directory prefix or origin.
        return realpathSync(fileURLToPath(parsed)) === file
      } catch { return false }
    },
  }
}
