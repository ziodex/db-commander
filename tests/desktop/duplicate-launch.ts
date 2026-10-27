import type { ChildProcess } from 'node:child_process'

export function duplicateArguments(ownerArguments: readonly string[], applicationArguments: string[]) {
  // Mirror only the sandbox switch actually used by Playwright's owner. Never
  // copy its debugger loader/ports or disable a sandbox the owner was using.
  return [...(ownerArguments.includes('--no-sandbox') ? ['--no-sandbox'] : []), ...applicationArguments]
}

export function observeDuplicate(child: ChildProcess) {
  let stderr = Buffer.alloc(0), spawnError: string | undefined
  child.stderr?.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-16384) })
  child.once('error', error => { spawnError = error.message })
  return () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, spawnError, stderr: stderr.toString('utf8') })
}
