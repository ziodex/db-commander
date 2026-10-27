import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SqlFiles, sqlHash } from '../../src/files/sql-files'

const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sql-reload-unit-')); directories.push(directory)
  const registry = join(directory, 'registry.json'), path = join(directory, 'query.sql'), id = randomUUID(), files = new SqlFiles(registry)
  await files.load(); await writeFile(path, 'SELECT baseline;'); await files.open(id, path)
  const before = await readFile(registry), previous = structuredClone(files.document(id))
  await writeFile(path, 'SELECT snapshot;')
  return { files, registry, path, id, before, previous }
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

it('keeps a preview and a rejected reload from advancing the saved baseline', async () => {
  const { files, registry, id, before, previous } = await fixture(), preview = await files.prepareReload(id)
  expect(preview.sql).toBe('SELECT snapshot;'); expect(files.document(id)).toEqual(previous)
  expect(await readFile(registry)).toEqual(before)
  expect(await files.finishReload(preview.reloadId, false)).toBeNull()
  await expect(files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])).rejects.toThrow('expired')
  expect(files.document(id)).toEqual(previous); expect(await readFile(registry)).toEqual(before)
})

it('records only the accepted saved snapshot and still reviews later external changes', async () => {
  const { files, registry, path, id } = await fixture(), preview = await files.prepareReload(id)
  await writeFile(path, 'SELECT later_external;')
  const file = await files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])
  expect(file?.savedHash).toBe(sqlHash(preview.sql))
  expect((await files.check()).files[0].external).toBe('changed')
  expect(await files.save(id, preview.sql)).toHaveProperty('conflict')
  expect(await readFile(path, 'utf8')).toBe('SELECT later_external;')
  const reopened = new SqlFiles(registry); await reopened.load()
  expect(reopened.document(id)?.savedHash).toBe(sqlHash(preview.sql))
})

for (const saved of ['missing', 'different'] as const) it(`refuses acceptance when the persisted buffer is ${saved}`, async () => {
  const { files, registry, id, before, previous } = await fixture(), preview = await files.prepareReload(id)
  await expect(files.finishReload(preview.reloadId, true, saved === 'missing' ? [] : [{ id, sql: 'SELECT other_buffer;' }])).rejects.toThrow('buffer was not saved')
  expect(files.document(id)).toEqual(previous); expect(await readFile(registry)).toEqual(before)
})

it('refuses a preview after its original association was removed', async () => {
  const { files, registry, id } = await fixture(), preview = await files.prepareReload(id)
  await files.forget(id); const after = await readFile(registry)
  await expect(files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])).rejects.toThrow('association changed')
  expect(await readFile(registry)).toEqual(after); expect(files.document(id)).toBeUndefined()
})

it('bounds previews to one expiring token and rejects forged or superseded acceptances', async () => {
  const { files, registry, id, before } = await fixture()
  const first = await files.prepareReload(id), current = await files.prepareReload(id), saved = [{ id, sql: current.sql }]
  await expect(files.finishReload(first.reloadId, true, saved)).rejects.toThrow('expired')
  await expect(files.finishReload(randomUUID(), true, saved)).rejects.toThrow('expired')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 300_001)
  await expect(files.finishReload(current.reloadId, true, saved)).rejects.toThrow('expired')
  expect(await readFile(registry)).toEqual(before)
})

it('keeps the committed baseline after failed publication and requires a fresh explicit retry', async () => {
  const { files, registry, id, before, previous } = await fixture(), preview = await files.prepareReload(id)
  await rename(registry, registry + '.original'); await mkdir(registry)
  await expect(files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])).rejects.toThrow()
  expect(files.document(id)).toEqual(previous)
  await rm(registry, { recursive: true }); await rename(registry + '.original', registry)
  expect(await readFile(registry)).toEqual(before)
  await expect(files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])).rejects.toThrow('expired')
  const retried = await files.prepareReload(id)
  expect(await files.finishReload(retried.reloadId, true, [{ id, sql: retried.sql }])).toMatchObject({ savedHash: sqlHash(retried.sql) })
})

it('invalidates an earlier preview if a new read fails', async () => {
  const { files, path, id } = await fixture(), preview = await files.prepareReload(id)
  await unlink(path); await expect(files.prepareReload(id)).rejects.toThrow()
  await expect(files.finishReload(preview.reloadId, true, [{ id, sql: preview.sql }])).rejects.toThrow('expired')
})
