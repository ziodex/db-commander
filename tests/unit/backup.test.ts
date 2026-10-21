import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, symlink, stat, readdir, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { publishFile } from '../../src/backup/files'
import { runTool } from '../../src/backup/tools'
import { backupRequestSchema } from '../../src/shared/backup'
import { BackupJournal } from '../../src/backup/journal'

describe('backup boundaries and native process lifecycle', () => {
  it('requires an explicit confirmation, new restore target and bounded inputs', () => {
    const request = { sessionId: randomUUID(), action: 'restore', artifact: '/tmp/file', content: 'all' }
    expect(backupRequestSchema.safeParse(request).success).toBe(false)
    expect(backupRequestSchema.safeParse({ ...request, confirmed: true }).success).toBe(false)
    expect(backupRequestSchema.safeParse({ ...request, confirmed: true, target: 'new' }).success).toBe(true)
    expect(backupRequestSchema.safeParse({ ...request, confirmed: true, target: 'new\nname' }).success).toBe(false)
    expect(backupRequestSchema.safeParse({ ...request, confirmed: true, target: 'new', password: 'secret' }).success).toBe(false)
  })
  it('publishes private files only after success, refuses symlinks and concurrent destinations, cleans partial work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-files-')), target = join(directory, 'snapshot'), controller = new AbortController()
    const context = { signal: controller.signal, log() {} }
    try {
      await expect(publishFile(target, context, async path => { await writeFile(path, 'partial'); throw new Error('disk error') })).rejects.toThrow('disk error')
      expect(await readdir(directory)).toEqual([])
      await expect(publishFile(target, context, async path => { await writeFile(path, 'snapshot'); await writeFile(target, 'raced') })).rejects.toThrow('EEXIST')
      expect(await readFile(target, 'utf8')).toBe('raced'); await rm(target)
      if (process.platform !== 'win32') {
        await symlink(join(directory, 'missing'), target)
        await expect(publishFile(target, context, async () => {})).rejects.toThrow('already exists'); await rm(target)
      }
      await publishFile(target, context, path => writeFile(path, 'snapshot'))
      expect(await readFile(target, 'utf8')).toBe('snapshot')
      if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
      await expect(publishFile(target, context, async () => {})).rejects.toThrow('already exists')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('streams a binary backup and input without a shell or argument interpolation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-tool-')), output = join(directory, 'output')
    const context = { signal: new AbortController().signal, log() {} }
    try {
      await runTool({ executable: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([0,255,10,42]))'], output }, context)
      expect(await readFile(output)).toEqual(Buffer.from([0, 255, 10, 42]))
      expect(await runTool({ executable: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], input: output }, context)).toContain('*')
      await expect(runTool({ executable: join(directory, 'missing-tool'), args: [] }, context)).rejects.toThrow('Install the native client tools')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('cancels native processes and rejects nonzero exits with bounded diagnostics', async () => {
    const controller = new AbortController(), context = { signal: controller.signal, log() {} }
    const running = runTool({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, context)
    setTimeout(() => controller.abort(), 50)
    await expect(running).rejects.toThrow()
    const live = { signal: new AbortController().signal, log() {} }
    await expect(runTool({ executable: process.execPath, args: ['-e', "process.stderr.write('x'.repeat(50000)+' failed');process.exitCode=2"] }, live)).rejects.toThrow(/failed/)
  })
  it('recovers interrupted jobs as unknown and never replays them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-journal-')), journal = new BackupJournal(join(directory, 'jobs.json'))
    try {
      await journal.save([{ id: randomUUID(), sessionId: randomUUID(), engine: 'postgres', action: 'restore', database: 'source', artifact: '/backup', target: 'new', status: 'running', startedAt: new Date().toISOString(), phase: 'Restoring', log: [] }])
      expect(await journal.load()).toMatchObject([{ status: 'unknown', target: 'new' }])
      await writeFile(join(directory, 'jobs.json'), 'invalid json')
      expect(await journal.load()).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  for (const contents of ['invalid json', JSON.stringify({ version: 2, jobs: [] }), ' '.repeat(4_000_001)]) it(`preserves unreadable job history (${contents.length} bytes) instead of replacing it`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-journal-protection-')), file = join(directory, 'jobs.json')
    try {
      await writeFile(file, contents)
      const journal = new BackupJournal(file)
      expect(await journal.load()).toEqual([])
      await expect(journal.save([])).rejects.toThrow(/kept intact/)
      expect(await readFile(file, 'utf8')).toBe(contents)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('recovers after publication failure without deleting an interrupted temporary journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-journal-retry-')), file = join(directory, 'jobs.json'), interrupted = file + '.tmp'
    const journal = new BackupJournal(file)
    try {
      await journal.load(); await journal.save([])
      await writeFile(interrupted, 'Unconfirmed interrupted job metadata')
      await rename(file, file + '.committed'); await mkdir(file)
      await expect(journal.save([])).rejects.toThrow()
      await expect(journal.flush()).rejects.toThrow()
      expect(await readdir(directory)).toEqual(expect.arrayContaining(['jobs.json', 'jobs.json.committed', 'jobs.json.tmp']))
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual(['jobs.json.tmp'])
      await rm(file, { recursive: true }); await rename(file + '.committed', file)
      await journal.save([]); await journal.flush()
      expect(await journal.load()).toEqual([])
      expect(await readFile(interrupted, 'utf8')).toBe('Unconfirmed interrupted job metadata')
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('does not follow or replace a journal symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-journal-link-')), file = join(directory, 'jobs.json'), target = join(directory, 'target.json')
    try {
      await writeFile(target, '[]'); await symlink(target, file)
      const journal = new BackupJournal(file)
      expect(await journal.load()).toEqual([])
      await expect(journal.save([])).rejects.toThrow('kept intact')
      expect(await readFile(target, 'utf8')).toBe('[]')
      expect(await readdir(directory)).toEqual(['jobs.json', 'target.json'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
