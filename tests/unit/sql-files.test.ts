import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqlFiles, sqlHash } from '../../src/files/sql-files'
import { openSqlFileSchema, saveSqlFileSchema } from '../../src/shared/sql-files'

const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sql-files-unit-')); directories.push(directory)
  const registry = join(directory, 'registry.json'), path = join(directory, 'query.sql'), id = randomUUID()
  const files = new SqlFiles(registry); await files.load(); await writeFile(path, 'SELECT 1;\n')
  return { files, path, id, registry, directory }
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function blockRegistry(registry: string) {
  const original = await readFile(registry, 'utf8'), backup = registry + '.original'
  await rename(registry, backup); await mkdir(registry)
  return async () => {
    await rm(registry, { recursive: true }); await rename(backup, registry)
    expect(await readFile(registry, 'utf8')).toBe(original)
  }
}
async function reload(files: SqlFiles, tabId: string) {
  const preview = await files.prepareReload(tabId)
  const file = await files.finishReload(preview.reloadId, true, [{ id: tabId, sql: preview.sql }])
  return { file: file!, sql: preview.sql }
}

describe('SQL file safety', () => {
  it('preserves a newer registry and blocks file writes without preventing buffer recovery', async () => {
    const { path, id, registry, directory } = await fixture()
    const future = JSON.stringify({ version: 2, documents: [], recent: [], futureMetadata: 'must remain intact' })
    await writeFile(registry, future)
    const files = new SqlFiles(registry); await files.load()
    await expect(files.restore([id])).rejects.toThrow('newer Db Commander version')
    const target = join(directory, 'must-not-be-created.sql')
    await expect(files.save(id, 'SELECT kept_buffer;', target)).rejects.toThrow('newer Db Commander version')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(files.open(id, path)).rejects.toThrow('newer Db Commander version')
    await expect(files.clearRecent()).rejects.toThrow('newer Db Commander version')
    await expect(files.forget(id)).rejects.toThrow('newer Db Commander version')
    expect(await readFile(registry, 'utf8')).toBe(future)
    expect((await files.check()).notice).toContain('kept intact')
    expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
  })
  it('does not retain a file association or recent entry when opening cannot persist its registry', async () => {
    const { files, path, id, registry, directory } = await fixture()
    await mkdir(registry)
    await expect(files.open(id, path)).rejects.toThrow()
    expect(files.document(id)).toBeUndefined()
    expect((await files.check()).recent).toEqual([])
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await rm(registry, { recursive: true })
    expect((await files.open(id, path)).file.tabId).toBe(id)
  })
  it.each(['forget', 'restore', 'clearRecent', 'reopen'] as const)('keeps the committed registry state when %s cannot persist', async operation => {
    const { files, path, id, registry, directory } = await fixture()
    await files.open(id, path)
    const otherPath = join(directory, 'other.sql'), other = randomUUID()
    await writeFile(otherPath, 'SELECT 2;'); await files.open(other, otherPath)
    const before = await files.check(), repair = await blockRegistry(registry)
    const act = () => operation === 'forget' ? files.forget(id) : operation === 'restore' ? files.restore([other])
      : operation === 'clearRecent' ? files.clearRecent() : files.open(randomUUID(), path)
    await expect(act()).rejects.toThrow()
    expect(await files.check()).toEqual(before)
    await repair(); await act()
    const restored = new SqlFiles(registry); await restored.load()
    expect(await restored.check()).toEqual(await files.check())
  })
  it('does not advance the reload baseline when its registry cannot be persisted', async () => {
    const { files, path, id, registry } = await fixture(); await files.open(id, path)
    const original = structuredClone(files.document(id)), repair = await blockRegistry(registry)
    await writeFile(path, 'SELECT external_change;')
    await expect(reload(files, id)).rejects.toThrow()
    expect(files.document(id)).toEqual(original)
    expect((await files.check()).files[0].external).toBe('changed')
    await repair()
    expect((await reload(files, id)).sql).toBe('SELECT external_change;')
    expect((await files.check()).files[0].external).toBe('unchanged')
  })
  it.each([false, true])('retains the previous association after a written save cannot persist (Save As: %s)', async saveAs => {
    const { files, path, id, registry, directory } = await fixture(); await files.open(id, path)
    const original = structuredClone(files.document(id)), beforeRecent = (await files.check()).recent
    const repair = await blockRegistry(registry), destination = saveAs ? join(directory, 'new.sql') : path
    await expect(files.save(id, 'SELECT kept_buffer;', saveAs ? destination : undefined)).rejects.toThrow()
    expect(await readFile(destination, 'utf8')).toBe('SELECT kept_buffer;')
    expect(files.document(id)).toEqual(original)
    expect(files.dirty(id, 'SELECT kept_buffer;')).toBe(true)
    expect((await files.check()).recent).toEqual(beforeRecent)
    if (saveAs) expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
    await repair()
    const review = await files.save(id, 'SELECT kept_buffer;', saveAs ? destination : undefined)
    if (!('conflict' in review)) throw new Error('A partially completed save requires review of the disk file.')
    expect(await files.save(id, 'SELECT kept_buffer;', saveAs ? destination : undefined, review.conflict.revision)).toHaveProperty('file')
    expect(files.dirty(id, 'SELECT kept_buffer;')).toBe(false)
    const restored = new SqlFiles(registry); await restored.load()
    expect(await restored.check()).toEqual(await files.check())
  })
  it('restores associations and saved hashes without storing SQL; duplicate open retains its owner', async () => {
    const { files, path, id, registry } = await fixture()
    await files.open(id, path)
    await writeFile(path, 'SELECT 2;')
    const reopened = await files.open(randomUUID(), path)
    expect(reopened.file.tabId).toBe(id); expect(reopened.file.external).toBe('changed')
    expect(files.dirty(id, 'SELECT 1;\n')).toBe(false)
    expect(files.dirty(id, 'SELECT private_buffer;')).toBe(true)
    const saved = await readFile(registry, 'utf8'); expect(saved).not.toContain('SELECT')
    const recovered = new SqlFiles(registry); await recovered.load()
    const state = await recovered.restore([id])
    expect(state.files[0].external).toBe('changed'); expect(state.recent).toHaveLength(1)
    expect(recovered.dirty(id, 'SELECT private_buffer;')).toBe(true)
    await recovered.restore([]); expect((await recovered.check()).files).toEqual([])
    expect((await recovered.check()).recent).toHaveLength(1)
  })
  it('saves existing files atomically and preserves UTF-8 BOM, CRLF and permissions', async () => {
    const { files, path, id, directory } = await fixture()
    await writeFile(path, '\ufeffSELECT 1;\r\n'); if (process.platform !== 'win32') await chmod(path, 0o640)
    await files.open(id, path)
    expect(files.dirty(id, 'SELECT 1;\n')).toBe(false)
    expect(await files.save(id, "SELECT '日本語';\n")).toHaveProperty('file')
    expect(await readFile(path, 'utf8')).toBe("\ufeffSELECT '日本語';\r\n")
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(files.dirty(id, "SELECT '日本語';\n")).toBe(false)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('requires review of external changes and revalidates the reviewed revision', async () => {
    const { files, path, id } = await fixture(); await files.open(id, path)
    await writeFile(path, 'SELECT 2;\n')
    const conflict = await files.save(id, 'SELECT 99;\n'); expect(conflict).toHaveProperty('conflict')
    if (!('conflict' in conflict)) throw new Error('Expected conflict')
    expect(await readFile(path, 'utf8')).toBe('SELECT 2;\n')
    await writeFile(path, 'SELECT 3;\n')
    const again = await files.save(id, 'SELECT 99;\n', undefined, conflict.conflict.revision)
    expect(again).toHaveProperty('conflict'); expect(await readFile(path, 'utf8')).toBe('SELECT 3;\n')
    if (!('conflict' in again)) throw new Error('Expected new conflict')
    expect(await files.save(id, 'SELECT 99;\n', undefined, again.conflict.revision)).toHaveProperty('file')
    expect(await readFile(path, 'utf8')).toBe('SELECT 99;\n')
  })
  it('Save As preserves the original, reviews existing destinations and rejects another open file', async () => {
    const { files, path, id, directory } = await fixture(); await files.open(id, path)
    const target = join(directory, 'destination.sql'); await writeFile(target, 'SELECT 20;')
    const conflict = await files.save(id, 'SELECT 30;', target)
    if (!('conflict' in conflict)) throw new Error('Expected conflict')
    expect(await files.save(id, 'SELECT 30;', target, conflict.conflict.revision)).toHaveProperty('file')
    expect(files.document(id)?.path).toBe(await realpath(target)); expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
    const other = randomUUID(); await files.open(other, path)
    await expect(files.save(other, 'SELECT 40;', target)).rejects.toThrow(/another tab/)
    expect(await readFile(target, 'utf8')).toBe('SELECT 30;')
  })
  it('detects replacement and deletion; only explicit Save As recreates a removed file', async () => {
    const { files, path, id, directory } = await fixture(); await files.open(id, path)
    const replacement = join(directory, 'replacement.sql'); await writeFile(replacement, 'SELECT 1;\n'); await rename(replacement, path)
    expect((await files.check()).files[0].external).toBe('changed')
    await unlink(path); expect((await files.check()).files[0].external).toBe('missing')
    await expect(files.save(id, 'SELECT 2;')).rejects.toThrow(/Save As/)
    await expect(reload(files, id)).rejects.toThrow()
    expect(await files.save(id, 'SELECT 2;', path)).toHaveProperty('file')
    expect(await readFile(path, 'utf8')).toBe('SELECT 2;')
    expect((await files.check()).files[0].external).toBe('unchanged')
    expect(await files.save(id, 'SELECT 3;')).toHaveProperty('file')
  })
  it('reload advances the baseline without changing the tab identity', async () => {
    const { files, path, id } = await fixture(); await files.open(id, path); await writeFile(path, 'SELECT 5;')
    const loaded = await reload(files, id)
    expect(loaded.sql).toBe('SELECT 5;'); expect(loaded.file.tabId).toBe(id)
    expect(loaded.file.savedHash).toBe(sqlHash('SELECT 5;'))
    expect(files.dirty(id, 'SELECT 6;')).toBe(true)
  })
  it.each([Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from('SELECT\0'), Buffer.from('x'.repeat(1_000_001))])('rejects unsupported input without retaining an association', async data => {
    const { files, path, id } = await fixture(); await writeFile(path, data)
    await expect(files.open(id, path)).rejects.toThrow()
    expect((await files.check()).files).toHaveLength(0)
    // Native byte equality avoids walking a million individual Buffer entries.
    expect((await readFile(path)).equals(data)).toBe(true)
  })
  it('refuses symlink replacement and hardlinked writes', async () => {
    const { files, path, id, directory } = await fixture(); await files.open(id, path)
    const target = join(directory, 'target.sql'); await writeFile(target, 'SELECT protected;')
    await unlink(path)
    if (process.platform !== 'win32') {
      await symlink(target, path)
      await expect(files.save(id, 'SELECT overwritten;')).rejects.toThrow(/symbolic/)
      expect((await files.check()).files[0].external).toBe('unavailable')
      await unlink(path)
    }
    await link(target, path)
    const review = await files.save(id, 'SELECT overwritten;')
    if (!('conflict' in review)) throw new Error('Expected conflict')
    await expect(files.save(id, 'SELECT overwritten;', undefined, review.conflict.revision)).rejects.toThrow(/hard links/)
    expect(await readFile(target, 'utf8')).toBe('SELECT protected;')
  })
  it('bounds recent files, rejects unknown IDs and clears history without deleting files', async () => {
    const { files, directory, id, path } = await fixture()
    for (let index = 0; index < 22; index++) {
      const next = join(directory, `${index}.sql`); await writeFile(next, 'SELECT 1;')
      await files.open(id, next); await files.forget(id)
    }
    const recent = (await files.check()).recent
    expect(recent).toHaveLength(20); expect(recent[0].name).toBe('21.sql')
    expect(() => files.recentPath(randomUUID())).toThrow(/no longer registered/)
    expect(files.recentPath(recent[0].id)).toBe(recent[0].path)
    await files.clearRecent(); expect((await files.check()).recent).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
  })
  it('fails safely for corrupt registry and path-bearing renderer requests', async () => {
    const { registry, id } = await fixture(); await writeFile(registry, '{broken')
    const files = new SqlFiles(registry); await files.load(); const state = await files.restore([id])
    expect(state.notice).toContain('Recovered SQL buffers are intact'); expect(state.files).toEqual([])
    expect(openSqlFileSchema.safeParse({ tabId: id, path: '/arbitrary' }).success).toBe(false)
    expect(saveSqlFileSchema.safeParse({ tabId: id, sql: 'SELECT 1;', path: '/arbitrary' }).success).toBe(false)
  })
  it('SQL definition exports cannot overwrite a file associated with another tab', async () => {
    const { files, path, id, directory } = await fixture(); await files.open(id, path)
    await expect(files.save(randomUUID(), 'SELECT export;', path, undefined, false)).rejects.toThrow(/another tab/)
    const target = join(directory, 'export.sql')
    expect(await files.save(randomUUID(), 'SELECT export;', target, undefined, false)).toHaveProperty('file')
    expect((await files.check()).files).toHaveLength(1)
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not replace a read-only file or leave temporary SQL behind', async () => {
    const { files, path, id, directory } = await fixture(); await files.open(id, path)
    await chmod(path, 0o400)
    // chmod is itself an external metadata change; explicitly review it first.
    const review = await files.save(id, 'SELECT forbidden;')
    if (!('conflict' in review)) throw new Error('Expected conflict')
    await expect(files.save(id, 'SELECT forbidden;', undefined, review.conflict.revision)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
    expect(files.dirty(id, 'SELECT forbidden;')).toBe(true)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await chmod(path, 0o600)
  })
})
