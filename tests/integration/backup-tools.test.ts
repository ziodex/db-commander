import { expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runTool } from '../../src/backup/tools'
import { publishFile } from '../../src/backup/files'
import { diskFullFixture } from '../desktop/disk-full-fixture'

function alive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native tool did not settle after output volume exhaustion.')), 6500) })]) }
  finally { clearTimeout(timer) }
}

for (const helper of [false, true]) it.skipIf(process.platform !== 'darwin')(`native backup tool ${helper ? 'with an exited parent and resistant helper ' : ''}stops after real ENOSPC, preserves the cause and removes unpublished output`, async () => {
  const volume = diskFullFixture(), destination = join(volume.mount, 'snapshot'), pidFile = join(volume.root, 'pid'), helperFile = join(volume.root, 'helper'), gate = join(volume.root, 'write')
  const writer = `const fs=require('node:fs');let failed=false;process.on('SIGTERM',()=>{});process.stdout.on('error',()=>{failed=true});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(!failed&&fs.existsSync(process.argv[2]))process.stdout.write(Buffer.alloc(65536,42))},5)`
  const script = helper ? `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[3],process.argv[2]],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(fs.existsSync(process.argv[3]))process.exit(0)},5)` : writer
  const context = { signal: new AbortController().signal, log() {} }
  const operation = publishFile(destination, context, temporary => runTool({ executable: process.execPath, args: ['-e', script, pidFile, gate, helperFile], output: temporary }, context).then(() => {}))
  operation.catch(() => {})
  let pid: number | undefined, helperPid: number | undefined
  try {
    pid = await vi.waitFor(() => { const value = Number(readFileSync(pidFile, 'utf8')); if (!Number.isInteger(value) || value < 1) throw new Error('Child not ready.'); return value }, { timeout: 3000, interval: 20 })
    if (helper) {
      helperPid = await vi.waitFor(() => { const value = Number(readFileSync(helperFile, 'utf8')); if (!Number.isInteger(value) || value < 1) throw new Error('Helper not ready.'); return value }, { timeout: 3000, interval: 20 })
      await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 3000, interval: 20 })
    }
    await vi.waitFor(() => {
      const scratch = readdirSync(volume.mount).find(name => name.startsWith('.dbcommander-backup-'))
      expect(scratch && existsSync(join(volume.mount, scratch, 'backup'))).toBe(true)
    }, { timeout: 3000, interval: 20 })
    const full = volume.fill(), started = Date.now()
    writeFileSync(gate, '')
    await expect(bounded(operation)).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(alive(pid)).toBe(false)
    if (helperPid) expect(alive(helperPid)).toBe(false)
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(volume.mount).filter(name => name.startsWith('.dbcommander-backup-'))).toEqual([])
    const stoppedWithinMs = Date.now() - started
    volume.release()
    await bounded(publishFile(destination, context, temporary => runTool({ executable: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([0,255,10,42]))'], output: temporary }, context).then(() => {})))
    expect(readFileSync(destination)).toEqual(Buffer.from([0, 255, 10, 42]))
    expect(readdirSync(volume.mount).filter(name => name.startsWith('.dbcommander-backup-'))).toEqual([])
    if (process.env.SQLCOMMANDER_TOOL_FAULT_REPORT) {
      const report = helper ? process.env.SQLCOMMANDER_TOOL_FAULT_REPORT.replace(/\.json$/, '') + '-helpers.json' : process.env.SQLCOMMANDER_TOOL_FAULT_REPORT
      await mkdir(dirname(report), { recursive: true })
      writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, ...full, stoppedWithinMs, childExitedBeforeCleanup: true, helperExitedBeforeCleanup: helperPid ? !alive(helperPid) : undefined, parentExitedBeforeFault: helper, failedArtifactPublished: false, explicitRetryPublished: true, retryBytes: 4, scratchDirectories: 0 }, null, 2))
    }
  } finally {
    for (const owned of [helperPid, pid]) if (owned && alive(owned)) process.kill(owned, 'SIGKILL')
    await bounded(operation).catch(() => {}); volume.dispose()
  }
}, 20000)
