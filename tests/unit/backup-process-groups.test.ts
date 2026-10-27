import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { runTool } from '../../src/backup/tools'
import { publishFile } from '../../src/backup/files'

const faults = vi.hoisted(() => ({ output: undefined as Writable | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => faults.output ?? actual.createWriteStream(...args) }
})
afterEach(() => { faults.output = undefined })

for (const persistent of [false, true]) it.skipIf(process.platform !== 'darwin')(`native backup process group: ${persistent ? 'persistent permission errors remain explicit' : 'a transient zombie EPERM preserves the native diagnostic'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-tool-reaping-')), input = join(directory, 'input')
  await writeFile(input, Buffer.alloc(4 * 1024 * 1024, 42))
  const kill = process.kill.bind(process)
  let injected = false
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && (persistent || !injected)) { injected = true; throw Object.assign(new Error('Fixture group permission error'), { code: 'EPERM' }) }
    return kill(pid, signal)
  })
  try {
    await expect(bounded(runTool({ executable: process.execPath, args: ['-e', "process.stderr.write('Fixture invalid archive');process.exitCode=2"], input }, { signal: new AbortController().signal, log() {} }))).rejects.toThrow(persistent ? 'Could not stop the native tool process group' : 'Fixture invalid archive')
    expect(injected).toBe(true)
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }) }
})

function alive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
async function ready(file: string) {
  return vi.waitFor(async () => { const pid = Number(await readFile(file, 'utf8')); if (!Number.isInteger(pid) || pid < 1) throw new Error('Fixture not ready'); return pid }, { timeout: 3000, interval: 20 })
}
async function bounded<T>(operation: Promise<T>) {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Tool helpers did not stop within the deadline')), 6500) })]) }
  finally { clearTimeout(timer) }
}
const helper = `process.on('SIGTERM',()=>{});process.stdout.on('error',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`
const parent = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)},process.argv[2]],{stdio:process.argv[3]==='no-pipes'?'ignore':['ignore','inherit','inherit']});fs.writeFileSync(process.argv[1],String(process.pid));const wait=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(wait);if(process.argv[3]==='exited')process.exit(0);if(process.argv[3]==='output')process.stdout.write('partial backup')}},5);setInterval(()=>{},1000)`

for (const mode of ['running', 'exited', 'no-pipes', 'output'] as const) it.skipIf(process.platform === 'win32')(`native backup process group: ${mode} helpers stop before failed-output cleanup`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-tool-group-')), parentFile = join(directory, 'parent'), helperFile = join(directory, 'helper'), destination = join(directory, 'snapshot')
  const controller = new AbortController(), context = { signal: controller.signal, log() {} }
  // A separate process outside the tool's group must survive its cancellation.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  if (mode === 'output') faults.output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('Fixture output full'), { code: 'ENOSPC' })) } })
  const operation = publishFile(destination, context, temporary => runTool({ executable: process.execPath, args: ['-e', parent, parentFile, helperFile, mode], output: temporary }, context).then(() => {}))
  operation.catch(() => {})
  let parentPid: number | undefined, helperPid: number | undefined
  try {
    parentPid = await ready(parentFile); helperPid = await ready(helperFile)
    if (mode === 'exited') await vi.waitFor(() => expect(alive(parentPid!)).toBe(false), { timeout: 3000, interval: 20 })
    if (mode !== 'output') controller.abort(new Error('Reviewed cancellation with helper'))
    if (mode === 'output') await expect(bounded(operation)).rejects.toMatchObject({ code: 'ENOSPC' })
    else await expect(bounded(operation)).rejects.toThrow('Reviewed cancellation with helper')
    await vi.waitFor(() => expect(alive(helperPid!)).toBe(false), { timeout: 1000, interval: 20 })
    expect(alive(parentPid)).toBe(false)
    expect(bystander.pid && alive(bystander.pid)).toBe(true)
    expect((await readdir(directory)).sort()).toEqual(['helper', 'parent'])
    if (mode === 'output') {
      faults.output = undefined
      const retry = { signal: new AbortController().signal, log() {} }
      await bounded(publishFile(destination, retry, temporary => runTool({ executable: process.execPath, args: ['-e', "process.stdout.write('complete')"], output: temporary }, retry).then(() => {})))
      expect(await readFile(destination, 'utf8')).toBe('complete')
    }
  } finally {
    for (const pid of [helperPid, parentPid, bystander.pid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    await bounded(operation).catch(() => {}); await rm(directory, { recursive: true, force: true })
  }
})
