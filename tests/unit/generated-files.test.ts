import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeMigrationFile } from '../../src/main/migration-file'
import { writeGeneratedFile } from '../../src/main/generated-file'

const fault = vi.hoisted(() => ({ stage: '' as 'write' | 'sync' | 'close' | '', onWrite: undefined as (() => void | Promise<void>) | undefined, publication: false }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => { if (fault.publication) throw new Error('Fixture publication failed'); return actual.rename(...args) },
    link: async (...args: Parameters<typeof actual.link>) => { if (fault.publication) throw new Error('Fixture publication failed'); return actual.link(...args) },
    open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args)
    if (args[1] !== 'wx') return file
    const write = file.writeFile.bind(file), sync = file.sync.bind(file), close = file.close.bind(file)
    file.writeFile = async (...values) => { await fault.onWrite?.(); if (fault.stage === 'write') { await write('partial'); throw Object.assign(new Error('Fixture write full'), { code: 'ENOSPC' }) } return write(...values) }
    file.sync = async () => { if (fault.stage === 'sync') throw new Error('Fixture sync failed'); return sync() }
    file.close = async () => { await close(); if (fault.stage === 'close') { fault.stage = ''; throw new Error('Fixture close failed') } }
    return file
  } }
})
afterEach(() => { fault.stage = ''; fault.onWrite = undefined; fault.publication = false })

it('keeps a migration destination absent until its complete contents are closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-publish-')), target = join(directory, 'migration.sql')
  let visible = false
  try {
    fault.onWrite = () => { visible = existsSync(target) }
    await writeMigrationFile(target, '-- reviewed Ω\nSELECT 1;\n')
    expect(visible).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('-- reviewed Ω\nSELECT 1;\n')
    expect(await readdir(directory)).toEqual(['migration.sql'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
for (const stage of ['write', 'sync', 'close'] as const) it(`does not publish a migration after ${stage} failure and allows explicit retry`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-failure-')), target = join(directory, 'migration.sql')
  try {
    fault.stage = stage
    await expect(writeMigrationFile(target, '-- complete migration')).rejects.toThrow(/Fixture/)
    expect(await readdir(directory)).toEqual([])
    fault.stage = ''; await writeMigrationFile(target, '-- complete migration')
    expect(await readFile(target, 'utf8')).toBe('-- complete migration')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('preserves a destination created while a migration is being written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-race-')), target = join(directory, 'migration.sql')
  try {
    fault.onWrite = () => writeFile(target, 'concurrent file')
    await expect(writeMigrationFile(target, '-- generated migration')).rejects.toThrow(/already exists/)
    expect(await readFile(target, 'utf8')).toBe('concurrent file')
    expect(await readdir(directory)).toEqual(['migration.sql'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const stage of ['write', 'sync', 'close'] as const) it(`preserves an existing generated file after ${stage} failure and permits explicit retry`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-replace-')), target = join(directory, 'saved.txt')
  try {
    await writeFile(target, 'prior Ω')
    fault.stage = stage
    await expect(writeGeneratedFile(target, 'complete replacement', { replace: true })).rejects.toThrow(/Fixture/)
    expect(await readFile(target, 'utf8')).toBe('prior Ω')
    expect(await readdir(directory)).toEqual(['saved.txt'])
    fault.stage = ''; await writeGeneratedFile(target, 'complete replacement', { replace: true })
    expect(await readFile(target, 'utf8')).toBe('complete replacement')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const replace of [false, true]) it(`retains the prior destination state when publication fails (replace: ${replace})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-publication-')), target = join(directory, 'saved.txt')
  try {
    if (replace) await writeFile(target, 'prior')
    fault.publication = true
    await expect(writeGeneratedFile(target, 'new contents', { replace })).rejects.toThrow('publication failed')
    expect(await readdir(directory)).toEqual(replace ? ['saved.txt'] : [])
    if (replace) expect(await readFile(target, 'utf8')).toBe('prior')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves a replacement made by another writer while output is being prepared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-race-')), target = join(directory, 'saved.txt'), previous = join(directory, 'previous.txt')
  try {
    await writeFile(target, 'prior')
    fault.onWrite = async () => { await rename(target, previous); await writeFile(target, 'other writer') }
    await expect(writeGeneratedFile(target, 'generated output', { replace: true })).rejects.toThrow('destination changed')
    expect(await readFile(target, 'utf8')).toBe('other writer')
    expect(await readFile(previous, 'utf8')).toBe('prior')
    expect(await readdir(directory)).toEqual(['previous.txt', 'saved.txt'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('publishes private complete UTF-8 files and refuses existing files and directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-private-')), target = join(directory, 'saved.json'), folder = join(directory, 'folder')
  try {
    await writeGeneratedFile(target, '{"value":"Ω"}\n')
    expect(await readFile(target, 'utf8')).toBe('{"value":"Ω"}\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
    await expect(writeGeneratedFile(target, 'replaced')).rejects.toMatchObject({ code: 'EEXIST' })
    await mkdir(folder)
    await expect(writeGeneratedFile(folder, 'replaced', { replace: true })).rejects.toThrow('regular file')
    expect(await readdir(folder)).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('refuses to follow or replace destination symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-link-')), target = join(directory, 'saved.txt'), link = join(directory, 'link.txt')
  try {
    await writeFile(target, 'keep'); await symlink(target, link)
    await expect(writeGeneratedFile(link, 'replaced')).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(writeGeneratedFile(link, 'replaced', { replace: true })).rejects.toThrow('regular file')
    expect(await readFile(target, 'utf8')).toBe('keep')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('respects a read-only destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-readonly-')), target = join(directory, 'saved.txt')
  try {
    await writeFile(target, 'keep'); await chmod(target, 0o400)
    await expect(writeGeneratedFile(target, 'replaced', { replace: true })).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(target, 'utf8')).toBe('keep')
  } finally { await chmod(target, 0o600).catch(() => {}); await rm(directory, { recursive: true, force: true }) }
})
