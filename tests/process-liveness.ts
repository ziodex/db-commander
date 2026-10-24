export function processIsAlive(pid: number, probe: (pid: number, signal: 0) => unknown = process.kill): boolean {
  try { probe(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // Access denial does not prove exit. Keep the process in the bounded
    // shutdown poll until the OS confirms it no longer exists.
    if (code === 'EPERM') return true
    throw error
  }
}
