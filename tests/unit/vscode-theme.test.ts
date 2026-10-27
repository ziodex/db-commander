import { expect, it } from 'vitest'
import { vscodeDarkEditorTheme } from '../../src/renderer/themes/vscode-dark-2026'

it('preserves inherited specific SQL scopes when applying 2026 Dark rules', () => {
  const color = (token: string) => vscodeDarkEditorTheme.rules.find(rule => rule.token === token)?.foreground
  expect(color('keyword')).toBe('ff7b72')
  expect(color('string')).toBe('a5d6ff')
  expect(color('comment')).toBe('8b949e')
  // The parent theme defines these more specifically than 2026's generic
  // support/constant rules. VS Code retains their inherited colors.
  expect(color('predefined')).toBe('DCDCAA')
  expect(color('number')).toBe('b5cea8')
  expect(color('operator.word')).toBe('ff7b72')
  expect(color('operator')).toBe('d4d4d4')
})
