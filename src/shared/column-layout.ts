import { z } from 'zod'

export const MIN_COLUMN_WIDTH = 90
export const MAX_COLUMN_WIDTH = 800
export const DEFAULT_COLUMN_WIDTH = 210
export interface ColumnLayout { order: number[]; hidden: number[]; widths: Record<number, number>; pinned: number[] }
export const defaultColumns = (count: number): ColumnLayout => ({ order: Array.from({ length: count }, (_, i) => i), hidden: [], widths: {}, pinned: [] })
export function resolveColumnLayout(count: number, stored?: ColumnLayout) {
  return stored && stored.order.length === count && new Set(stored.order).size === count && stored.order.every(index => index >= 0 && index < count) ? stored : defaultColumns(count)
}
export const visibleColumnIndices = (layout: ColumnLayout) => layout.order.filter(index => !layout.hidden.includes(index)).sort((a, b) => Number(layout.pinned.includes(b)) - Number(layout.pinned.includes(a)))

// Table browsing is bounded to 100 columns. Arbitrary result layouts remain transient.
const ordinals = z.array(z.number().int().min(0).max(99)).max(100)
export const tableColumnLayoutSchema = z.object({
  order: ordinals.min(1), hidden: ordinals, pinned: ordinals,
  widths: z.record(z.string().regex(/^(0|[1-9]\d?)$/), z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH))
}).strict().superRefine((layout, context) => {
  const count = layout.order.length
  for (const list of [layout.order, layout.hidden, layout.pinned]) {
    if (new Set(list).size !== list.length || list.some(index => index >= count)) context.addIssue({ code: 'custom', message: 'Invalid column ordinals.' })
  }
  if (layout.hidden.length >= count) context.addIssue({ code: 'custom', message: 'At least one column must be visible.' })
  if (Object.keys(layout.widths).some(index => Number(index) >= count)) context.addIssue({ code: 'custom', message: 'Invalid column width index.' })
})

/** Keep a bounded, most-recently-used set of independent layouts in each tab. */
export function withColumnView(views: Record<string, ColumnLayout> = {}, key: string, view: ColumnLayout) {
  const next = { ...views }; delete next[key]; next[key] = view
  for (const old of Object.keys(next).slice(0, -24)) delete next[old]
  return next
}
