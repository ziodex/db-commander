import { execFileSync } from 'node:child_process'

// This is a readiness check, not an unlock mechanism or a substitute for the
// native focus assertions. Never log the full console/device dictionary.
export function assertDesktopReady({ platform = process.platform, execute = execFileSync } = {}) {
  if (platform !== 'darwin') return
  let registry
  try {
    const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
    const plist = execute('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-a'], options)
    registry = JSON.parse(execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { ...options, input: plist }))
  } catch {
    throw new Error('Cannot inspect the macOS desktop session. GUI qualification requires a logged-in, unlocked console.')
  }
  const pending = [registry], sessions = []
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Object.hasOwn(value, 'IOConsoleUsers')) {
      if (!Array.isArray(value.IOConsoleUsers)) throw new Error('Invalid macOS console session information.')
      sessions.push(...value.IOConsoleUsers)
    }
    pending.push(...Object.values(value))
  }
  const enabled = value => value === true || value === 1
  const console = sessions.filter(session => session && enabled(session.kCGSSessionOnConsoleKey))
  if (console.length !== 1 || !enabled(console[0].kCGSessionLoginDoneKey)) throw new Error('GUI qualification requires one logged-in macOS console session.')
  const locked = console[0].CGSSessionScreenIsLocked
  if (enabled(locked)) throw new Error('The macOS desktop is locked. Unlock it before running native GUI qualification; focus checks cannot pass while it is locked.')
  // Some system versions omit the lock marker when it is clear. Real focus,
  // window reachability and keyboard tests still have to pass on that desktop.
  if (locked !== undefined && locked !== false && locked !== 0) throw new Error('Unrecognized macOS desktop lock state; GUI qualification cannot proceed.')
}
