import { describe, expect, it } from 'vitest'
import { explorerTree } from '../../src/renderer/explorer-tree'
import type { CatalogObject } from '../../src/shared/catalog'

const table: CatalogObject = { schema: 'public', name: 'orders', kind: 'table', identity: '1' }
const index: CatalogObject = { ...table, name: 'orders_idx', kind: 'index', identity: '2', parent: table.name }
const fk: CatalogObject = { ...index, kind: 'constraint', name: 'customer_fk', identity: '3', constraintType: 'foreign key' }
describe('database explorer hierarchy', () => {
  it('groups table-owned objects once, separates keys from checks, and retains standalone objects', () => {
    const pk = { ...fk, name: 'orders_pk', identity: '4', constraintType: 'primary key' as const }
    const check = { ...fk, name: 'positive_total', identity: '5', constraintType: 'check' as const }
    const trigger = { ...index, name: 'updated', kind: 'trigger' as const, identity: '6' }
    const fn = { ...table, name: 'total', kind: 'function' as const, identity: '7' }
    const [group] = explorerTree([fk, check, table, pk, trigger, fn, index], [table])
    expect(group.relations).toHaveLength(1)
    expect(group.relations[0].collections.map(c => c.title)).toEqual(['Indexes', 'Keys', 'Constraints', 'Triggers'])
    expect(group.relations[0].collections[1].objects).toEqual([fk, pk])
    expect(group.collections).toEqual([{ title: 'Functions', objects: [fn] }])
  })
  it('keeps the owning table when searching child names, subtypes, or filtering by kind', () => {
    for (const [search, kind, title] of [['customer', 'all', 'Keys'], ['foreign key', 'constraint', 'Keys'], ['', 'index', 'Indexes']]) {
      const [group] = explorerTree([table, index, fk], [], search, kind)
      expect(group.relations[0].object).toEqual(table)
      expect(group.relations[0].collections.map(c => c.title)).toEqual([title])
      expect(group.collections).toEqual([])
    }
    expect(explorerTree([table, index, fk], [], 'missing')).toEqual([])
    expect(explorerTree([table, index, fk], [], 'orders')[0].relations[0].collections).toHaveLength(2)
  })
  it('uses full catalog/schema identity, including names containing dots', () => {
    const objects = [table, index, fk].flatMap(object => [
      { ...object, catalog: 'first', schema: 'a.b' },
      { ...object, catalog: 'first.a', schema: 'b' },
      { ...object, catalog: 'second', schema: 'b' }
    ])
    const groups = explorerTree(objects, [])
    expect(groups).toHaveLength(3)
    expect(new Set(groups.map(g => g.key)).size).toBe(3)
    for (const group of groups) {
      const relation = group.relations[0]
      expect(relation.collections.flatMap(c => c.objects)).toHaveLength(2)
      expect(relation.collections.flatMap(c => c.objects).every(o => o.catalog === relation.table.catalog && o.schema === relation.table.schema)).toBe(true)
    }
  })
  it('uses schema-preview tables when catalog bounds omit parents and retains orphan objects', () => {
    const [fallback] = explorerTree([index], [table])
    expect(fallback.relations[0].object).toBeUndefined()
    expect(fallback.relations[0].collections[0].objects).toEqual([index])
    const [missing] = explorerTree([index], [])
    expect(missing.relations).toEqual([])
    expect(missing.collections[0].objects).toEqual([index])
    const [partial] = explorerTree([table], [{ ...table, name: 'extra' }])
    expect(partial.relations.map(r => r.table.name)).toEqual(['extra', 'orders'])
  })
  it('nests view indexes and triggers but does not invent ownership for standalone triggers', () => {
    const view = { ...table, kind: 'view' as const }
    const trigger = { ...index, kind: 'trigger' as const, parent: undefined }
    const [group] = explorerTree([view, index, trigger], [])
    expect(group.relations[0].collections[0].objects).toEqual([index])
    expect(group.collections[0].objects).toEqual([trigger])
  })
})
