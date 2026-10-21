import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe.skipIf(process.platform !== 'win32')('Windows kernel-handle ownership', () => {
  let directory: string, executable: string
  const children: ChildProcess[] = []
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'dbcommander-owner-guard-'))
    const install = join(directory, 'helper with spaces % # é'); mkdirSync(install)
    executable = join(install, 'windows-owner-guard.exe')
    const compiler = join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`, resolve('src/main/windows-owner-guard.cs')], { windowsHide: true, timeout: 10000 })
  })
  afterEach(async () => {
    await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('exit', () => resolve()); child.kill('SIGKILL')
    })))
  })
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
  function launch(code: string) {
    const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true }); children.push(child); return child
  }
  async function guard(owner: number, host: number) {
    const created = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${owner}).StartTime).ToUnixTimeMilliseconds()`], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
    const child = spawn(executable, [String(owner), String(host), created], { windowsHide: true }); children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(new Error(`Guard exited before readiness: ${code}`)))
      let output = ''
      child.stdout!.on('data', chunk => { output += chunk; if (output.includes('Db Commander owner guard ready')) resolve() })
    })
    return child
  }
  it('ends only the blocked host after its owner dies', async () => {
    const owner = launch('setInterval(()=>{},1000)'), host = launch('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)'), bystander = launch('setInterval(()=>{},1000)')
    const watcher = await guard(owner.pid!, host.pid!)
    owner.kill('SIGKILL')
    await expect.poll(() => host.exitCode !== null || host.signalCode !== null).toBe(true)
    await expect.poll(() => watcher.exitCode).toBe(0)
    expect(bystander.exitCode).toBeNull(); expect(bystander.signalCode).toBeNull()
  })
  it('settles when the host ends while its owner remains alive', async () => {
    const host = launch('setInterval(()=>{},1000)'), watcher = await guard(process.pid, host.pid!)
    host.kill('SIGKILL')
    await expect.poll(() => watcher.exitCode).toBe(0)
    expect(process.kill(process.pid, 0)).toBe(true)
  })
})
