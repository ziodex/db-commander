import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { editorViewsSchema, equalViewWeights, reconcileEditorViews, recoverEditorViews, resizeEditorViews, type EditorViews } from '../../src/shared/editor-views'
import { DEFAULT_PROFILE, workspaceSchema } from '../../src/shared/contracts'

const ids = Array.from({ length: 5 }, () => randomUUID())
const views = (): EditorViews => ({ orientation: 'vertical', tabIds: ids.slice(0, 3), weights: [40, 30, 30] })
it('replaces only the active view when selecting a hidden tab, retaining slots during tab reordering', () => {
  const original = views()
  expect(reconcileEditorViews(original, ids, ids[0], ids[2])).toBe(original)
  expect(reconcileEditorViews(original, [...ids].reverse(), ids[1], ids[1])).toBe(original)
  expect(reconcileEditorViews(original, ids, ids[1], ids[3])).toEqual({ ...original, tabIds: [ids[0], ids[3], ids[2]] })
  expect(original.tabIds).toEqual(ids.slice(0, 3))
  expect(reconcileEditorViews(undefined, ids, ids[0], ids[1])).toBeUndefined()
})
it('removes closed views, repairs references during disk recovery and keeps the active tab visible', () => {
  expect(reconcileEditorViews(views(), ids.slice(1), ids[0], ids[3])).toEqual({ orientation: 'vertical', tabIds: [ids[3], ids[2]], weights: [50, 50] })
  expect(reconcileEditorViews(views(), [ids[2]], ids[0], ids[2])).toBeUndefined()
  expect(recoverEditorViews({ ...views(), weights: [99, 0, 1] }, ids, ids[0])).toBeUndefined()
  expect(recoverEditorViews(views(), ids, ids[4])?.tabIds).toEqual([ids[4], ids[1], ids[2]])
})
it('resizes adjacent views without changing other sizes or identities', () => {
  const original = views()
  expect(resizeEditorViews(original, 0, 999)).toEqual({ ...original, weights: [60, 10, 30] })
  expect(resizeEditorViews(original, 1, -9)).toEqual({ ...original, weights: [40, 10, 50] })
  expect(resizeEditorViews(original, 1, 27.8)).toEqual({ ...original, weights: [40, 28, 32] })
  expect(resizeEditorViews(original, 5, 50)).toBe(original)
  expect(resizeEditorViews(original, 0, NaN)).toBe(original)
  expect(equalViewWeights(3)).toEqual([34, 33, 33])
  expect(equalViewWeights(4)).toEqual([25, 25, 25, 25])
})
it('strictly validates view counts, weights, unique identities and workspace references', () => {
  const original = views()
  for (const value of [{ ...original, tabIds: [ids[0], ids[0], ids[2]] }, { ...original, tabIds: ids },
    { ...original, weights: [50, 50] }, { ...original, weights: [40, 30, 31] }, { ...original, weights: [40.5, 30, 29.5] },
    { ...original, extra: true }, { ...original, orientation: 'diagonal' }]) expect(editorViewsSchema.safeParse(value).success).toBe(false)
  const workspace = { version: 2, profiles: [], tabs: ids.slice(0, 3).map(id => ({ id, title: 'Query.sql', sql: 'select 1', profile: DEFAULT_PROFILE })), activeTabId: ids[0], editorViews: original }
  expect(workspaceSchema.safeParse(workspace).success).toBe(true)
  expect(workspaceSchema.safeParse({ ...workspace, editorViews: { ...original, tabIds: [ids[0], ids[1], ids[3]] } }).success).toBe(false)
  expect(workspaceSchema.safeParse({ ...workspace, editorViews: { orientation: 'vertical', tabIds: [ids[1], ids[2]], weights: [50, 50] } }).success).toBe(false)
})
