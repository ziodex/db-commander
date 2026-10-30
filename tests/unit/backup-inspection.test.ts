import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectBackup } from '../../src/backup/inspection'
import { inspectBackupFile, inspectNewBackupFile } from '../../src/backup/file-inspection'
import { inspectNativeTool } from '../../src/backup/native-tool'
import { DesktopSettings } from '../../src/main/desktop-settings'
import { DEFAULT_PROFILE } from '../../src/shared/contracts'
import type { BackupRequest } from '../../src/shared/backup'

const context = () => ({ signal: new AbortController().signal, log() {} })
const request = (file: string, extra: Partial<BackupRequest> = {}): BackupRequest => ({ sessionId: randomUUID(), action: 'backup', artifact: file, content: 'all', confirmed: true, ...extra })

it('checks a new local destination without publishing a file, and rejects collisions without changing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-inspection-')), file = join(root, 'new.sqlite')
  try {
    const config = { ...DEFAULT_PROFILE, engine: 'sqlite' as const, password: '' }
    expect(await inspectBackup(config, request(file), context())).toMatchObject({ ready: true, checks: [{ label: 'New backup destination', status: 'passed' }] })
    expect(await readdir(root)).toEqual([])
    await writeFile(file, 'existing backup')
    const check = await inspectBackup(config, request(file), context())
    expect(check.ready).toBe(false); expect(check.checks[0].detail).toMatch(/already exists/)
    expect(await readFile(file, 'utf8')).toBe('existing backup')
    await expect(inspectNewBackupFile(join(root, 'missing', 'new.sqlite'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('inspects bounded local restore metadata, distinguishes header recognition from integrity validation, and preserves both files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-inspection-')), file = join(root, 'source.sqlite'), target = join(root, 'restored.sqlite')
  try {
    const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)])
    await writeFile(file, bytes)
    const config = { ...DEFAULT_PROFILE, engine: 'sqlite' as const, password: '' }
    const check = await inspectBackup(config, request(file, { action: 'restore', target }), context())
    expect(check.ready).toBe(true); expect(check.metadata.some(item => item.label === 'File size')).toBe(true)
    expect(check.checks.some(item => item.status === 'warning' && /integrity validation/.test(item.detail))).toBe(true)
    expect(await readdir(root)).toEqual(['source.sqlite'])
    await writeFile(target, 'keep target')
    expect((await inspectBackup(config, request(file, { action: 'restore', target }), context())).ready).toBe(false)
    expect(await readFile(file)).toEqual(bytes); expect(await readFile(target, 'utf8')).toBe('keep target')
    await writeFile(file, 'not a backup')
    const invalid = await inspectBackup(config, request(file, { action: 'restore', target }), context())
    expect(invalid.ready).toBe(false)
    expect(invalid.checks.some(item => item.status === 'warning' && /header matches/.test(item.detail))).toBe(false)
    await expect(inspectBackupFile('sqlite', request(file))).rejects.toThrow(/SQLite/)
    await expect(inspectBackupFile('duckdb', request(file))).rejects.toThrow(/DuckDB/)
    await expect(inspectBackupFile('postgres', request(file))).rejects.toThrow(/PostgreSQL/)
    await mkdir(join(root, 'folder'))
    await expect(inspectBackupFile('sqlite', request(join(root, 'folder')))).rejects.toThrow(/regular/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('refuses symbolic-link artifacts while allowing an existing aliased destination folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-inspection-link-'))
  try {
    await mkdir(join(root, 'folder')); await symlink(join(root, 'folder'), join(root, 'alias'))
    await inspectNewBackupFile(join(root, 'alias', 'new.sqlite'))
    await writeFile(join(root, 'original'), 'original'); await symlink(join(root, 'original'), join(root, 'linked'))
    await expect(inspectBackupFile('sqlite', request(join(root, 'linked')))).rejects.toThrow(/symbolic link/)
    await expect(inspectNewBackupFile(join(root, 'linked'))).rejects.toThrow(/already exists/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('recognizes only matching metadata in MySQL/MariaDB dump headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-inspection-dump-')), file = join(root, 'dump.sql')
  try {
    await writeFile(file, '-- Db Commander {"engine":"mysql","version":"9.5.0","content":"schema"}\nnot executed SQL')
    expect(await inspectBackupFile('mysql', request(file))).toContainEqual({ label: 'Contents', value: 'Schema only' })
    await expect(inspectBackupFile('mariadb', request(file))).rejects.toThrow(/compatible/)
    expect(await readFile(file, 'utf8')).toContain('not executed SQL')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('discovers the exact client tool without a shell and refuses a mismatched engine', async () => {
  const commands: unknown[] = []
  const tool = await inspectNativeTool('postgres', request(join(tmpdir(), 'archive'), { action: 'restore', target: 'new' }), context(), { runTool: async command => { commands.push(command); return 'pg_restore (PostgreSQL) 18.0' } })
  expect(tool).toMatchObject({ executable: 'pg_restore', major: 18 }); expect(commands).toEqual([{ executable: 'pg_restore', args: ['--version'] }])
  await expect(inspectNativeTool('mysql', request('unused'), context(), { runTool: async () => 'mariadb-dump from 12.0.2-MariaDB' })).rejects.toThrow(/does not match/)
  await expect(inspectNativeTool('postgres', request('unused', { toolDirectory: 'relative' }), context(), {})).rejects.toThrow(/absolute/)
})

it('remembers only per-engine folder metadata and serializes concurrent saves with existing application settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-folders-'))
  try {
    const settings = new DesktopSettings(root)
    await Promise.all([settings.rememberBackupDirectory('sqlite', 'backup', join(root, 'one')), settings.rememberBackupDirectory('postgres', 'tools', join(root, 'two')), settings.setMinimizeToTray(true)])
    const reopened = new DesktopSettings(root); await reopened.load()
    expect(reopened.minimizeToTray).toBe(true)
    expect(reopened.backupDirectory('sqlite', 'backup')).toBe(join(root, 'one'))
    expect(reopened.backupDirectory('postgres', 'tools')).toBe(join(root, 'two'))
    expect(reopened.backupDirectory('duckdb', 'backup')).toBeUndefined()
    expect(JSON.parse(await readFile(join(root, 'desktop-settings.json'), 'utf8')).backupLocations).toHaveLength(2)
    expect(() => reopened.rememberBackupDirectory('sqlite', 'restore', 'relative')).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
