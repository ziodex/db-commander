import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { physicalWorkerPath } from '../shared/physical-worker'

/** Establish native Windows ownership before opening any workspace/database. */
export function watchWindowsOwner(directory: string, owner: number, created: number): Promise<ChildProcess> {
  const host = process.pid
  if (![owner, created].every(value => Number.isSafeInteger(value) && value > 0) || owner > 0xffffffff || owner === host) return Promise.reject(new Error('Invalid database host ownership.'))
  return new Promise((resolve, reject) => {
    const child = spawn(physicalWorkerPath(directory, 'windows-owner-guard.exe', path), [String(owner), String(host), String(created)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = '', ready = false
    const fail = (error: Error) => { clearTimeout(timer); if (!ready) reject(error) }
    const timer = setTimeout(() => { child.kill(); fail(new Error('Windows database ownership monitor did not start.')) }, 10000)
    child.once('error', () => fail(new Error('Windows database ownership monitor could not start.')))
    child.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-4096) })
    child.stdout!.on('data', chunk => {
      output = (output + chunk).slice(-4096)
      if (!ready && output.includes('Db Commander owner guard ready')) { ready = true; clearTimeout(timer); resolve(child) }
    })
    child.once('exit', code => {
      if (ready) {
        // A guard that ends unexpectedly cannot leave an unowned live host.
        process.kill(process.pid, 'SIGKILL')
      } else fail(new Error(`Windows database ownership monitor exited (${code}): ${errors.trim()}`))
    })
  })
}
