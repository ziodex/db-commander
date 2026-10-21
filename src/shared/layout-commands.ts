export const layoutCommands = [
  { id: 'toggle-sidebar', label: 'Toggle sidebar', accelerator: 'CommandOrControl+B', hint: 'Cmd/Ctrl+B' },
  { id: 'toggle-results', label: 'Toggle results', accelerator: 'CommandOrControl+J', hint: 'Cmd/Ctrl+J' },
  { id: 'maximize-results', label: 'Maximize / restore results', accelerator: 'CommandOrControl+Shift+J', hint: 'Cmd/Ctrl+Shift+J' },
  { id: 'reset-layout', label: 'Reset layout', accelerator: 'CommandOrControl+Alt+0', hint: 'Cmd/Ctrl+Alt+0' }
] as const
export type LayoutCommand = (typeof layoutCommands)[number]['id']
export function isLayoutCommand(value: unknown): value is LayoutCommand {
  return typeof value === 'string' && layoutCommands.some(command => command.id === value)
}

type ShortcutInput = { key: string; code: string; control: boolean; meta: boolean; alt: boolean; shift: boolean; isComposing: boolean }
export function layoutCommandForInput(input: ShortcutInput, platform: string): LayoutCommand | undefined {
  if (input.isComposing || (platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta)) return
  if (input.alt) return !input.shift && input.code === 'Digit0' ? 'reset-layout' : undefined
  const key = input.key.toLowerCase()
  if (key === 'b' && !input.shift) return 'toggle-sidebar'
  if (key === 'j') return input.shift ? 'maximize-results' : 'toggle-results'
}
