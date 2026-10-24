import { expect, it } from 'vitest'
import { editorSettingsSchema, DEFAULT_EDITOR_SETTINGS, recoverEditorSettings, resolveSqlFormatting } from '../../src/shared/editor-settings'
import { engineSchema } from '../../src/shared/database-engines'
import { DEFAULT_EDITOR_SHORTCUTS, editorShortcutsSchema, shortcutLabel } from '../../src/shared/editor-shortcuts'

it('keeps tab-close confirmation on for older settings and independently recovers the preference', () => {
  const { confirmTabClose, ...legacy } = DEFAULT_EDITOR_SETTINGS
  expect(confirmTabClose).toBe(true)
  expect(editorSettingsSchema.parse(legacy).confirmTabClose).toBeUndefined()
  expect(recoverEditorSettings(legacy).confirmTabClose).not.toBe(false)
  const disabled = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, confirmTabClose: false }
  expect(editorSettingsSchema.parse(disabled)).toEqual(disabled)
  expect(recoverEditorSettings({ ...disabled, appearance: 'bad' })).toEqual(disabled)
  expect(editorSettingsSchema.safeParse({ ...disabled, confirmTabClose: 'false' }).success).toBe(false)
  expect(recoverEditorSettings({ ...disabled, confirmTabClose: 'false' })).toEqual({ ...disabled, confirmTabClose: true })
})

it('keeps database-switch confirmation on for older settings and recovers it independently', () => {
  const { confirmDatabaseSwitch, ...legacy } = DEFAULT_EDITOR_SETTINGS
  expect(confirmDatabaseSwitch).toBe(true)
  expect(editorSettingsSchema.parse(legacy).confirmDatabaseSwitch).toBeUndefined()
  expect(recoverEditorSettings(legacy).confirmDatabaseSwitch).not.toBe(false)
  const disabled = { ...DEFAULT_EDITOR_SETTINGS, confirmTabClose: false, confirmDatabaseSwitch: false, fontSize: 18 }
  expect(editorSettingsSchema.parse(disabled)).toEqual(disabled)
  expect(recoverEditorSettings({ ...disabled, appearance: 'invalid' })).toEqual(disabled)
  expect(editorSettingsSchema.safeParse({ ...disabled, confirmDatabaseSwitch: 'false' }).success).toBe(false)
  expect(recoverEditorSettings({ ...disabled, confirmDatabaseSwitch: 'false' })).toEqual({ ...disabled, confirmDatabaseSwitch: true })
})

it('validates portable shortcuts and independently recovers appearance and keyboard preferences', () => {
  const settings = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, appearance: 'light', shortcuts: { run: 'F5', current: 'F9', format: 'CtrlCmd+Shift+F' } }
  expect(editorSettingsSchema.parse(settings)).toEqual(settings)
  expect(editorShortcutsSchema.safeParse({ run: 'F5', current: 'F5', format: 'none' }).success).toBe(false)
  expect(editorShortcutsSchema.parse({ run: 'none', current: 'none', format: 'none' })).toMatchObject({ run: 'none' })
  expect(editorShortcutsSchema.safeParse({ ...DEFAULT_EDITOR_SHORTCUTS, run: 'CtrlCmd+S' }).success).toBe(false)
  expect(recoverEditorSettings({ ...settings, shortcuts: { ...settings.shortcuts, current: 'F5' } })).toEqual({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, appearance: 'light' })
  expect(recoverEditorSettings({ ...settings, appearance: 'bad' })).toEqual({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, shortcuts: settings.shortcuts })
  expect(shortcutLabel('CtrlCmd+Enter', true)).toBe('⌘+Enter')
  expect(shortcutLabel('CtrlCmd+Enter')).toBe('Ctrl+Enter')
})

