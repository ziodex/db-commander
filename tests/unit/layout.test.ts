import { expect, it } from 'vitest'
import { DEFAULT_LAYOUT, applyLayoutCommand, clampSize, layoutSchema, panelBounds } from '../../src/shared/layout'
import { layoutCommandForInput } from '../../src/shared/layout-commands'

it('matches platform shortcuts without taking unrelated editor commands or composed input', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const input = { key: 'b', code: 'KeyB', control: platform !== 'darwin', meta: platform === 'darwin', alt: false, shift: false, isComposing: false }
    expect(layoutCommandForInput(input, platform)).toBe('toggle-sidebar')
    expect(layoutCommandForInput({ ...input, key: 'j' }, platform)).toBe('toggle-results')
    expect(layoutCommandForInput({ ...input, key: 'J', shift: true }, platform)).toBe('maximize-results')
    expect(layoutCommandForInput({ ...input, key: 'º', code: 'Digit0', alt: true }, platform)).toBe('reset-layout')
    for (const patch of [{ control: false, meta: false }, { control: true, meta: true }, { alt: true }, { shift: true }, { isComposing: true }, { key: 'p' }]) {
      expect(layoutCommandForInput({ ...input, ...patch }, platform)).toBeUndefined()
    }
  }
})

it('toggles and maximizes panels independently while retaining their preferred sizes', () => {
  const start = { ...DEFAULT_LAYOUT, sidebarWidth: 410, resultsHeight: 450 }
  const sidebarOff = applyLayoutCommand(start, 'toggle-sidebar')
  expect(sidebarOff).toEqual({ ...start, sidebarVisible: false })
  const hidden = applyLayoutCommand(sidebarOff, 'toggle-results')
  const maximized = applyLayoutCommand(hidden, 'maximize-results')
  expect(maximized).toEqual({ ...hidden, resultsVisible: true, resultsMaximized: true })
  expect(applyLayoutCommand(maximized, 'maximize-results')).toEqual({ ...sidebarOff, resultsVisible: true })
  expect(applyLayoutCommand(maximized, 'toggle-results')).toEqual(hidden)
  expect(applyLayoutCommand(hidden, 'reset-layout')).toEqual(DEFAULT_LAYOUT)
  expect(start.resultsMaximized).toBe(false)
})
it('fits large saved preferences to a smaller window without changing the preferences', () => {
  const preferred = { ...DEFAULT_LAYOUT, sidebarWidth: 600, resultsHeight: 1000 }
  const small = panelBounds(1024, 500)
  expect(clampSize(preferred.sidebarWidth, small.sidebarMin, small.sidebarMax)).toBe(409)
  expect(clampSize(preferred.resultsHeight, small.resultsMin, small.resultsMax)).toBe(334)
  const large = panelBounds(2400, 1400)
  expect(clampSize(preferred.sidebarWidth, large.sidebarMin, large.sidebarMax)).toBe(600)
  expect(clampSize(preferred.resultsHeight, large.resultsMin, large.resultsMax)).toBe(1000)
  expect(clampSize(-100, small.resultsMin, small.resultsMax)).toBe(240)
})
it('rejects malformed sizes, hidden maximized results and unexpected layout fields', () => {
  for (const patch of [{ sidebarWidth: NaN }, { sidebarWidth: 601 }, { resultsHeight: Infinity }, { resultsHeight: 0 }, { resultsHeight: 240.5 }, { resultsVisible: false, resultsMaximized: true }, { sidebarVisible: 'yes' }, { secret: 'not allowed' }]) {
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, ...patch }).success).toBe(false)
  }
})
