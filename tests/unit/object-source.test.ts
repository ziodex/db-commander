import { expect, it } from 'vitest'
import { SchemaChanges } from '../../src/schema/changes'
import { schemaSql } from '../../src/schema/sql'
import type { CatalogObject, ObjectDetail } from '../../src/shared/catalog'
import type { SessionInfo } from '../../src/shared/contracts'
import type { SchemaChange } from '../../src/shared/schema-changes'
import type { Completion } from '../../src/driver/driver'

const session: SessionInfo = { id: '00000000-0000-4000-8000-000000000001', engine: 'postgres', name: 'test', database: 'test', user: 'test', host: 'localhost', port: 1, tls: false, transaction: 'idle', version: '17' }
const target: CatalogObject = { schema: 'public', name: 'items', kind: 'view', identity: '42' }
const detail: ObjectDetail = { object: target, source: 'catalog-connection', fetchedAt: '', definition: { source: 'generated', sql: 'CREATE VIEW "public"."items" AS SELECT 1 AS id' }, sections: [] }
const change: Extract<SchemaChange, { action: 'edit-source' }> = { action: 'edit-source', target, baseDefinition: detail.definition.sql!, sql: 'CREATE OR REPLACE VIEW "public"."items" AS SELECT 2 AS id;' }

it('requires the loaded definition and previews the exact reviewed declaration', () => {
  const generated = schemaSql(change, session, detail)
  expect(generated.sql).toBe('BEGIN;\n\n' + change.sql)
  expect(generated.commands).toEqual([change.sql]); expect(generated.destructive).toBe(true)
  expect(generated.warnings.join(' ')).toMatch(/generated summary/)
  expect(() => schemaSql({ ...change, baseDefinition: 'old source' }, session, detail)).toThrow(/changed since it was loaded/)
  expect(() => schemaSql(change, session, { ...detail, definition: { ...detail.definition, truncated: true } })).toThrow(/complete original definition/)
})
it('refuses extra statements, unqualified or changed targets, and disguised declarations', () => {
  for (const sql of [
    `${change.sql} DROP TABLE important;`,
    'CREATE OR REPLACE VIEW public.other AS SELECT 2',
    'CREATE OR REPLACE VIEW items AS SELECT 2',
    'CREATE TABLE other(id int); CREATE VIEW public.items AS SELECT 2',
    'CREATE TABLE other(id int) VIEW public.items AS SELECT 2'
  ]) expect(() => schemaSql({ ...change, sql }, session, detail), sql).toThrow()
})
it('refuses another SQL Server command in the same batch after a view definition', () => {
  const local = { ...session, engine: 'sqlserver' as const }, obj = { ...target, schema: 'dbo' }, source = { ...detail, object: obj, definition: { source: 'native' as const, sql: 'CREATE VIEW dbo.items AS SELECT 1 AS id' } }
  expect(() => schemaSql({ action: 'edit-source', target: obj, baseDefinition: source.definition.sql, sql: 'ALTER VIEW dbo.items AS SELECT 2 AS id; DELETE FROM important' }, local, source)).toThrow(/additional statements/)
})
it('makes SQLite replacement explicit and transactional', () => {
  const local = { ...session, engine: 'sqlite' as const }, obj = { ...target, schema: 'main' }, definition = { ...detail, object: obj, definition: { source: 'native' as const, sql: 'CREATE VIEW items AS SELECT 1 AS id' } }
  const generated = schemaSql({ action: 'edit-source', target: obj, baseDefinition: definition.definition.sql, sql: 'CREATE VIEW items AS SELECT 2 AS id' }, local, definition)
  expect(generated.commands).toEqual(['DROP VIEW "main"."items";', 'CREATE VIEW items AS SELECT 2 AS id'])
  expect(generated.begin).toBe('BEGIN IMMEDIATE'); expect(generated.warnings.join(' ')).toMatch(/triggers, permissions or grants/)
})
it('checks the parent when editing a PostgreSQL trigger', () => {
  const obj = { ...target, kind: 'trigger' as const, name: 'audit', parent: 'items' }, original = 'CREATE TRIGGER audit BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.f()'
  const trigger = { ...detail, object: obj, definition: { source: 'native' as const, sql: original } }
  const draft: Extract<SchemaChange, { action: 'edit-source' }> = { action: 'edit-source', target: obj, baseDefinition: original, sql: 'CREATE OR REPLACE TRIGGER audit BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.f()' }
  expect(schemaSql(draft, session, trigger).commands).toEqual([draft.sql])
  expect(() => schemaSql({ ...draft, sql: draft.sql.replace('public.items', 'public.other') }, session, trigger)).toThrow(/parent table/)
})
it('refuses stale or replayed reviews and never executes changed source', async () => {
  const manager = new SchemaChanges(), s = { ...session }, current = structuredClone(detail), calls: string[] = []
  const driver = { getSession: () => ({ ...s }), explore: async () => ({ detail: structuredClone(current) }) }
  const review = await manager.prepare({ sessionId: s.id, change }, driver)
  current.definition.sql = 'CREATE VIEW "public"."items" AS SELECT 99 AS id'
  const result = await manager.apply({ sessionId: s.id, planId: review.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: true }, driver, async sql => { calls.push(sql); return { status: 'completed' } as Completion })
  expect(result.status).toBe('failed'); expect(result.message).toMatch(/changed after review/); expect(calls).toEqual([])
  await expect(manager.apply({ sessionId: s.id, planId: review.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: true }, driver, async () => ({ status: 'completed' } as Completion))).rejects.toThrow(/expired/)
})
it('reports partial MySQL replacement after the reviewed drop has completed', async () => {
  const manager = new SchemaChanges(), s = { ...session, engine: 'mysql' as const }, obj = { ...target, schema: 'test', kind: 'procedure' as const }
  const existing = { ...detail, object: obj, definition: { source: 'native' as const, sql: 'CREATE PROCEDURE test.items() SELECT 1' } }
  const source: Extract<SchemaChange, { action: 'edit-source' }> = { action: 'edit-source', target: obj, baseDefinition: existing.definition.sql, sql: 'CREATE PROCEDURE test.items() SELECT 2' }
  const driver = { getSession: () => ({ ...s }), explore: async () => ({ detail: structuredClone(existing) }) }, calls: string[] = []
  const review = await manager.prepare({ sessionId: s.id, change: source }, driver)
  expect(review.transaction).toBe('implicit-commit'); expect(review.sql).toContain('DROP PROCEDURE `test`.`items`;')
  await expect(manager.apply({ sessionId: s.id, planId: review.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: true }, driver, async () => ({ status: 'completed' } as Completion))).rejects.toThrow(/implicit commit/)
  const result = await manager.apply({ sessionId: s.id, planId: review.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true }, driver, async (sql, _signal, singleUnit) => {
    expect(singleUnit).toBe(true); calls.push(sql)
    return { status: calls.length === 1 ? 'completed' : 'failed', error: 'create failed' } as Completion
  })
  expect(calls).toEqual(['DROP PROCEDURE `test`.`items`;', source.sql])
  expect(result.status).toBe('failed'); expect(result.message).toMatch(/original object may have been dropped/)
})
it('recognizes MySQL catalog declaration options without accepting extra commands', () => {
  const obj = { ...target, schema: 'test' }, mysql = { ...session, engine: 'mysql' as const }
  const old = { ...detail, object: obj, definition: { source: 'native' as const, sql: 'CREATE VIEW test.items AS SELECT 1' } }
  const source: Extract<SchemaChange, { action: 'edit-source' }> = { action: 'edit-source', target: obj, baseDefinition: old.definition.sql, sql: 'CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=`user`@`localhost` SQL SECURITY DEFINER VIEW `test`.`items` AS SELECT 2' }
  expect(schemaSql(source, mysql, old).commands).toEqual([source.sql])
  expect(() => schemaSql({ ...source, sql: source.sql.replace('VIEW `test`', 'VIEW `other`') }, mysql, old)).toThrow(/selected object/)
  expect(() => schemaSql({ ...source, sql: source.sql + '; DROP TABLE secret' }, mysql, old)).toThrow(/exactly one/)
})
