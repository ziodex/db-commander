import { z } from 'zod'

// A portable, bounded set avoids file, workspace, OS and editing accelerators.
export const editorShortcutSchema = z.enum(['none', 'CtrlCmd+Enter', 'CtrlCmd+Shift+Enter', 'Alt+Enter', 'CtrlCmd+Alt+Enter', 'Shift+Alt+F', 'CtrlCmd+Shift+F', 'F5', 'F8', 'F9', 'Shift+F5', 'Shift+F9'])
export type EditorShortcut = z.infer<typeof editorShortcutSchema>
export const editorShortcutsSchema = z.object({ run: editorShortcutSchema, current: editorShortcutSchema, format: editorShortcutSchema }).strict().refine(value => {
  const assigned = Object.values(value).filter(key => key !== 'none')
  return new Set(assigned).size === assigned.length
}, 'Choose a different shortcut for each action, or None.')
export type EditorShortcuts = z.infer<typeof editorShortcutsSchema>
export const DEFAULT_EDITOR_SHORTCUTS: EditorShortcuts = { run: 'CtrlCmd+Enter', current: 'CtrlCmd+Shift+Enter', format: 'Shift+Alt+F' }
export function shortcutLabel(value: EditorShortcut, mac = false) { return value === 'none' ? 'None' : value.replace('CtrlCmd', mac ? '⌘' : 'Ctrl').replace('Alt', mac ? 'Option' : 'Alt') }
