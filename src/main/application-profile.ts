import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Keep existing workspaces in place, including their path-bound keychain entries. */
export function applicationProfile(appData: string, override?: string) {
  const current = join(appData, 'Db Commander')
  const legacy = join(appData, 'SQLCommander')
  const directory = override || (existsSync(current) || !existsSync(legacy) ? current : legacy)
  // Keep one namespace for automatic paths, overrides, aliases and older installs.
  // The lock key itself is always derived from the physical profile directory.
  return { directory, lockFolder: 'SQLCommander Profile Locks' }
}
