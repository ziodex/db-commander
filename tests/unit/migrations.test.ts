import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MigrationExports } from '../../src/schema/migrations'
import { writeMigrationFile } from '../../src/main/migration-file'
import { engineSchema } from '../../src/shared/contracts'
import { transactionalDdl, type SchemaChangePlan } from '../../src/shared/schema-changes'
import { prepareMigrationSchema, saveMigrationSchema } from '../../src/shared/migrations'
import type { SchemaComparison } from '../../src/shared/schema-compare'

const plan = (): SchemaChangePlan => ({ id: randomUUID(), sessionId: randomUUID(), engine: 'postgres', database: 'db', connection: 'local', sql: 'BEGIN;\nCREATE TABLE t(id INT);', transaction: 'transactional', destructive: false, warnings: ['interactive promise', 'Keep dependencies in mind.'], expiresAt: new Date(Date.now()+600000).toISOString() })
const request = (sourceId: string) => ({ sourceId, name: 'Add table', selected: ['change'], includeDestructive: false, transaction: 'caller' as const })
afterEach(() => vi.useRealTimers())
describe('migration export', () => {
  it.each(engineSchema.options)('exports canonical statements with explicit transaction handling for %s', engine => {
    const store = new MigrationExports(), review = { ...plan(), engine }, commands = ["CREATE TABLE t(value VARCHAR(30) DEFAULT 'a;--b')"]
    store.retainChange(review, commands)
    review.sql = 'DROP DATABASE altered'; commands[0] = 'DROP DATABASE altered'
    const preview = store.prepare(request(review.id))
    expect(preview.sql).toContain("CREATE TABLE t(value VARCHAR(30) DEFAULT 'a;--b');")
    expect(preview.sql).not.toContain('DROP DATABASE'); expect(preview.sql).not.toContain('interactive promise')
    expect(preview.sql).not.toMatch(/^BEGIN|^COMMIT/m); expect(preview.filename).toMatch(/^\d{17}_add_table.sql$/)
    expect(preview.sha256).toBe(createHash('sha256').update(preview.sql).digest('hex'))
    if (transactionalDdl(engine)) {
      const wrapped = store.prepare({ ...request(review.id), transaction: 'transaction' })
      expect(wrapped.sql).toMatch(engine === 'sqlite' ? /^BEGIN IMMEDIATE;$/m : ['sqlserver','azure-sql'].includes(engine) ? /^BEGIN TRANSACTION;$/m : /^BEGIN;$/m)
      expect(wrapped.sql).toMatch(/\nCOMMIT;\n$/); expect(wrapped.warnings.join(' ')).toContain('stops on the first error')
    } else {
      expect(preview.sql).toContain('commits implicitly')
      expect(() => store.prepare({ ...request(review.id), transaction: 'transaction' })).toThrow(/implicitly/)
    }
    preview.sql = 'tampered'
    expect(store.reviewed({ id: preview.id, reviewed: true, destructiveApproved: false }).sql).not.toBe('tampered')
  })
  it('rejects renderer SQL/path injection, invalid names, duplicate selection and absent review', () => {
    const input = request(randomUUID())
    for (const bad of [{ ...input, sql: 'DROP TABLE x' }, { ...input, path: '/tmp/x' }, { ...input, name: '../escape' }, { ...input, name: 'a\nb' }, { ...input, selected: ['change','change'] }, { ...input, selected: [] }]) expect(prepareMigrationSchema.safeParse(bad).success).toBe(false)
    for (const bad of [{ id: input.sourceId, reviewed: false }, { id: input.sourceId, reviewed: true, sql: 'COMMIT' }]) expect(saveMigrationSchema.safeParse(bad).success).toBe(false)
  })
  it('comments every untrusted metadata line and requires destructive acknowledgment', () => {
    const store = new MigrationExports(), p = { ...plan(), connection: 'db\rDROP DATABASE x;\u2028COMMIT;', destructive: true }
    store.retainChange(p, ['DROP TABLE t'])
    expect(() => store.prepare(request(p.id))).toThrow(/destructive/)
    const preview = store.prepare({ ...request(p.id), includeDestructive: true })
    expect(preview.sql).toContain('-- DROP DATABASE x;\n-- COMMIT; / db')
    expect(preview.destructive).toBe(true)
    expect(() => store.reviewed({ id: preview.id, reviewed: true, destructiveApproved: false })).toThrow(/Acknowledge/)
    expect(store.reviewed({ id: preview.id, reviewed: true, destructiveApproved: true }).sql).toContain('\nDROP TABLE t;')
  })
  it('expires previews, removes disconnected sources, bounds retained snapshots and file bytes', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = new MigrationExports(), p = plan(); store.retainChange(p, ['CREATE TABLE t(id INT)'])
    const preview = store.prepare(request(p.id))
    vi.setSystemTime(Date.now()+600001)
    expect(() => store.reviewed({ id: preview.id, reviewed: true, destructiveApproved: false })).toThrow(/expired/)
    const next = plan(); store.retainChange(next, ['CREATE TABLE t(id INT)']); store.forget(next.sessionId)
    expect(() => store.prepare(request(next.id))).toThrow(/closed/)
    const huge = plan(); store.retainChange(huge, [`CREATE TABLE t(value TEXT DEFAULT '${'界'.repeat(340000)}')`])
    expect(() => store.prepare(request(huge.id))).toThrow(/UTF-8 bytes/)
    for (let i=0;i<20;i++) store.retainChange(plan(), ['CREATE TABLE x(id INT)'])
    expect(() => store.prepare(request(huge.id))).toThrow(/expired/)
  })
  it('exports only selected supported comparison statements and refuses reference-only or stale selections', () => {
    const store = new MigrationExports(), comparison: SchemaComparison = { engine: 'postgres', source: { sessionId: randomUUID(), schema: 'a' }, target: { sessionId: randomUUID(), schema: 'b' }, sourceLabel: 'source', targetLabel: 'target', fetchedAt: new Date().toISOString(), notices: ['Sequential reads.'], objects: [
      { key: 'add', name: 't', kind: 'table', status: 'changed', notices: ['Other changes require manual SQL.'], sql: ['ALTER TABLE b.t ADD x INT;'], destructiveSql: [] },
      { key: 'drop', name: 'extra', kind: 'table', status: 'target-only', notices: [], sql: [], destructiveSql: ['DROP TABLE b.extra;'] },
      { key: 'reference', name: 'missing', kind: 'table', status: 'source-only', notices: [], sql: [], destructiveSql: [] }
    ] }
    const id = store.retainComparison(comparison)!
    comparison.objects[0].sql[0] = 'DROP DATABASE x;'
    const preview = store.prepare({ ...request(id), selected: ['add'] })
    expect(preview.sql).toContain('Partial schema-comparison'); expect(preview.sql).toContain('ALTER TABLE b.t ADD x INT;'); expect(preview.sql).not.toContain('DROP ')
    expect(() => store.prepare({ ...request(id), selected: ['reference'] })).toThrow(/reference definitions/)
    expect(() => store.prepare({ ...request(id), selected: ['add','missing'] })).toThrow(/selection/)
    expect(() => store.prepare({ ...request(id), selected: ['drop'] })).toThrow(/destructive/)
    const both = store.prepare({ ...request(id), selected: ['drop','add'], includeDestructive: true })
    expect(both.statements).toBe(2); expect(both.sql.indexOf('ALTER TABLE')).toBeLessThan(both.sql.indexOf('\nDROP TABLE'))
    store.forget(comparison.source.sessionId)
    expect(() => store.reviewed({ id: both.id, reviewed: true, destructiveApproved: true })).toThrow(/closed/)
  })
  it('writes exact UTF-8 bytes and refuses existing files, symlinks and non-SQL paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migration-file-'))
    try {
      const file = join(dir,'test.sql'), sql = '-- 世界\nCREATE TABLE t(id INT);\n'
      await writeMigrationFile(file, sql); expect(await readFile(file,'utf8')).toBe(sql)
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
      await expect(writeMigrationFile(file, 'replaced')).rejects.toThrow(/already exists/)
      expect(await readFile(file,'utf8')).toBe(sql)
      await expect(writeMigrationFile(join(dir,'wrong.txt'), sql)).rejects.toThrow(/.sql/)
      if (process.platform !== 'win32') {
        const link = join(dir,'link.sql'); await symlink(file,link)
        await expect(writeMigrationFile(link, 'replaced')).rejects.toThrow(/already exists/)
        expect(await readFile(file,'utf8')).toBe(sql)
      }
      await writeFile(join(dir,'sentinel'), 'preserved')
      await expect(writeMigrationFile(join(dir,'missing','file.sql'),sql)).rejects.toThrow()
      expect(await readFile(join(dir,'sentinel'),'utf8')).toBe('preserved')
    } finally { await rm(dir,{recursive:true,force:true}) }
  })
})
