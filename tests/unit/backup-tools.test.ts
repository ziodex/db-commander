import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { runTool } from '../../src/backup/tools'
import { publishFile } from '../../src/backup/files'

const faults = vi.hoisted(() => ({ output: undefined as Writable | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => faults.output ?? actual.createWriteStream(...args) }
})
afterEach(() => { faults.output = undefined })

async function bounded<T>(promise: Promise<T>, milliseconds = 6500): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native tool did not settle within its stop deadline.')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function ready(path: string) {
  return vi.waitFor(async () => { const pid = Number(await readFile(path, 'utf8')); if (!Number.isInteger(pid) || pid < 1) throw new Error('Child not ready.'); return pid }, { timeout: 3000, interval: 20 })
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
const context = () => ({ signal: new AbortController().signal, log() {} })

describe('native backup tool stream failures and cancellation', () => {
  for (const stream of ['input', 'output'] as const) it(`reports the original missing ${stream} path instead of the termination exit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-missing-'))
    try {
      const missing = join(directory, 'missing', 'file')
      await expect(bounded(runTool({ executable: process.execPath, args: ['-e', 'process.stdin.resume();setInterval(()=>process.stdout.write("x"),10)'], [stream]: missing }, context()))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('escalates a failed output stream when the actual child ignores termination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-output-')), pidFile = join(directory, 'pid')
    const script = `process.on('SIGTERM',()=>{});process.stdout.on('error',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdout.write('backup');setInterval(()=>{},1000)`
    faults.output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('Fixture output volume full'), { code: 'ENOSPC' })) } })
    const operation = runTool({ executable: process.execPath, args: ['-e', script, pidFile], output: join(directory, 'output') }, context())
    operation.catch(() => {})
    let pid: number | undefined
    try {
      pid = await ready(pidFile)
      await expect(bounded(operation)).rejects.toMatchObject({ code: 'ENOSPC' })
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      await bounded(operation).catch(() => {}); await rm(directory, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform === 'win32')('cancels blocked input, preserves the reason and waits for a resistant child to exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-cancel-')), pidFile = join(directory, 'pid'), input = join(directory, 'input')
    await writeFile(input, Buffer.alloc(4 * 1024 * 1024, 42))
    const script = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`
    const controller = new AbortController(), operation = runTool({ executable: process.execPath, args: ['-e', script, pidFile], input }, { signal: controller.signal, log() {} })
    operation.catch(() => {})
    let pid: number | undefined
    try {
      pid = await ready(pidFile); controller.abort(new Error('Explicit backup cancellation'))
      await expect(bounded(operation)).rejects.toThrow('Explicit backup cancellation')
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      await bounded(operation).catch(() => {}); await rm(directory, { recursive: true, force: true })
    }
  })
  it('retains native diagnostics when an early tool exit also breaks its input pipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-early-')), input = join(directory, 'input')
    try {
      await writeFile(input, Buffer.alloc(4 * 1024 * 1024, 42))
      await expect(bounded(runTool({ executable: process.execPath, args: ['-e', `process.stderr.write('Fixture invalid archive');process.exitCode=2`], input }, context()))).rejects.toThrow('Fixture invalid archive')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('streams binary input and output under backpressure without losing bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-stream-')), input = join(directory, 'input'), output = join(directory, 'output'), bytes = Buffer.alloc(4 * 1024 * 1024)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
    try {
      await writeFile(input, bytes)
      await bounded(runTool({ executable: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], input, output }, context()))
      expect((await readFile(output)).equals(bytes)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('never publishes a failed native dump and permits an explicit retry to the same destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-publish-')), output = join(directory, 'snapshot'), live = context()
    try {
      await expect(bounded(publishFile(output, live, temporary => runTool({ executable: process.execPath, args: ['-e', `process.stdout.write('partial');process.stderr.write('Fixture dump failed');process.exitCode=2`], output: temporary }, live).then(() => {})))).rejects.toThrow('Fixture dump failed')
      expect(await readdir(directory)).toEqual([])
      await bounded(publishFile(output, live, temporary => runTool({ executable: process.execPath, args: ['-e', `process.stdout.write('complete')`], output: temporary }, live).then(() => {})))
      expect(await readFile(output, 'utf8')).toBe('complete')
      expect(await readdir(directory)).toEqual(['snapshot'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
