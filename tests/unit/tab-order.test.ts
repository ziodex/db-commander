import { expect, it } from 'vitest'
import { moveTab, dropIndex, orderPinnedTabs, setTabPinned, tabMoveBounds, tabMoveIndex } from '../../src/shared/tab-order'

it('pins and unpins by identity without changing SQL, file identity or unrelated tab objects', () => {
  const tabs = [{ id: 'a', sql: 'first' }, { id: 'b', sql: 'second' }, { id: 'c', sql: 'third' }]
  const pinned = setTabPinned(tabs, 'c', true)
  expect(pinned.map(tab => tab.id)).toEqual(['c', 'a', 'b'])
  expect(pinned[0]).toEqual({ ...tabs[2], pinned: true })
  expect(pinned[1]).toBe(tabs[0]); expect(pinned[2]).toBe(tabs[1])
  expect(tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c'])
  const two = setTabPinned(pinned, 'b', true)
  expect(two.map(tab => tab.id)).toEqual(['c', 'b', 'a'])
  const unpinned = setTabPinned(two, 'c', false)
  expect(unpinned.map(tab => tab.id)).toEqual(['b', 'c', 'a'])
  expect(unpinned[1]).toEqual({ ...tabs[2], pinned: false })
  expect(setTabPinned(two, 'b', true)).toBe(two)
  expect(setTabPinned(tabs, 'a', false)).toBe(tabs)
  expect(setTabPinned(tabs, 'missing', true)).toBe(tabs)
})

it('keeps keyboard moves and drops within each group, including all-pinned and single-tab workspaces', () => {
  const tabs = [{ id: 'a', pinned: true }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd', pinned: false }]
  expect(tabMoveBounds(tabs, 'a')).toEqual({ first: 0, last: 1 })
  expect(tabMoveBounds(tabs, 'c')).toEqual({ first: 2, last: 3 })
  expect(tabMoveBounds(tabs, 'missing')).toBeUndefined()
  expect(moveTab(tabs, 'a', 999).map(tab => tab.id)).toEqual(['b', 'a', 'c', 'd'])
  expect(moveTab(tabs, 'd', -99).map(tab => tab.id)).toEqual(['a', 'b', 'd', 'c'])
  expect(moveTab(tabs, 'b', 2)).toBe(tabs); expect(moveTab(tabs, 'c', 1)).toBe(tabs)
  expect(tabMoveIndex(tabs, 'a', Infinity)).toBe(-1)
  expect(tabMoveIndex(tabs, 'a', 0.5)).toBe(-1)
  expect(dropIndex(tabs, 'b', 'c', false)).toBe(-1)
  expect(dropIndex(tabs, 'c', 'b', true)).toBe(-1)
  expect(moveTab(tabs, 'a', dropIndex(tabs, 'a', 'b', true)).map(tab => tab.id)).toEqual(['b', 'a', 'c', 'd'])
  const all = tabs.map(tab => ({ ...tab, pinned: true }))
  expect(moveTab(all, 'a', 3).map(tab => tab.id)).toEqual(['b', 'c', 'd', 'a'])
  const one = [tabs[0]]
  expect(moveTab(one, 'a', 999)).toBe(one)
  expect(moveTab([], 'missing', 0)).toEqual([])
})

it('stably normalizes mixed saved groups without changing their contents or already grouped arrays', () => {
  const tabs = [{ id: 'a' }, { id: 'b', pinned: true }, { id: 'c', pinned: false }, { id: 'd', pinned: true }]
  const ordered = orderPinnedTabs(tabs)
  expect(ordered).toEqual([tabs[1], tabs[3], tabs[0], tabs[2]])
  expect(ordered[0]).toBe(tabs[1]); expect(ordered[3]).toBe(tabs[2])
  expect(orderPinnedTabs(ordered)).toBe(ordered)
  expect(tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c', 'd'])
})

it('keeps tab objects and identities intact while moving in both directions', () => {
  const tabs=[{id:'a',sql:'A'},{id:'b',sql:'B'},{id:'c',sql:'C'}]
  const moved=moveTab(tabs,'a',2)
  expect(moved.map(t=>t.id)).toEqual(['b','c','a']);expect(moved[2]).toBe(tabs[0]);expect(tabs.map(t=>t.id)).toEqual(['a','b','c'])
  expect(moveTab(moved,'a',0)).toEqual(tabs)
  expect(moveTab(tabs,'missing',0)).toBe(tabs);expect(moveTab(tabs,'a',0)).toBe(tabs);expect(moveTab(tabs,'b',NaN)).toBe(tabs)
  expect(moveTab(tabs,'a',999).map(t=>t.id)).toEqual(['b','c','a'])
})
it('places dragged tabs before or after the target without changing their neighbours', () => {
  const tabs=[{id:'a'},{id:'b'},{id:'c'}]
  for(const [source,target,after,expected] of [['a','c',false,'bac'],['a','c',true,'bca'],['c','a',false,'cab'],['c','a',true,'acb'],['b','b',false,'abc'],['b','b',true,'abc']] as const)
    expect(moveTab(tabs,source,dropIndex(tabs,source,target,after)).map(t=>t.id).join('')).toBe(expected)
  expect(dropIndex(tabs,'external','a',false)).toBe(-1)
})