it('accepts bounded settings and rejects malformed or executable preferences', () => {
  expect(editorSettingsSchema.parse(DEFAULT_EDITOR_SETTINGS)).toEqual(DEFAULT_EDITOR_SETTINGS)
  expect(editorSettingsSchema.parse({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 32, tabSize: 8, insertSpaces: false, lineNumbers: 'relative', formatting: { expressionWidth: 200, linesBetweenQueries: 0 } })).toMatchObject({ tabSize: 8, lineNumbers: 'relative' })
  for (const patch of [
    { fontSize: 9 }, { fontSize: 33 }, { fontSize: NaN }, { fontSize: '14' },
    { tabSize: 0 }, { tabSize: 9 }, { tabSize: 2.5 }, { insertSpaces: 'yes' },
    { wordWrap: null }, { lineNumbers: 'invalid' }, { minimap: 1 }, { automaticSuggestions: null },
    { formatting: { expressionWidth: 19, linesBetweenQueries: 1 } },
    { formatting: { expressionWidth: 201, linesBetweenQueries: 1 } },
    { formatting: { expressionWidth: 50, linesBetweenQueries: 4 } },
    { formatting: { expressionWidth: 50, linesBetweenQueries: -1 } },
    { formatting: { expressionWidth: Infinity, linesBetweenQueries: 1 } },
    { formatting: { expressionWidth: 50, linesBetweenQueries: 1, params: ['replacement'] } },
    { formatOnSave: true }, { password: 'not permitted' }
  ]) expect(editorSettingsSchema.safeParse({ ...DEFAULT_EDITOR_SETTINGS, ...patch }).success, JSON.stringify(patch)).toBe(false)
})

it('inherits current defaults for unconfigured engines and keeps SQL Server and Azure styles independent', () => {
  const custom = { tabSize: 8, insertSpaces: false, formatting: { expressionWidth: 20, linesBetweenQueries: 3 } }
  const settings = editorSettingsSchema.parse({ ...DEFAULT_EDITOR_SETTINGS, engineFormatting: { sqlserver: custom } })
  settings.tabSize = 4; settings.formatting.linesBetweenQueries = 0
  for (const engine of engineSchema.options) {
    expect(resolveSqlFormatting(settings, engine)).toEqual(engine === 'sqlserver' ? custom : { tabSize: 4, insertSpaces: true, formatting: { expressionWidth: 50, linesBetweenQueries: 0 } })
  }
  // Resolving a style cannot mutate defaults or the saved override via shared references.
  resolveSqlFormatting(settings, 'sqlserver').formatting.expressionWidth = 120
  expect(settings.engineFormatting?.sqlserver).toEqual(custom)
  delete settings.engineFormatting?.sqlserver
  expect(resolveSqlFormatting(settings, 'sqlserver')).toEqual(resolveSqlFormatting(settings, 'azure-sql'))
  expect(DEFAULT_EDITOR_SETTINGS.formatting.linesBetweenQueries).toBe(1)
})

it('strictly validates overrides while disk recovery preserves other styles and global preferences', () => {
  const custom = { tabSize: 4, insertSpaces: true, formatting: { expressionWidth: 100, linesBetweenQueries: 2 } }
  const global = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18 }
  for (const malformed of [null, [], { ...custom, tabSize: 9 }, { ...custom, insertSpaces: 'tabs' },
    { ...custom, formatting: { ...custom.formatting, expressionWidth: 19 } },
    { ...custom, formatting: { ...custom.formatting, params: ['replacement'] } }, { ...custom, password: 'not accepted' }]) {
    const settings = { ...global, engineFormatting: { postgres: malformed, duckdb: custom } }
    expect(editorSettingsSchema.safeParse(settings).success).toBe(false)
    expect(recoverEditorSettings(settings)).toEqual({ ...global, engineFormatting: { duckdb: custom } })
  }
  for (const engineFormatting of [null, [], 'broken', { unknown: custom }]) {
    expect(editorSettingsSchema.safeParse({ ...global, engineFormatting }).success).toBe(false)
    expect(recoverEditorSettings({ ...global, engineFormatting })).toEqual(global)
  }
  expect(recoverEditorSettings({ ...global, engineFormatting: { unknown: custom, mysql: custom } })).toEqual({ ...global, engineFormatting: { mysql: custom } })
})
