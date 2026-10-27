import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, workspaceSchema, type Workspace } from '../../src/shared/contracts'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/shared/editor-settings'
import { defaultColumns } from '../../src/shared/column-layout'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dbcommander-unit-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function workspace(sql = 'SELECT 42'): Workspace {
  const id = randomUUID(), second = randomUUID(), profileId = randomUUID()
  return { version: 2, activeTabId: second, profiles: [{ id: profileId, config: DEFAULT_PROFILE }], tabs: [
    { id, title: 'First.sql', sql, profile: DEFAULT_PROFILE, profileId }, { id: second, title: 'Second.sql', sql: 'SELECT 2', profile: DEFAULT_PROFILE, profileId }
  ] }
}
it('restores saved table layouts without requiring them in older workspaces and rejects invalid writes', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT preserved_sql')
  const entry = { key: 'connection/table', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }], layout: { order: [1, 0], hidden: [0], pinned: [1], widths: { 1: 330 } } }
  let store = new WorkspaceStore(path)
  store.save(value); expect(store.load()).toEqual(value)
  store.save({ ...value, tableLayouts: [entry] }); store.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, tableLayouts: [entry] })
  expect(() => store.save({ ...value, tableLayouts: [{ ...entry, layout: { ...entry.layout, hidden: [0, 1] } }] })).toThrow()
  expect(store.load()?.tableLayouts).toEqual([entry])
  store.close()
})
it('recovers valid table preferences independently without discarding buffers or other settings', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT layout_recovery')
  const entry = { key: 'valid', columns: [{ name: 'id', type: 'INTEGER' }], layout: defaultColumns(1) }
  let store = new WorkspaceStore(path); store.save(value); store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, editorSettings: DEFAULT_EDITOR_SETTINGS,
    tableLayouts: [entry, { ...entry, key: 'invalid', layout: { ...entry.layout, widths: { 0: -1 } } }] }))
  db.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, editorSettings: DEFAULT_EDITOR_SETTINGS, tableLayouts: [entry] })
  store.close()
})
it('restores ordered buffers, active tab, profiles and bindings across restart', () => {
  let store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  const value = workspace("SELECT 'unfinished work'")
  store.save(value); store.close()
  store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  expect(store.load()).toEqual(value); store.close()
})
it('persists pinning in stable groups with the same active tab and accepts older unpinned records', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace()
  let store = new WorkspaceStore(path)
  store.save(value); expect(store.load()).toEqual(value)
  const pinned = { ...value.tabs[1], pinned: true }
  store.save({ ...value, tabs: [value.tabs[0], pinned] }); store.close()
  store = new WorkspaceStore(path)
  const expected = { ...value, tabs: [pinned, value.tabs[0]] }
  expect(store.load()).toEqual(expected)
  for (const invalid of ['true', 1, null, { pinned: true }]) {
    expect(() => store.save({ ...value, tabs: [{ ...value.tabs[0], pinned: invalid }, value.tabs[1]] } as Workspace)).toThrow()
    expect(store.load()).toEqual(expected)
  }
  store.close()
})
it('recovers pin preferences from disk without relaxing SQL or identity validation', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT preserved_buffer')
  let store = new WorkspaceStore(path); store.save(value); store.close()
  for (const invalid of ['true', null, { unexpected: 'value' }]) {
    const db = new DatabaseSync(path)
    db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, tabs: [
      { ...value.tabs[0], pinned: invalid }, { ...value.tabs[1], pinned: true }
    ] })); db.close()
    store = new WorkspaceStore(path)
    expect(store.load()).toEqual({ ...value, tabs: [{ ...value.tabs[1], pinned: true }, value.tabs[0]] })
    store.close()
  }
  const db = new DatabaseSync(path)
  db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, tabs: [
    { ...value.tabs[0], pinned: 'broken', sql: null }, value.tabs[1]
  ] })); db.close()
  store = new WorkspaceStore(path)
  expect(() => store.load()).toThrow(); store.close()
})
it('bounds query history and clears it without losing tabs or profiles', () => {
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite')), value = workspace()
  store.save(value)
  for (let index = 0; index < 505; index++) store.addHistory({ id: String(index), connection: 'test', sql: `SELECT ${index}`, status: 'completed', startedAt: new Date(index * 1000).toISOString(), durationMs: 1 })
  expect(store.history()).toHaveLength(100); expect(store.history()[0].sql).toBe('SELECT 504')
  store.clearHistory(); expect(store.history()).toEqual([]); expect(store.load()).toEqual(value); store.close()
})
it('migrates v1 with a consistent backup, preserves history and is idempotent', () => {
  const path = join(directory, 'workspace.sqlite'), original = { sql: 'SELECT legacy', profile: DEFAULT_PROFILE }
  const old = new DatabaseSync(path)
  old.exec('PRAGMA journal_mode=WAL; CREATE TABLE workspace(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE history(id TEXT PRIMARY KEY, connection TEXT, sql TEXT, status TEXT, startedAt TEXT, durationMs INTEGER); PRAGMA user_version=1')
  old.prepare('INSERT INTO workspace VALUES(1,?)').run(JSON.stringify(original))
  old.exec("INSERT INTO history VALUES('old','legacy','SELECT 1','completed','2026-01-01',1)")
  // Leave WAL open during migration: the backup must include its committed data.
  let store = new WorkspaceStore(path)
  const restored = store.load()!
  expect(restored.tabs[0]).toMatchObject({ sql: original.sql, profile: DEFAULT_PROFILE, profileId: restored.profiles[0].id })
  expect(restored.activeTabId).toBe(restored.tabs[0].id); expect(store.history()[0].id).toBe('old')
  store.close(); old.close()
  const backups = readdirSync(directory).filter(name => name.includes('v1-backup'))
  expect(backups).toHaveLength(1)
  const backup = new DatabaseSync(join(directory, backups[0]))
  expect(JSON.parse(String(backup.prepare('SELECT value FROM workspace').get()!.value))).toEqual(original)
  expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(1); backup.close()
  store = new WorkspaceStore(path); expect(store.load()).toEqual(restored); store.close()
  expect(readdirSync(directory).filter(name => name.includes('v1-backup'))).toHaveLength(1)
})
it('leaves invalid legacy data and newer workspace versions untouched', () => {
  for (const [version, value] of [[1, '{broken'], [99, '{}']] as const) {
    const path = join(directory, `version-${version}.sqlite`), db = new DatabaseSync(path)
    db.exec(`CREATE TABLE workspace(id INTEGER PRIMARY KEY, value TEXT); PRAGMA user_version=${version}`)
    db.prepare('INSERT INTO workspace VALUES(1,?)').run(value); db.close()
    expect(() => new WorkspaceStore(path)).toThrow()
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(version)
    expect(check.prepare('SELECT value FROM workspace').get()!.value).toBe(value); check.close()
  }
})
it('rejects credentials, live state, duplicate IDs, dangling profiles and invalid active tabs without overwriting saved work', () => {
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite')), value = workspace()
  store.save(value)
  const invalid = [
    { ...value, profiles: [{ ...value.profiles[0], config: { ...DEFAULT_PROFILE, password: 'secret' } }] },
    { ...value, tabs: [{ ...value.tabs[0], profile: { ...DEFAULT_PROFILE, accessToken: 'secret' } }] },
    { ...value, tabs: [{ ...value.tabs[0], session: { id: randomUUID() } }] },
    { ...value, activeTabId: randomUUID() }, { ...value, tabs: [value.tabs[0], value.tabs[0]] },
    { ...value, profiles: [] }, { ...value, profiles: [value.profiles[0], value.profiles[0]] },
    { ...value, tabs: Array.from({ length: 21 }, () => ({ ...value.tabs[0], id: randomUUID() })) }
  ]
  for (const candidate of invalid) { expect(workspaceSchema.safeParse(candidate).success).toBe(false); expect(() => store.save(candidate as Workspace)).toThrow(); expect(store.load()).toEqual(value) }
  store.close()
})

