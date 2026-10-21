import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishFile } from '../../src/backup/files'
import { exportResultCsv } from '../../src/driver/driver'
import { exportFile } from '../../src/transfer/export'
import type { ResultSet } from '../../src/shared/contracts'

const fault = vi.hoisted(() => ({ stage: '' as '' | 'write' | 'sync' | 'publish' | 'abort-sync' | 'abort-publish', controller: undefined as AbortController | undefined, fired: false,
  close: '' as '' | 'writer' | 'sync', cleanup: false, closeFired: false, cleanupFired: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string) => Object.assign(new Error(`Injected ${code} file failure`), { code })
  return { ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const file = await fs.open(...args)
      if (!String(args[0]).includes('.dbcommander-backup-')) return file
      return new Proxy(file, { get(target, key) {
        if (key === 'close' && fault.close === (args[1] === 'wx' ? 'writer' : 'sync')) return async () => {
          fault.closeFired = true; await target.close(); throw fail('close EIO')
        }
        if (key === 'writeFile' && fault.stage === 'write') return async () => { fault.fired = true; await target.writeFile('partial bytes'); throw fail('ENOSPC') }
        if (key === 'sync' && ['sync', 'abort-sync'].includes(fault.stage)) return async () => {
          fault.fired = true
          if (fault.stage === 'sync') throw fail('EIO')
          await target.sync(); fault.controller!.abort(new Error('Cancelled while syncing'))
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    },
    async rm(...args: Parameters<typeof fs.rm>) {
      if (fault.cleanup && String(args[0]).includes('.dbcommander-backup-')) { fault.cleanupFired = true; throw fail('EBUSY cleanup') }
      return fs.rm(...args)
    },
    async link(...args: Parameters<typeof fs.link>) {
      if (fault.stage === 'publish') { fault.fired = true; throw fail('EIO') }
      const linked = await fs.link(...args)
      if (fault.stage === 'abort-publish') { fault.fired = true; fault.controller!.abort(new Error('Cancelled after publication')) }
      return linked
    }
  }
})

let directory: string
const result: ResultSet = { index: 0, statement: 'SELECT fixture', columns: [{ name: 'value', typeId: 0 }, { name: 'other', typeId: 0 }],
  rows: [['9223372036854775807', null], ['', 'comma,"\r\nΩ']], rowCount: null, command: 'SELECT', truncated: false }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dbcommander-publication-')); fault.stage = ''; fault.controller = undefined; fault.fired = false
  fault.close = ''; fault.cleanup = false; fault.closeFired = false; fault.cleanupFired = false })
afterEach(async () => { fault.stage = ''; fault.close = ''; fault.cleanup = false; await rm(directory, { recursive: true, force: true }) })

async function streamed(file: string, controller = new AbortController()) {
  await exportFile({ action: 'export', sessionId: 'fixture', file, sql: 'SELECT fixture', format: 'csv', confirmed: true }, { signal: controller.signal, progress() {} }, async consume => {
    await consume({ type: 'result', sessionId: 'fixture', queryId: 'fixture', result })
    await consume({ type: 'rows', sessionId: 'fixture', queryId: 'fixture', index: 0, rows: result.rows })
  })
}

it('refuses existing preview destinations and symlinks without changing their bytes or the cached result', async () => {
  const file = join(directory, 'existing.csv'), before = structuredClone(result)
  await writeFile(file, 'keep existing bytes')
  await expect(exportResultCsv(result, file)).rejects.toThrow('already exists')
  expect(await readFile(file, 'utf8')).toBe('keep existing bytes')
  if (process.platform !== 'win32') {
    const alias = join(directory, 'alias.csv'); await symlink(file, alias)
    await expect(exportResultCsv(result, alias)).rejects.toThrow('already exists')
    expect(await readFile(file, 'utf8')).toBe('keep existing bytes')
  }
  expect(result).toEqual(before)
})

for (const mode of ['preview', 'streamed'] as const) it.each(['write', 'sync', 'publish'] as const)(`cleans failed ${mode} exports at %s and allows an explicit retry`, async stage => {
  const file = join(directory, 'output.csv'), before = structuredClone(result)
  fault.stage = stage
  await expect(mode === 'preview' ? exportResultCsv(result, file) : streamed(file)).rejects.toThrow(stage === 'write' ? 'ENOSPC' : 'EIO')
  expect(fault.fired).toBe(true); expect(await readdir(directory)).toEqual([]); expect(result).toEqual(before)
  fault.stage = ''
  await (mode === 'preview' ? exportResultCsv(result, file) : streamed(file))
  expect(await readFile(file, 'utf8')).toBe(`"value","other"\r\n"9223372036854775807",${mode === 'preview' ? '' : '\\N'}\r\n"","comma,""\r\nΩ"\r\n`)
  expect(await readdir(directory)).toEqual(['output.csv']); expect(result).toEqual(before)
})

it('honors cancellation during the final sync before publishing a completed file', async () => {
  const file = join(directory, 'cancelled.csv'), controller = new AbortController()
  fault.stage = 'abort-sync'; fault.controller = controller
  await expect(streamed(file, controller)).rejects.toThrow('Cancelled while syncing')
  expect(fault.fired).toBe(true); expect(await readdir(directory)).toEqual([])
})

it('keeps a completed file when atomic publication wins the cancellation race', async () => {
  const file = join(directory, 'completed.csv'), controller = new AbortController()
  fault.stage = 'abort-publish'; fault.controller = controller
  await streamed(file, controller)
  expect(fault.fired).toBe(true); expect(controller.signal.aborted).toBe(true)
  expect(await readFile(file, 'utf8')).toContain('9223372036854775807')
  expect(await readdir(directory)).toEqual(['completed.csv'])
})

it('keeps concurrent destinations intact and does not run unavailable preview exports', async () => {
  const file = join(directory, 'raced.csv')
  await expect(publishFile(file, { signal: new AbortController().signal, log() {} }, async temporary => {
    await writeFile(temporary, 'new'); await writeFile(file, 'created while exporting')
  })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(file, 'utf8')).toBe('created while exporting')
  const missing = join(directory, 'missing.csv')
  await expect(exportResultCsv(undefined, missing)).rejects.toThrow('no longer available')
  expect(await readdir(directory)).toEqual(['raced.csv'])
})

for (const mode of ['preview', 'streamed'] as const) {
  const exported = (file: string) => mode === 'preview' ? exportResultCsv(result, file) : streamed(file)
  for (const close of ['writer', 'sync'] as const) it(`does not publish ${mode} output after a ${close} close error and permits an explicit retry`, async () => {
    const file = join(directory, 'output.csv')
    fault.close = close
    await expect(exported(file)).rejects.toThrow('close EIO')
    expect(fault.closeFired).toBe(true); expect(await readdir(directory)).toEqual([])
    fault.close = ''; await exported(file)
    expect(await readFile(file, 'utf8')).toContain('9223372036854775807')
  })
  for (const stage of ['write', 'sync'] as const) it(`preserves the primary ${mode} ${stage} error when close and cleanup also fail`, async () => {
    const file = join(directory, 'failed.csv')
    fault.stage = stage; fault.close = stage === 'write' ? 'writer' : 'sync'; fault.cleanup = true
    await expect(exported(file)).rejects.toThrow(stage === 'write' ? 'ENOSPC' : 'Injected EIO file failure')
    expect(fault.fired && fault.closeFired && fault.cleanupFired).toBe(true)
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it(`keeps a completed ${mode} export successful after cleanup failure without permitting replacement`, async () => {
    const file = join(directory, 'completed.csv')
    fault.cleanup = true
    await exported(file)
    expect(fault.cleanupFired).toBe(true)
    const saved = await readFile(file, 'utf8')
    expect(saved).toContain('9223372036854775807')
    await expect(exported(file)).rejects.toThrow('already exists')
    expect(await readFile(file, 'utf8')).toBe(saved)
  })
}

it('preserves a query error when streamed export closure and cleanup also fail', async () => {
  const file = join(directory, 'failed.csv'), cause = new Error('Fixture query failed')
  fault.close = 'writer'; fault.cleanup = true
  await expect(exportFile({ action: 'export', sessionId: 'fixture', file, sql: 'SELECT fixture', format: 'csv', confirmed: true },
    { signal: new AbortController().signal, progress() {} }, async () => { throw cause })).rejects.toBe(cause)
  expect(fault.closeFired && fault.cleanupFired).toBe(true)
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves cancellation during sync when closure, cleanup and warning delivery also fail', async () => {
  const file = join(directory, 'cancelled.csv'), controller = new AbortController()
  fault.stage = 'abort-sync'; fault.controller = controller; fault.close = 'sync'; fault.cleanup = true
  await expect(publishFile(file, { signal: controller.signal, log() { throw new Error('Fixture notification failed') } },
    temporary => writeFile(temporary, 'complete'))).rejects.toThrow('Cancelled while syncing')
  expect(fault.fired && fault.closeFired && fault.cleanupFired).toBe(true)
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports retained temporary files without letting warning delivery change a completed outcome', async () => {
  const messages: string[] = [], file = join(directory, 'completed.backup')
  fault.cleanup = true
  await publishFile(file, { signal: new AbortController().signal, log(message) { messages.push(message); throw new Error('Fixture notification failed') } },
    temporary => writeFile(temporary, 'complete'))
  expect(messages).toHaveLength(1)
  const scratch = (await readdir(directory)).find(name => name.startsWith('.dbcommander-backup-'))!
  expect(messages[0]).toContain(join(directory, scratch))
  expect(messages[0]).toMatch(/temporary.*could not be removed/i)
  expect(await readFile(file, 'utf8')).toBe('complete')
})
