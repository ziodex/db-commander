import { expect, it, vi } from 'vitest'
import { assertDesktopReady } from '../../scripts/desktop-readiness.mjs'

function fixture(sessions) {
  const execute = vi.fn().mockReturnValueOnce('private device plist').mockReturnValueOnce(JSON.stringify({ root: { IOConsoleUsers: sessions } }))
  return { platform: 'darwin', execute }
}
const session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }

it.each([true, 1])('refuses an explicitly locked console (%s) before GUI commands can start', locked => {
  expect(() => assertDesktopReady(fixture([{ ...session, CGSSessionScreenIsLocked: locked }]))).toThrow('desktop is locked')
})
it.each([false, 0, undefined])('accepts a logged-in console with no reported lock (%s), preserving real focus assertions', locked => {
  const options = fixture([{ ...session, CGSSessionScreenIsLocked: locked }])
  expect(() => assertDesktopReady(options)).not.toThrow()
  expect(options.execute.mock.calls[0]).toEqual(['/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-a'], expect.objectContaining({ timeout: 5000, maxBuffer: 4 * 1024 * 1024 })])
  expect(options.execute.mock.calls[1]).toEqual(['/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], expect.objectContaining({ input: 'private device plist' })])
})
it.each([
  { name: 'absent', sessions: [] },
  { name: 'inactive', sessions: [{ ...session, kCGSSessionOnConsoleKey: false }] },
  { name: 'logged-out', sessions: [{ ...session, kCGSessionLoginDoneKey: false }] },
  { name: 'ambiguous', sessions: [session, session] }
])('refuses $name consoles', ({ sessions }) => {
  expect(() => assertDesktopReady(fixture(sessions))).toThrow('one logged-in macOS console')
})
it('ignores inactive sessions and rejects malformed or unrecognized state', () => {
  expect(() => assertDesktopReady(fixture([{ ...session, kCGSSessionOnConsoleKey: false, CGSSessionScreenIsLocked: true }, session]))).not.toThrow()
  expect(() => assertDesktopReady(fixture({ unexpected: true }))).toThrow('Invalid macOS console')
  expect(() => assertDesktopReady(fixture([{ ...session, CGSSessionScreenIsLocked: 'unknown' }]))).toThrow('Unrecognized macOS desktop lock state')
})
it('fails closed on inspection/parse errors without printing private console data', () => {
  for (const execute of [vi.fn(() => { throw new Error('private console information') }), vi.fn().mockReturnValueOnce('plist').mockReturnValueOnce('private invalid JSON')]) {
    let failure
    try { assertDesktopReady({ platform: 'darwin', execute }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('Cannot inspect the macOS desktop session')
    expect(failure.message).not.toContain('private')
  }
})
it.each(['linux', 'win32'])('leaves %s desktop handling to its native setup', platform => {
  const execute = vi.fn(); assertDesktopReady({ platform, execute }); expect(execute).not.toHaveBeenCalled()
})
