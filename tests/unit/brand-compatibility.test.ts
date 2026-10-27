import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applicationProfile } from '../../src/main/application-profile'
import { parseSnippetDocument } from '../../src/shared/snippet-files'
import { parseEditorSettingsDocument } from '../../src/shared/editor-settings-files'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/shared/editor-settings'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function appData() {
  const path = mkdtempSync(join(tmpdir(), 'dbcommander-brand-'))
  directories.push(path)
  return path
}

it('uses the new profile on a fresh install and preserves an existing profile in place', () => {
  const path = appData(), current = join(path, 'Db Commander'), legacy = join(path, 'SQLCommander')
  expect(applicationProfile(path)).toEqual({ directory: current, lockFolder: 'SQLCommander Profile Locks' })
  mkdirSync(legacy)
  expect(applicationProfile(path)).toEqual({ directory: legacy, lockFolder: 'SQLCommander Profile Locks' })
  mkdirSync(current)
  expect(applicationProfile(path).directory).toBe(current)
  expect(applicationProfile(path, current)).toEqual(applicationProfile(path))
})

it('preserves explicit profile paths and their existing cross-version lock namespace', () => {
  const path = appData(), override = join(path, 'custom-workspace')
  expect(applicationProfile(path, override)).toEqual({ directory: override, lockFolder: 'SQLCommander Profile Locks' })
})

it('imports legacy snippet exports and normalizes their format for future exports', () => {
  const snippets = [{ name: 'Saved query', description: '', sql: 'SELECT 1', favorite: false }]
  const current = { format: 'dbcommander-snippets', version: 1, snippets }
  expect(parseSnippetDocument({ ...current, format: 'sqlcommander-snippets' })).toEqual(current)
  expect(() => parseSnippetDocument({ ...current, format: 'other-app-snippets' })).toThrow('Invalid snippet file')
})

it('imports legacy editor settings without relaxing validation', () => {
  const current = { format: 'dbcommander-editor-settings', version: 1, settings: DEFAULT_EDITOR_SETTINGS }
  expect(parseEditorSettingsDocument({ ...current, format: 'sqlcommander-editor-settings' })).toEqual(current)
  expect(() => parseEditorSettingsDocument({ ...current, format: 'sqlcommander-editor-settings', unexpected: true })).toThrow('Invalid editor settings file')
})
