import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readEditorSettingsFile, writeEditorSettingsFile } from '../../src/files/editor-settings-files'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/shared/editor-settings'
import { engineSchema } from '../../src/shared/database-engines'
import { EDITOR_SETTINGS_FILE_LIMIT, parseEditorSettingsDocument, type EditorSettingsDocument } from '../../src/shared/editor-settings-files'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-settings-files-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const document = (): EditorSettingsDocument => ({ format: 'dbcommander-editor-settings', version: 1, settings: {
  ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, engineFormatting: Object.fromEntries(engineSchema.options.map((engine, index) => [engine, {
    tabSize: index + 1, insertSpaces: index % 2 === 0, formatting: { expressionWidth: 20 + index * 10, linesBetweenQueries: index % 4 }
  }]))
} })

it('round trips every engine style in a versioned preferences-only file', async () => {
  const path = join(directory, 'settings.json'), value = document()
  await writeEditorSettingsFile(path, value)
  expect(await readEditorSettingsFile(path)).toEqual(value)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(value)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(Object.keys(value)).toEqual(['format', 'version', 'settings'])
  // Settings written before engine overrides existed remain portable.
  const old = { ...value, settings: DEFAULT_EDITOR_SETTINGS }
  writeFileSync(path, '\uFEFF' + JSON.stringify(old))
  expect(await readEditorSettingsFile(path)).toEqual(old)
})

it('rejects extra data, unsupported versions and damaged settings without using workspace recovery defaults', async () => {
  const value = document(), path = join(directory, 'refused.json')
  for (const input of [null, [], { ...value, format: 'dbcommander-snippets' }, { ...value, version: 2 },
    { ...value, profiles: [] }, { ...value, sql: 'SELECT private_value' },
    { ...value, settings: { ...value.settings, password: 'never-export' } },
    { ...value, settings: { ...value.settings, fontSize: 99 } },
    { ...value, settings: { ...value.settings, engineFormatting: { unknown: {} } } },
    { ...value, settings: { ...value.settings, engineFormatting: { postgres: { tabSize: 4 } } } },
    { ...value, settings: { ...value.settings, formatting: { expressionWidth: 50, linesBetweenQueries: 1, params: ['never-export'] } } }
  ]) {
    expect(() => parseEditorSettingsDocument(input)).toThrow('Invalid editor settings file')
    await expect(writeEditorSettingsFile(path, input as EditorSettingsDocument)).rejects.toThrow('Invalid editor settings file')
    expect(readdirSync(directory)).toEqual([])
    writeFileSync(path, JSON.stringify(input))
    await expect(readEditorSettingsFile(path)).rejects.toThrow('Invalid editor settings file')
    rmSync(path)
  }
})

it('bounds input and rejects malformed JSON, non-UTF-8 and non-regular files', async () => {
  const path = join(directory, 'input.json')
  for (const text of ['', '{"settings":', Buffer.from([0xff, 0xfe, 0x7b])]) {
    writeFileSync(path, text); await expect(readEditorSettingsFile(path)).rejects.toThrow('UTF-8 JSON')
  }
  await expect(readEditorSettingsFile(directory)).rejects.toThrow()
  await expect(readEditorSettingsFile(join(directory, 'missing.json'))).rejects.toThrow()
  const fd = openSync(path, 'w'); ftruncateSync(fd, EDITOR_SETTINGS_FILE_LIMIT + 1); closeSync(fd)
  await expect(readEditorSettingsFile(path)).rejects.toThrow('64 KiB')
  writeFileSync(path, JSON.stringify(document()).padEnd(EDITOR_SETTINGS_FILE_LIMIT, ' '))
  expect(await readEditorSettingsFile(path)).toEqual(document())
})

it('publishes complete exports without overwriting files or symlinks and removes temporary files', async () => {
  const path = join(directory, 'existing.json'); writeFileSync(path, 'original')
  await expect(writeEditorSettingsFile(path, document())).rejects.toThrow('already exists')
  expect(readFileSync(path, 'utf8')).toBe('original')
  if (process.platform !== 'win32') {
    const link = join(directory, 'link.json'); symlinkSync(path, link)
    await expect(writeEditorSettingsFile(link, document())).rejects.toThrow('already exists')
    expect(readFileSync(path, 'utf8')).toBe('original')
  }
  await expect(writeEditorSettingsFile(join(directory, 'settings.sql'), document())).rejects.toThrow('.json')
  await expect(writeEditorSettingsFile(join(directory, 'missing', 'settings.json'), document())).rejects.toThrow()
  expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
})
