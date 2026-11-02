import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { catalogPage, inspect, type CatalogQuery } from '../../src/catalog/common'
import { sqliteCatalog } from '../../src/catalog/sqlite'
import { catalogRows } from '../../src/catalog/paging'
import { catalogPageSchema, objectKey } from '../../src/shared/catalog'
import type { Cell } from '../../src/shared/contracts'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture(count = 215) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec(Array.from({ length: count }, (_, i) => `CREATE TABLE t${String(i).padStart(4, '0')}(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX i${i} ON t${String(i).padStart(4, '0')}(value);`).join('\n'))
  const query: CatalogQuery = async (sql, values = []) => {
    const statement = db.prepare(sql); statement.setReturnArrays(true)
    return (statement.all(...values) as unknown as unknown[][]).map(row => row.map(value => value == null ? null : String(value)))
  }
  return { db, adapter: sqliteCatalog(query) }
}
it('pages forwards and backwards without retaining or duplicating earlier rows', async () => {
  const { adapter } = fixture()
  const first = await catalogPage(adapter, { rootsOnly: true }, 'session')
  expect(first.objects).toHaveLength(100); expect(first.previous).toBeUndefined()
  const second = await catalogPage(adapter, { rootsOnly: true, cursor: { object: first.next!, direction: 'after' } }, 'session')
  const third = await catalogPage(adapter, { rootsOnly: true, cursor: { object: second.next!, direction: 'after' } }, 'session')
  expect(third.objects).toHaveLength(15); expect(third.next).toBeUndefined()
  expect(new Set([...first.objects, ...second.objects, ...third.objects].map(objectKey)).size).toBe(215)
  const back = await catalogPage(adapter, { rootsOnly: true, cursor: { object: third.previous!, direction: 'before' } }, 'session')
  expect(back.objects).toEqual(second.objects)
  const beginning = await catalogPage(adapter, { rootsOnly: true, cursor: { object: back.previous!, direction: 'before' } }, 'session')
  expect(beginning.objects).toEqual(first.objects); expect(beginning.previous).toBeUndefined()
})
it('finds and inspects beyond 2,000 objects, loads only selected children and rejects a stale identity', async () => {
  const { db, adapter } = fixture(2010)
  expect((await adapter.list()).objects.some(o => o.name === 't2009')).toBe(false)
  const page = await catalogPage(adapter, { search: 'main.t2009' }, 'session'), object = page.objects[0]
  expect(page.objects).toHaveLength(1)
  expect((await inspect(adapter, object, 'session')).detail?.definition.sql).toContain('t2009')
  const children = await catalogPage(adapter, { parent: object }, 'session')
  expect(children.objects.map(o => o.name)).toEqual(['i2009'])
  await expect(inspect(adapter, { ...object, identity: 'invalid' }, 'session')).rejects.toThrow('no longer visible')
  db.exec('DROP TABLE t2009')
  await expect(catalogPage(adapter, { parent: object }, 'session')).rejects.toThrow('parent object is no longer visible')
})
it('treats wildcard characters and quoted names literally, including attached catalogs', async () => {
  const { db, adapter } = fixture(0)
  db.exec(`CREATE TABLE "a%_!['quoted"(id INTEGER); CREATE TABLE ordinary(id INTEGER); ATTACH ':memory:' AS "other db"; CREATE TABLE "other db"."a%_!['quoted"(id INTEGER);`)
  const found = await catalogPage(adapter, { search: "%_!['" }, 'session')
  expect(found.objects).toHaveLength(2)
  expect(new Set(found.objects.map(o => o.schema))).toEqual(new Set(['main', 'other db']))
  expect((await catalogPage(adapter, { search: 'ordinary', kind: 'view' }, 'session')).objects).toEqual([])
})
it.each(['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql', 'oracle', 'sqlite', 'duckdb'] as const)('binds %s search and cursor data inside a bounded metadata query', async engine => {
  let captured = '', parameters: Cell[] = []
  await catalogRows(async (sql, values) => { captured = sql; parameters = values!; return [] }, engine,
    'SELECT catalog_name,schema_name,object_name,kind,identity_name,parent_name,signature_name,constraint_type FROM metadata', [],
    { search: "%' OR 1=1 --", limit: 100, cursor: { direction: 'after', object: { schema: 'odd schema', name: "';DROP TABLE x", kind: 'table', identity: '999' } } })
  expect(captured).not.toContain("DROP TABLE x"); expect(captured).not.toContain("OR 1=1 --")
  expect(parameters).toContain("';DROP TABLE x")
  expect(captured).toMatch(engine === 'oracle' ? /FETCH FIRST 101/ : ['sqlserver', 'azure-sql'].includes(engine) ? /TOP \(101\)/ : /LIMIT 101/)
})
it('accepts only bounded metadata requests, never renderer-selected limits or SQL', () => {
  const request = { sessionId: '00000000-0000-4000-8000-000000000001' }
  expect(catalogPageSchema.parse(request).search).toBe('')
  for (const extra of [{ limit: 100000 }, { sql: 'SELECT *' }, { search: 'x'.repeat(257) }, { search: '\0' }, { rootsOnly: 'true' }]) expect(catalogPageSchema.safeParse({ ...request, ...extra }).success).toBe(false)
})
