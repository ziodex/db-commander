import { expect, it, vi } from 'vitest'
import { oracleCatalog } from '../../src/catalog/oracle'
import { inspect } from '../../src/catalog/common'
import type { Cell } from '../../src/shared/contracts'
import type { CatalogObject } from '../../src/shared/catalog'

const object: CatalogObject = { schema: 'Owner"name', name: "view odd'", kind: 'materialized view', identity: '42' }
function fixture(metadata: Cell[][] = [['SELECT id FROM source', 'DEFERRED', 'COMPLETE', 'DEMAND', 'N']], columns: Cell[][] = [['Key"alias','NUMBER']]) {
  const query = vi.fn(async (sql: string, _values?: Cell[]): Promise<Cell[][]> => {
    if (sql.includes('FROM user_mviews')) return metadata
    if (sql.includes('FROM user_tab_cols')) return columns
    if (sql.includes('FROM user_objects')) return [[null,object.schema,object.name,object.kind,object.identity,null,null]]
    if (sql.includes('DBMS_METADATA')) throw new Error('Materialized-view inspection must not invoke the slow native XML path')
    return []
  })
  return { query, adapter: oracleCatalog(query) }
}

it('generates a quoted materialized-view summary from stored metadata, with visible omissions', async () => {
  const { adapter, query } = fixture()
  const result = await adapter.detail(object)
  expect(result.definition).toMatchObject({ source: 'generated', truncated: false })
  expect(result.definition.sql).toContain('CREATE MATERIALIZED VIEW "Owner""name"."view odd\'" ("Key""alias")\nBUILD DEFERRED\nREFRESH COMPLETE ON DEMAND\nDISABLE QUERY REWRITE\nAS\nSELECT id FROM source')
  expect(result.definition.notice).toContain('not full native DDL')
  expect(result.definition.notice).toContain('refresh schedules')
  expect(result.sections.find(s => s.title === 'Materialized view')?.rows).toEqual([['DEFERRED','COMPLETE','DEMAND','N']])
  expect(query.mock.calls.find(([sql]) => sql.includes('FROM user_mviews'))?.[1]).toEqual([object.schema,object.name])
})

it.each([
  ['IMMEDIATE','FAST','COMMIT','Y','BUILD IMMEDIATE\nREFRESH FAST ON COMMIT\nENABLE QUERY REWRITE'],
  ['PREBUILT','NEVER','NEVER','N','ON PREBUILT TABLE\nNEVER REFRESH\nDISABLE QUERY REWRITE'],
  ['IMMEDIATE','FAST','STATEMENT','N','BUILD IMMEDIATE\nREFRESH FAST ON STATEMENT\nDISABLE QUERY REWRITE']
])('preserves supported materialized-view settings: %s/%s/%s', async (build, method, mode, rewrite, expected) => {
  const { adapter } = fixture([['SELECT id FROM source',build,method,mode,rewrite]])
  expect((await adapter.detail(object)).definition.sql).toContain(expected)
})

it('keeps unknown server options as query-only summaries rather than inventing CREATE clauses', async () => {
  const { adapter } = fixture([['SELECT id FROM source','FUTURE','COMPLETE','DEMAND','N']])
  const result = await adapter.detail(object)
  expect(result.definition).toMatchObject({ source:'generated', sql:'SELECT id FROM source' })
  expect(result.definition.notice).toContain('Only the stored defining query')
})

it('does not generate incomplete column lists and retains truncation warnings', async () => {
  const { adapter } = fixture(undefined, Array.from({ length:501 }, (_,i) => ['column'+i,'NUMBER']))
  const result = await inspect(adapter, object)
  expect(result.detail?.definition).toMatchObject({ source:'generated', sql:'SELECT id FROM source', truncated:true })
})

it('marks oversized stored queries incomplete so the inspector cannot export partial SQL', async () => {
  const { adapter } = fixture([['SELECT '+ 'x'.repeat(1_000_000),'IMMEDIATE','FORCE','DEMAND','N']])
  const result = await adapter.detail(object)
  expect(result.definition.truncated).toBe(true)
  expect(result.definition.sql).toHaveLength(1_000_000)
})

it('reports missing or inaccessible metadata without retrying the native generator', async () => {
  const { adapter } = fixture([])
  expect((await adapter.detail(object)).definition.source).toBe('unavailable')
  const denied = oracleCatalog(async sql => {
    if (sql.includes('FROM user_mviews')) throw new Error('metadata access denied')
    return []
  })
  expect((await denied.detail(object)).definition).toMatchObject({ source:'unavailable', notice:'Definition unavailable: metadata access denied' })
})