it('persists layout with the workspace while accepting older v2 records without layout', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace()
  let store = new WorkspaceStore(path)
  store.save(value); expect(store.load()).toEqual(value)
  const layout = { sidebarVisible: false, sidebarWidth: 450, resultsVisible: true, resultsHeight: 500, resultsMaximized: true }
  store.save({ ...value, layout }); store.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, layout })
  expect(() => store.save({ ...value, layout: { ...layout, resultsHeight: -1 } })).toThrow()
  expect(store.load()?.layout).toEqual(layout)
  store.close()
})
it('recovers damaged layout preferences without discarding SQL buffers or profiles', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT important_buffer')
  let store = new WorkspaceStore(path); store.save(value); store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, layout: { sidebarWidth: 'broken' } })); db.close()
  store = new WorkspaceStore(path)
  const recovered = store.load()!
  expect(recovered.tabs).toEqual(value.tabs); expect(recovered.profiles).toEqual(value.profiles)
  expect(recovered.layout).toEqual({ sidebarVisible: true, sidebarWidth: 234, resultsVisible: true, resultsHeight: 320, resultsMaximized: false })
  store.close()
})

it('persists editor preferences with SQL and rejects invalid writes without replacing saved work', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT settings_buffer')
  let store = new WorkspaceStore(path)
  store.save(value); expect(store.load()).toEqual(value) // Existing v2 records need no migration.
  const editorSettings = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, insertSpaces: false, formatting: { expressionWidth: 80, linesBetweenQueries: 2 },
    engineFormatting: { postgres: { tabSize: 4, insertSpaces: true, formatting: { expressionWidth: 20, linesBetweenQueries: 0 } } } }
  store.save({ ...value, editorSettings }); store.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, editorSettings })
  for (const patch of [{ fontSize: 0 }, { formatting: { expressionWidth: 80, linesBetweenQueries: 1000 } }, { password: 'not persisted' },
    { engineFormatting: { postgres: { tabSize: 0, insertSpaces: true, formatting: { expressionWidth: 50, linesBetweenQueries: 0 } } } }]) {
    expect(() => store.save({ ...value, editorSettings: { ...editorSettings, ...patch } })).toThrow()
    expect(store.load()).toEqual({ ...value, editorSettings })
  }
  store.close()
})

