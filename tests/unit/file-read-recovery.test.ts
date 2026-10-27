import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readSnippetFile } from '../../src/files/snippet-files'
import { WorkspaceWindowsStore } from '../../src/main/workspace-windows'

const faults = vi.hoisted(() => ({ afterStat: undefined as (() => Promise<void>) | undefined, afterRead: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const once = async (stage: 'afterStat' | 'afterRead') => { const action = faults[stage]; faults[stage] = undefined; await action?.() }
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => { const value = await actual.stat(...args); await once('afterStat'); return value },
    readFile: async (...args: Parameters<typeof actual.readFile>) => { const value = await actual.readFile(...args); await once('afterRead'); return value },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args), stat = file.stat.bind(file), read = file.read.bind(file)
      file.stat = (async (...values: Parameters<typeof file.stat>) => { const value = await stat(...values); await once('afterStat'); return value }) as typeof file.stat
      file.read = (async (...values: any[]) => { const value = await (read as any)(...values); await once('afterRead'); return value }) as typeof file.read
      return file
    }
  }
})
afterEach(() => { faults.afterStat = undefined; faults.afterRead = undefined })
const registry = (name = 'Primary') => JSON.stringify([{ id: 'primary', name }])
const snippets = (sql = 'SELECT 1') => JSON.stringify({ format: 'dbcommander-snippets', version: 1, snippets: [{ name: 'Private fixture', description: '', sql, favorite: false }] })

for (const kind of ['snippets', 'windows'] as const) for (const change of ['shrink', 'rewrite', 'after-read', 'grow'] as const) it(`refuses ${kind} ${change} changes during the opened-file read and allows an explicit retry`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-read-recovery-')), file = join(directory, kind === 'windows' ? 'windows.json' : 'snippets.json')
  const original = kind === 'windows' ? registry() : snippets(), replacement = kind === 'windows' ? registry('Changed') : snippets('SELECT 2')
  const bytes = change === 'grow' ? replacement.padEnd(32_769, ' ') : replacement
  await writeFile(file, change === 'shrink' ? original.padEnd(4096, ' ') : original)
  const read = async () => {
    if (kind === 'snippets') return readSnippetFile(file)
    const store = new WorkspaceWindowsStore(directory); await store.load(); return store.list()
  }
  const message = kind === 'windows' ? /saved workspaces have been kept/ : /changed while reading/
  try {
    faults[change === 'after-read' ? 'afterRead' : 'afterStat'] = async () => {
      await writeFile(file, bytes)
      // A fixed, distinct mtime keeps same-size metadata changes deterministic.
      await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'))
    }
    await expect(read()).rejects.toThrow(message)
    expect(await readFile(file, 'utf8')).toBe(bytes)
    await writeFile(file, replacement)
    await expect(read()).resolves.toEqual(JSON.parse(replacement))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves invalid UTF-8 in the window registry instead of silently repairing names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'window-list-encoding-')), file = join(directory, 'windows.json')
  const bytes = Buffer.from(registry('Primary Ω')); bytes[bytes.indexOf(Buffer.from('Ω'))] = 0xff
  try {
    await writeFile(file, bytes)
    const store = new WorkspaceWindowsStore(directory)
    await expect(store.load()).rejects.toThrow('saved workspaces have been kept')
    await expect(store.create('Must not replace damaged bytes')).rejects.toThrow('saved workspaces have been kept')
    expect(await readFile(file)).toEqual(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('accepts a complete registry at its exact byte limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'window-list-limit-')), file = join(directory, 'windows.json')
  try {
    await writeFile(file, registry().padEnd(32_768, ' '))
    const store = new WorkspaceWindowsStore(directory); await store.load()
    expect(store.list()).toEqual([{ id: 'primary', name: 'Primary' }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('rejects a window registry FIFO without waiting for another process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'window-list-pipe-')), file = join(directory, 'windows.json')
  execFileSync('mkfifo', [file])
  const store = new WorkspaceWindowsStore(directory), reading = store.load()
  reading.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  try {
    const bounded = Promise.race([reading, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Window list read waited for a FIFO writer')), 1000) })])
    await expect(bounded).rejects.toThrow('saved workspaces have been kept')
    await expect(store.create('Must not replace the FIFO')).rejects.toThrow('saved workspaces have been kept')
  } finally {
    clearTimeout(timer)
    // Unblock the old reader before cleanup when running the regression baseline.
    const drain = await open(file, constants.O_RDWR | constants.O_NONBLOCK)
    await drain.writeFile('[]'); await drain.close(); await reading.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