it('continues to use native definitions for other Oracle objects', async () => {
  const query = vi.fn(async (sql: string) => sql.includes('DBMS_METADATA.GET_DDL') ? [['CREATE TABLE native_table (id NUMBER)']] : [])
  const result = await oracleCatalog(query).detail({ ...object, kind:'table' })
  expect(result.definition).toMatchObject({ source:'native', sql:'CREATE TABLE native_table (id NUMBER)' })
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM user_mviews'))).toBe(false)
})

it('avoids the referenced-owner dictionary join when complete local constraints prove there are no foreign keys', async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM user_constraints WHERE')) return [['pk', 'P'], ['required', 'C']]
    if (sql.includes('JOIN all_constraints')) throw new Error('No foreign keys need reference resolution')
    return []
  })
  const result = await oracleCatalog(query).detail({ ...object, kind: 'table' })
  expect(result.sections.find(s => s.title === 'Foreign keys')?.rows).toEqual([])
  expect(query.mock.calls.some(([sql]) => sql.includes('JOIN all_constraints'))).toBe(false)
})

it.each([false, true])('resolves foreign keys when present or potentially beyond the constraint preview (truncated=%s)', async truncated => {
  const constraints = truncated ? Array.from({ length: 501 }, (_, i) => ['check' + i, 'C']) : [['fk', 'R']]
  const foreign = [['fk', 'parent_id', 'OTHER_OWNER', 'parent', 'id', 'NO ACTION']]
  const query = vi.fn(async (sql: string, _values?: Cell[]) => {
    if (sql.includes('FROM user_constraints WHERE')) return constraints
    if (sql.includes('JOIN all_constraints')) return foreign
    return []
  })
  const result = await oracleCatalog(query).detail({ ...object, kind: 'table' })
  expect(result.sections.find(s => s.title === 'Foreign keys')?.rows).toEqual(foreign)
  expect(query.mock.calls.find(([sql]) => sql.includes('JOIN all_constraints'))?.[1]).toEqual([object.schema, object.name])
})

it('reuses complete local columns for ordered composite self-references, with exact owner/table/delete metadata', async () => {
  const constraints: Cell[][] = [['pk', 'P'], ['fk', 'R', null, null, null, object.schema, 'pk', 'CASCADE']]
  const keys: Cell[][] = [['fk','parent_b','1'], ['fk','parent_a','2'], ['pk','key_b','1'], ['pk','key_a','2']]
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM user_constraints WHERE')) return constraints
    if (sql.includes('FROM user_cons_columns WHERE')) return keys
    if (sql.includes('JOIN all_constraints')) throw new Error('Self-reference metadata was already fetched')
    return []
  })
  const result = await oracleCatalog(query).detail({ ...object, name: 'table odd"', kind: 'table' })
  expect(result.sections.find(s => s.title === 'Foreign keys')?.rows).toEqual([
    ['fk','parent_b',object.schema,'table odd"','key_b','CASCADE'],
    ['fk','parent_a',object.schema,'table odd"','key_a','CASCADE']
  ])
  expect(query.mock.calls.some(([sql]) => sql.includes('JOIN all_constraints'))).toBe(false)
})

it.each(['other owner', 'other table', 'incomplete positions', 'truncated keys'])('retains native reference resolution for %s', async reason => {
  const constraints: Cell[][] = [['pk', 'P'], ['fk', 'R', null, null, null, reason === 'other owner' ? 'OTHER_OWNER' : object.schema, reason === 'other table' ? 'other_pk' : 'pk', 'NO ACTION']]
  const keys: Cell[][] = reason === 'truncated keys' ? Array.from({length:501}, (_,i) => ['pk','key'+i,String(i+1)]) : [['fk','parent','1'], ['pk','id',reason === 'incomplete positions' ? '2' : '1']]
  const foreign = [['fk','parent','resolved_owner','resolved_table','resolved_key','NO ACTION']]
  const query = vi.fn(async (sql: string, _values?: Cell[]) => {
    if (sql.includes('FROM user_constraints WHERE')) return constraints
    if (sql.includes('FROM user_cons_columns WHERE')) return keys
    if (sql.includes('JOIN all_constraints')) return foreign
    return []
  })
  const result = await oracleCatalog(query).detail({ ...object, kind: 'table' })
  expect(result.sections.find(s => s.title === 'Foreign keys')?.rows).toEqual(foreign)
  expect(query.mock.calls.find(([sql]) => sql.includes('JOIN all_constraints'))?.[1]).toEqual([object.schema,object.name])
})
