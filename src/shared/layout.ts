import { z } from 'zod'
import type { LayoutCommand } from './layout-commands'
export { layoutCommands, type LayoutCommand } from './layout-commands'

export const layoutSchema = z.object({
  sidebarVisible: z.boolean(), sidebarWidth: z.number().int().min(200).max(600),
  resultsVisible: z.boolean(), resultsHeight: z.number().int().min(240).max(2160),
  resultsMaximized: z.boolean()
}).strict().refine(layout => !layout.resultsMaximized || layout.resultsVisible, { message: 'Maximized results must be visible.' })
export type WorkspaceLayout = z.infer<typeof layoutSchema>
export const DEFAULT_LAYOUT: WorkspaceLayout = { sidebarVisible: true, sidebarWidth: 234, resultsVisible: true, resultsHeight: 320, resultsMaximized: false }
export function applyLayoutCommand(layout: WorkspaceLayout, command: LayoutCommand): WorkspaceLayout {
  switch (command) {
    case 'toggle-sidebar': return { ...layout, sidebarVisible: !layout.sidebarVisible }
    case 'toggle-results': return { ...layout, resultsVisible: !layout.resultsVisible, resultsMaximized: false }
    case 'maximize-results': return { ...layout, resultsVisible: true, resultsMaximized: !layout.resultsMaximized }
    case 'reset-layout': return { ...DEFAULT_LAYOUT }
  }
}
const SPLITTER_SIZE = 6
export function clampSize(value: number, min: number, max: number) { return Math.round(Math.max(min, Math.min(max, value))) }
/** Clamp rendering to the current viewport, without changing stored preferences. */
export function panelBounds(workspaceWidth: number, panesHeight: number) {
  const sidebarMax = Math.min(600, Math.max(200, Math.floor(workspaceWidth - 49 - SPLITTER_SIZE - 560)))
  const resultsMax = Math.min(2160, Math.max(240, Math.floor(panesHeight - SPLITTER_SIZE - 160)))
  return { sidebarMin: 200, sidebarMax, resultsMin: 240, resultsMax }
}
