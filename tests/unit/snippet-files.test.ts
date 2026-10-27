import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { WorkspaceStore } from '../../src/storage/store'
import { SnippetExchange } from '../../src/storage/snippet-exchange'
import { readSnippetFile, writeSnippetFile } from '../../src/files/snippet-files'
import { parseSnippetDocument, SNIPPET_FILE_LIMIT, type SnippetDocument, type PortableSnippet } from '../../src/shared/snippet-files'
let directory: string, store: WorkspaceStore, exchange: SnippetExchange
const snippet = (name = 'Lookup Ω', sql = "SELECT :id, 'é 😀';\n-- saved template"): PortableSnippet => ({ name, description: 'Reusable SQL', sql, engine: 'postgres', favorite: true })
const document = (snippets = [snippet()]): SnippetDocument => ({ format: 'dbcommander-snippets', version: 1, snippets })
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dbcommander-snippet-test-')); store = new WorkspaceStore(join(directory, 'workspace.sqlite')); exchange = new SnippetExchange(store) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('round trips a portable UTF-8 document and regenerates local identities on import', async () => {
  const saved = store.saveSnippet(snippet()), path = join(directory, 'snippets.json')
  const exported = exchange.export([saved.id]); expect(exported).toEqual(document())
  expect(JSON.stringify(exported)).not.toContain(saved.id); expect(JSON.stringify(exported)).not.toContain(saved.createdAt)
  await writeSnippetFile(path, exported)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(await readSnippetFile(path)).toEqual(document())
  store.deleteSnippet(saved.id)
  const review = exchange.review(await readSnippetFile(path)); expect(store.snippets()).toEqual([])
  review.snippets[0].sql = 'DELETE FROM should_not_execute'
  expect(exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'skip' })).toEqual({ imported: 1, skipped: 0 })
  const imported = store.snippets()[0]; expect(imported).toMatchObject(snippet()); expect(imported.id).not.toBe(saved.id)
  store.close(); store = new WorkspaceStore(join(directory, 'workspace.sqlite')); expect(store.snippets()).toEqual([imported])
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'copy' })).toThrow(/expired/)
})
it('reviews duplicates by normalized case-insensitive name and engine without replacing existing SQL', () => {
  const saved = store.saveSnippet(snippet('Lookup', 'SELECT 1'))
  const entries = [snippet('LOOKUP', 'SELECT 2'), snippet('Fresh'), snippet('fresh'), { ...snippet('Lookup'), engine: 'mysql' as const }]
  let review = exchange.review(document(entries))
  expect(exchange.apply({ reviewId: review.reviewId, selected: [0, 1, 2, 3], duplicates: 'skip' })).toEqual({ imported: 2, skipped: 2 })
  expect(store.snippets().find(s => s.id === saved.id)).toEqual(saved)
  review = exchange.review(document(entries))
  expect(exchange.apply({ reviewId: review.reviewId, selected: [0, 1, 2], duplicates: 'copy' })).toEqual({ imported: 3, skipped: 0 })
  expect(store.snippets().map(s => s.name)).toEqual(expect.arrayContaining(['LOOKUP (imported 2)', 'Fresh (imported 2)', 'fresh (imported 3)']))
  review = exchange.review(document([snippet('Excluded'), snippet('Chosen')]))
  exchange.apply({ reviewId: review.reviewId, selected: [1], duplicates: 'skip' })
  expect(store.snippets().some(s => s.name === 'Excluded')).toBe(false)
  const long = 'x'.repeat(100); store.saveSnippet(snippet(long)); review = exchange.review(document([snippet(long)]))
  exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'copy' }); expect(store.snippets().find(s => s.name.endsWith('(imported 2)') && s.name.startsWith('xxx'))!.name).toHaveLength(100)
})
it('refuses stale, expired, cancelled and forged reviews and selections', () => {
  let now = 1000; exchange = new SnippetExchange(store, () => now)
  let review = exchange.review(document()); store.saveSnippet(snippet('Other'))
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'skip' })).toThrow(/changed/)
  review = exchange.review(document()); now += 600000
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'skip' })).toThrow(/expired/)
  review = exchange.review(document()); exchange.discard(review.reviewId)
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'skip' })).toThrow(/expired/)
  review = exchange.review(document())
  for (const selected of [[], [0, 0], [1], [200]]) expect(() => exchange.apply({ reviewId: review.reviewId, selected, duplicates: 'skip' })).toThrow()
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0], duplicates: 'skip', snippets: [snippet()] } as never)).toThrow()
  expect(store.snippets()).toHaveLength(1)
})
it('rolls back the entire batch when storage limits or a write failure reject a later snippet', () => {
  for (let i = 0; i < 199; i++) store.saveSnippet(snippet('Existing ' + i))
  const before = store.snippets(), review = exchange.review(document([snippet('One'), snippet('Two')]))
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: [0, 1], duplicates: 'skip' })).toThrow(/200 snippets/)
  expect(store.snippets()).toEqual(before)
  for (const s of before) store.deleteSnippet(s.id)
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON snippets WHEN json_extract(NEW.value,'$.name')='Two' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END"); db.close()
  const next = exchange.review(document([snippet('One'), snippet('Two')]))
  expect(() => exchange.apply({ reviewId: next.reviewId, selected: [0, 1], duplicates: 'skip' })).toThrow(/simulated/)
  expect(store.snippets()).toEqual([])
})
it('rejects unsupported formats, identities, credentials, parameter values and oversized content', () => {
  for (const value of [[], { ...document(), version: 2 }, { ...document(), connections: [] }, document([{ ...snippet(), id: crypto.randomUUID() } as never]), document([{ ...snippet(), parameters: [{ value: 'secret' }] } as never]), document([{ ...snippet(), password: 'secret' } as never]), document([{ ...snippet(), engine: 'unknown' } as never]), document([]), document(Array.from({ length: 201 }, () => snippet())), document([snippet('Large', 'x'.repeat(100001))]), document(Array.from({ length: 51 }, () => snippet('Large', 'x'.repeat(100000))))]) expect(() => parseSnippetDocument(value)).toThrow(/Invalid snippet file/)
  const saved = store.saveSnippet(snippet()); expect(() => exchange.export([saved.id, saved.id])).toThrow(); store.deleteSnippet(saved.id); expect(() => exchange.export([saved.id])).toThrow(/no longer exists/)
})
it('rolls back imports that exceed the combined SQL budget without removing saved snippets', () => {
  store.saveSnippet(snippet('Existing', 'SELECT 1'))
  const before = store.snippets(), entries = Array.from({ length: 50 }, (_, i) => snippet('Large ' + i, 'x'.repeat(100000)))
  const review = exchange.review(document(entries))
  expect(() => exchange.apply({ reviewId: review.reviewId, selected: entries.map((_, i) => i), duplicates: 'skip' })).toThrow(/SQL budget/)
  expect(store.snippets()).toEqual(before)
})
it('reads BOM input and rejects malformed, invalid UTF-8, non-file and oversized inputs', async () => {
  const path = join(directory, 'input.json')
  writeFileSync(path, '\uFEFF' + JSON.stringify(document())); expect(await readSnippetFile(path)).toEqual(document())
  for (const data of ['{"snippets":', Buffer.from([0xff, 0xfe, 0x7b])]) { writeFileSync(path, data); await expect(readSnippetFile(path)).rejects.toThrow(/UTF-8 JSON/) }
  await expect(readSnippetFile(directory)).rejects.toThrow()
  const fd = openSync(path, 'w'); ftruncateSync(fd, SNIPPET_FILE_LIMIT + 1); closeSync(fd)
  await expect(readSnippetFile(path)).rejects.toThrow(/32 MiB/)
})
it('publishes complete exports without replacing existing files or symlinks and cleans temporary files', async () => {
  const path = join(directory, 'existing.json'); writeFileSync(path, 'original')
  await expect(writeSnippetFile(path, document())).rejects.toThrow(/already exists/); expect(readFileSync(path, 'utf8')).toBe('original')
  if (process.platform !== 'win32') { const link = join(directory, 'link.json'); symlinkSync(path, link); await expect(writeSnippetFile(link, document())).rejects.toThrow(/already exists/); expect(readFileSync(path, 'utf8')).toBe('original') }
  await expect(writeSnippetFile(join(directory, 'wrong.sql'), document())).rejects.toThrow(/.json/)
  await expect(writeSnippetFile(join(directory, 'missing', 'file.json'), document())).rejects.toThrow()
  expect(readdirSync(directory).filter(n => n.endsWith('.tmp'))).toEqual([])
})
