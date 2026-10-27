export const UPDATE_RELEASES_URL = 'https://github.com/ziodex/db-commander/releases'
export const UPDATE_API_URL = 'https://api.github.com/repos/ziodex/db-commander/releases/latest'
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
export interface UpdateStatus {
  currentVersion: string
  checking: boolean
  available?: { version: string; url: string }
  dismissed: boolean
  message?: string
}

/** The sandboxed preload cannot require external validation packages. */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  if (Object.keys(status).some(key => !['currentVersion', 'checking', 'available', 'dismissed', 'message'].includes(key))) return false
  if (typeof status.currentVersion !== 'string' || !status.currentVersion.length || status.currentVersion.length > 96 || typeof status.checking !== 'boolean' || typeof status.dismissed !== 'boolean') return false
  if (status.message !== undefined && (typeof status.message !== 'string' || status.message.length > 512)) return false
  if (status.available !== undefined) {
    if (!status.available || typeof status.available !== 'object' || Array.isArray(status.available)) return false
    const release = status.available as Record<string, unknown>
    if (Object.keys(release).some(key => !['version', 'url'].includes(key))) return false
    if (typeof release.version !== 'string' || !release.version.length || release.version.length > 96 || typeof release.url !== 'string' || !release.url.startsWith(`${UPDATE_RELEASES_URL}/tag/`) || release.url.length > 512) return false
  }
  return true
}
