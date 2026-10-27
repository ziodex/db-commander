import { describe, expect, it } from 'vitest'
import { catalog, definition, inspect, section } from '../../src/catalog/common'
import { inspectObjectSchema, objectKey, type CatalogObject } from '../../src/shared/catalog'
import { sqliteCatalog } from '../../src/catalog/sqlite'
import type { Cell } from '../../src/shared/contracts'
import { duckdbCatalog } from '../../src/catalog/duckdb'
const object: CatalogObject = { schema: 'public', name: "odd' object", kind: 'function', identity: '123', signature: 'integer' }
describe('catalog boundaries', () => {
  it('normalizes constraint types without accepting arbitrary metadata in requests', () => {
    const snapshot = catalog(['PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'CHECK', 'DEFAULT', 'NOT NULL', 'UNKNOWN'].map((type, i) => [null,'public','key_'+i,'constraint',String(i),'orders',null,type]), '')
    expect(snapshot.objects.map(o => o.constraintType)).toEqual(['primary key','foreign key','unique','check','default','not null','other'])
    const request = { sessionId: '00000000-0000-4000-8000-000000000001', object: snapshot.objects[1] }
    expect(inspectObjectSchema.parse(request).object.constraintType).toBe('foreign key')
    expect(() => inspectObjectSchema.parse({ ...request, object: { ...request.object, constraintType: 'arbitrary SQL' } })).toThrow()
  })
  it('reconstructs missing DuckDB foreign-key clauses with quoted identifiers', async () => {
    const fk: CatalogObject = { catalog: 'memory', schema: 'main', name: 'self_fk', kind: 'constraint', parent: 'odd" table', identity: '1:0', constraintType: 'foreign key' }
    const adapter = duckdbCatalog(async sql => sql.startsWith('SELECT constraint_text,') ? [['', JSON.stringify(['parent" id','part']), 'odd" table', JSON.stringify(['id','key" part'])]] : [])
    expect((await adapter.detail(fk)).definition).toMatchObject({ source: 'generated', sql: 'FOREIGN KEY ("parent"" id", "part") REFERENCES "odd"" table" ("id", "key"" part")' })
    const incomplete = duckdbCatalog(async sql => sql.startsWith('SELECT constraint_text,') ? [['', '["a"]', 'orders', '[]']] : [])
    expect((await incomplete.detail(fk)).definition.source).toBe('unavailable')
  })
  it('keeps SQLite relations from later attached databases ahead of child metadata within one global bound', async () => {
    const calls: string[] = []
    const main: Cell[][] = Array.from({ length: 2001 }, (_, i) => [null, 'main', `child_${i}`, 'index', String(i), 'owner', null, null])
    const adapter = sqliteCatalog(async (sql, values) => {
      calls.push(sql)
      if (sql === 'PRAGMA database_list') return [['0','main'], ['2','zz_attached']]
      if (values?.[0] === 'main') return main
      return [[null,'zz_attached','visible_table','table','1',null,null,null], [null,'zz_attached','visible_view','view','2',null,null,null]]
    })
    const result = await adapter.list()
    expect(calls).toHaveLength(3)
    expect(result.objects).toHaveLength(2000); expect(result.truncated).toBe(true)
    expect(result.objects.slice(0,2).map(object => [object.schema, object.name])).toEqual([['zz_attached','visible_table'], ['zz_attached','visible_view']])
    expect(result.objects.filter(object => object.kind === 'index')).toHaveLength(1998)
  })
  it('validates a narrow object request and preserves quoted names as data', () => {
    const request = { sessionId: '00000000-0000-4000-8000-000000000001', object }
    expect(inspectObjectSchema.parse(request).object.name).toBe(object.name)
    for (const invalid of [{ ...request, sql: 'DROP TABLE x' }, { ...request, object: { ...object, kind: 'sql' } }, { ...request, object: { ...object, name: '' } }]) expect(() => inspectObjectSchema.parse(invalid)).toThrow()
  })
  it('bounds metadata, distinguishes missing definitions, and flags incomplete SQL', () => {
    expect(catalog(Array.from({ length: 2001 }, (_,i) => [null,'public',String(i),'table',String(i),null,null]), '').objects).toHaveLength(2000)
    expect(section('x',['value'],Array.from({ length: 501 },()=>['x'])).truncated).toBe(true)
    expect(section('x',['value'],[['x'.repeat(32769)]])).toMatchObject({ truncated: true })
    expect(definition(null)).toMatchObject({ source: 'unavailable', sql: null })
    expect(definition('x'.repeat(1_000_001))).toMatchObject({ truncated: true })
  })
  it('resolves canonical identities before fetching details, including overloads and parents', async () => {
    expect(objectKey(object)).not.toBe(objectKey({ ...object, identity: '124' }))
    expect(objectKey(object)).not.toBe(objectKey({ ...object, parent: 'other' }))
    let called = 0
    const adapter = { async list() { return { objects: [object], truncated: false, notice: '' } }, async detail() { called++; return { sections: [], definition: definition('SELECT 1') } } }
    await expect(inspect(adapter, { ...object, schema: 'forged' })).rejects.toThrow('no longer visible')
    expect(called).toBe(0)
    expect((await inspect(adapter, object)).detail?.object).toEqual(object); expect(called).toBe(1)
  })
  it('bounds the combined detail payload and marks generated SQL incomplete when metadata is omitted', async () => {
    const adapter = {
      async list() { return { objects: [object], truncated: false, notice: '' } },
      async detail() { return { sections: ['Columns','Indexes'].map(title => section(title, ['value'], Array.from({ length: 40 }, () => ['x'.repeat(32768)]))), definition: definition('CREATE TABLE example (id INT);', 'generated') } }
    }
    const result = (await inspect(adapter, object)).detail!
    expect(result.sections.reduce((size, section) => size + section.rows.reduce((size, row) => size + row.join('').length, 0), 0)).toBeLessThanOrEqual(2_000_000)
    expect(result.sections[0].truncated).toBe(false)
    expect(result.sections[1].truncated).toBe(true)
    expect(result.definition.truncated).toBe(true)
  })
})
