import { z } from 'zod'

export const MAX_EDITOR_VIEWS = 4
export const editorViewsSchema = z.object({
  orientation: z.enum(['vertical', 'horizontal']),
  tabIds: z.array(z.string().uuid()).min(2).max(MAX_EDITOR_VIEWS),
  weights: z.array(z.number().int().min(10).max(90)).min(2).max(MAX_EDITOR_VIEWS)
}).strict().refine(value => new Set(value.tabIds).size === value.tabIds.length && value.weights.length === value.tabIds.length && value.weights.reduce((a, b) => a + b, 0) === 100,
  'Editor views need unique tabs and matching sizes totaling 100 percent.')
export type EditorViews = z.infer<typeof editorViewsSchema>
export function equalViewWeights(count: number): number[] {
  return Array.from({ length: count }, (_, index) => Math.floor(100 / count) + (index < 100 % count ? 1 : 0))
}

/** Hidden tabs replace the active view; visible tabs only receive focus. */
export function reconcileEditorViews(views: EditorViews | undefined, tabIds: string[], previousActive: string, active: string): EditorViews | undefined {
  if (!views) return undefined
  const remaining = views.tabIds.filter(id => tabIds.includes(id))
  if (remaining.length < 2) return undefined
  if (!remaining.includes(active)) remaining[Math.max(0, remaining.indexOf(previousActive))] = active
  if (remaining.every((id, index) => id === views.tabIds[index]) && remaining.length === views.tabIds.length) return views
  return { ...views, tabIds: remaining, weights: remaining.length === views.tabIds.length ? views.weights : equalViewWeights(remaining.length) }
}

export function resizeEditorViews(views: EditorViews, index: number, weight: number): EditorViews {
  if (index < 0 || index >= views.weights.length - 1 || !Number.isFinite(weight)) return views
  const total = views.weights[index] + views.weights[index + 1], next = Math.max(10, Math.min(total - 10, Math.round(weight)))
  if (views.weights[index] === next) return views
  const weights = [...views.weights]; weights[index] = next; weights[index + 1] = total - next
  return { ...views, weights }
}

export function recoverEditorViews(input: unknown, tabIds: string[], active: string): EditorViews | undefined {
  const parsed = editorViewsSchema.safeParse(input)
  return parsed.success ? reconcileEditorViews(parsed.data, tabIds, active, active) : undefined
}