it('recovers valid engine formatting preferences without losing SQL or global settings', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT formatting_buffer')
  const custom = { tabSize: 4, insertSpaces: false, formatting: { expressionWidth: 20, linesBetweenQueries: 3 } }
  const global = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18 }
  let store = new WorkspaceStore(path); store.save(value); store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, editorSettings: { ...global,
    engineFormatting: { postgres: { ...custom, tabSize: 'broken' }, duckdb: custom, unexpected: custom } } })); db.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, editorSettings: { ...global, engineFormatting: { duckdb: custom } } })
  store.save(store.load()!); store.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, editorSettings: { ...global, engineFormatting: { duckdb: custom } } })
  store.close()
})

it('recovers damaged editor preferences independently of buffers, profiles and layout', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT important_preferences_buffer')
  const layout = { sidebarVisible: false, sidebarWidth: 450, resultsVisible: true, resultsHeight: 500, resultsMaximized: false }
  let store = new WorkspaceStore(path); store.save({ ...value, layout }); store.close()
  for (const editorSettings of [null, { fontSize: 'broken' }, { ...DEFAULT_EDITOR_SETTINGS, formatting: null }]) {
    const db = new DatabaseSync(path)
    db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...value, layout, editorSettings })); db.close()
    store = new WorkspaceStore(path)
    expect(store.load()).toEqual({ ...value, layout, editorSettings: DEFAULT_EDITOR_SETTINGS })
    store.close()
  }
})

it('persists split editors and recovers damaged view preferences without discarding buffers', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace('SELECT split_buffer')
  const other = { ...value.tabs[0], id: crypto.randomUUID(), sql: 'SELECT second_buffer' }
  const editorViews = { orientation: 'horizontal' as const, tabIds: [value.activeTabId, other.id], weights: [60, 40] }
  const saved = { ...value, tabs: [...value.tabs, other], editorViews }
  let store = new WorkspaceStore(path); store.save(saved); store.close()
  store = new WorkspaceStore(path); expect(store.load()).toEqual(saved)
  expect(() => store.save({ ...saved, editorViews: { ...editorViews, tabIds: [value.activeTabId, crypto.randomUUID()] } })).toThrow()
  expect(store.load()).toEqual(saved); store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE workspace SET value=? WHERE id=1').run(JSON.stringify({ ...saved, editorViews: { ...editorViews, weights: [500, -400] } })); db.close()
  store = new WorkspaceStore(path)
  expect(store.load()).toEqual({ ...value, tabs: saved.tabs })
  store.close()
})
