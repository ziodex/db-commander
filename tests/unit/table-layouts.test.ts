import { expect, it } from 'vitest'
import { DEFAULT_PROFILE, engineSchema, type ConnectionProfile, type GridSnapshot, type SessionInfo } from '../../src/shared/contracts'
import { defaultColumns, tableColumnLayoutSchema, withColumnView } from '../../src/shared/column-layout'
import { matchingTableLayout, MAX_TABLE_LAYOUT_CHARACTERS, MAX_TABLE_LAYOUTS, recoverTableLayouts, savedTableLayoutSchema, saveTableLayout, tableColumns, tableColumnViewKey, tableLayoutKey, tableLayoutsSchema, type SavedTableLayout } from '../../src/shared/table-layouts'

const session: SessionInfo = { id: 'session', engine: 'postgres', name: 'Connection', database: 'db', user: 'owner', host: 'localhost', port: 5432, tls: true, transaction: 'idle', version: '' }
const grid: GridSnapshot = { id: 'snapshot', table: { schema: 'main', name: 'items' }, columns: ['id', 'name', 'value'].map(name => ({ name, type: 'TEXT', nullable: false, primaryKey: name === 'id', generated: false, hasDefault: false })), rows: [['1', 'row data stays transient', 'sensitive value']], truncated: false, mode: 'browse', query: { offset: 0, pageSize: 200, filters: [], sort: [] } }
const entry = (key = 'table'): SavedTableLayout => ({ key, columns: tableColumns(grid), layout: { order: [2, 0, 1], hidden: [0], pinned: [2], widths: { 2: 330 } } })

it('scopes identities for every engine without credentials, transient session IDs or profile cosmetics', () => {
  for (const engine of engineSchema.options) {
    const profile: ConnectionProfile = { ...DEFAULT_PROFILE, engine, filePath: '/data/one.db', sqliteMode: 'read-write', duckdbMode: 'read-write' }
    const info = { ...session, engine, host: ['sqlite', 'duckdb'].includes(engine) ? '/data/one.db' : session.host }
    const key = tableLayoutKey(profile, info, grid.table, 'db')!
    expect(key).toBeDefined()
    expect(tableLayoutKey({ ...profile, name: 'Renamed', folder: 'New folder', favorite: true }, { ...info, id: 'other', name: 'Renamed', transaction: 'transaction' }, grid.table, 'db')).toBe(key)
    expect(tableLayoutKey(profile, info, { ...grid.table, name: 'other' }, 'db')).not.toBe(key)
    const withSecrets = { ...profile, password: 'password-secret', accessToken: 'token-secret', sshSecrets: { password: 'tunnel-secret' } }
    expect(tableLayoutKey(withSecrets, info, grid.table, 'db')).toBe(key)
    expect(key).not.toContain('secret')
  }
  const key = tableLayoutKey(DEFAULT_PROFILE, session, grid.table)
  for (const patch of [{ host: 'other' }, { port: 5555 }]) expect(tableLayoutKey({ ...DEFAULT_PROFILE, ...patch }, session, grid.table)).not.toBe(key)
  for (const patch of [{ database: 'other' }, { user: 'another' }]) expect(tableLayoutKey(DEFAULT_PROFILE, { ...session, ...patch }, grid.table)).not.toBe(key)
  expect(tableLayoutKey(DEFAULT_PROFILE, session, { ...grid.table, schema: 'other' })).not.toBe(key)
  expect(tableLayoutKey(DEFAULT_PROFILE, session, { ...grid.table, catalog: 'other' })).not.toBe(key)
  const ssh = { host: 'jump', port: 22, user: 'ssh-user', fingerprint: 'SHA256:' + 'a'.repeat(43), authentication: 'agent' as const }
  const tunneled = tableLayoutKey({ ...DEFAULT_PROFILE, ssh }, session, grid.table)
  expect(tunneled).not.toBe(key)
  expect(tableLayoutKey({ ...DEFAULT_PROFILE, ssh }, { ...session, host: '127.0.0.1', port: 59999 }, grid.table)).toBe(tunneled)
  for (const patch of [{ host: 'other-jump' }, { port: 2222 }, { user: 'other-user' }, { fingerprint: 'other-key' }, { destinationHost: 'other-target' }]) expect(tableLayoutKey({ ...DEFAULT_PROFILE, ssh: { ...ssh, ...patch } }, session, grid.table)).not.toBe(tunneled)
})

it('separates database files and excludes memory/attachments, even after changing the active DuckDB catalog', () => {
  for (const engine of ['sqlite', 'duckdb'] as const) {
    const profile = { ...DEFAULT_PROFILE, engine }, info = { ...session, engine, host: '/data/one.db' }
    const key = tableLayoutKey(profile, info, grid.table, 'db')
    expect(key).toBeDefined()
    expect(tableLayoutKey(profile, { ...info, host: '/data/two.db' }, grid.table, 'db')).not.toBe(key)
    expect(tableLayoutKey(profile, { ...info, host: ':memory:' }, grid.table, 'db')).toBeUndefined()
    expect(tableLayoutKey({ ...profile, [engine === 'sqlite' ? 'sqliteMode' : 'duckdbMode']: 'memory' }, info, grid.table, 'db')).toBeUndefined()
  }
  expect(tableLayoutKey({ ...DEFAULT_PROFILE, engine: 'sqlite' }, { ...session, engine: 'sqlite' }, { schema: 'temp', name: 'items' }, 'db')).toBeUndefined()
  const profile = { ...DEFAULT_PROFILE, engine: 'duckdb' as const }, info = { ...session, engine: 'duckdb' as const, database: 'attached' }
  expect(tableLayoutKey(profile, info, { ...grid.table, catalog: 'attached' }, 'db')).toBeUndefined()
  expect(tableLayoutKey(profile, info, grid.table, 'db')).toBeUndefined()
  expect(tableLayoutKey(profile, info, { ...grid.table, catalog: 'db' }, 'db')).toBeDefined()
  expect(tableLayoutKey(profile, info, grid.table)).toBeUndefined()
})

it('requires exact column names, types and ordinals while keeping layout metadata free of row data', () => {
  const saved = savedTableLayoutSchema.parse(entry())
  expect(matchingTableLayout(saved, grid)).toEqual(saved.layout)
  for (const columns of [grid.columns.slice(1), [...grid.columns].reverse(), grid.columns.map((column, i) => i ? column : { ...column, name: 'renamed' }), grid.columns.map((column, i) => i ? column : { ...column, type: 'INTEGER' })]) {
    expect(matchingTableLayout(saved, { columns })).toBeUndefined()
    expect(tableColumnViewKey(session, { ...grid, columns })).not.toBe(tableColumnViewKey(session, grid))
  }
  expect(tableColumnViewKey({ ...session, database: 'other' }, grid)).not.toBe(tableColumnViewKey(session, grid))
  expect(tableColumnViewKey({ ...session, id: 'other' }, grid)).not.toBe(tableColumnViewKey(session, grid))
  expect(tableColumnViewKey(session, { ...grid, table: { name: grid.table.name, schema: grid.table.schema } })).toBe(tableColumnViewKey(session, grid))
  expect(JSON.stringify(saved)).not.toContain('sensitive value')
  expect(savedTableLayoutSchema.safeParse({ ...saved, rows: grid.rows }).success).toBe(false)
  expect(savedTableLayoutSchema.safeParse({ ...saved, columns: saved.columns.slice(1) }).success).toBe(false)
})

it('rejects corrupt permutations, hidden/pinned ordinals, width bounds and unknown fields', () => {
  const valid = entry().layout
  for (const patch of [{ order: [0, 0, 2] }, { order: [0, 1, 3] }, { order: [] }, { hidden: [0, 1, 2] }, { hidden: [1, 1] }, { pinned: [3] }, { pinned: [0, 0] }, { widths: { 3: 100 } }, { widths: { '-1': 100 } }, { widths: { '01': 100 } }, { widths: { 0: 89 } }, { widths: { 0: 801 } }, { widths: { 0: 210.5 } }, { widths: { 0: Infinity } }, { rows: [] }]) {
    expect(tableColumnLayoutSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  }
  expect(tableColumnLayoutSchema.parse({ ...valid, widths: { 0: 90, 2: 800 } }).widths).toEqual({ 0: 90, 2: 800 })
})

it('bounds saved preferences by count and serialized size, replaces by identity and recovers valid records', () => {
  let entries: SavedTableLayout[] = []
  for (let i = 0; i <= MAX_TABLE_LAYOUTS; i++) entries = saveTableLayout(entries, entry(String(i)))
  expect(entries).toHaveLength(MAX_TABLE_LAYOUTS); expect(entries[0].key).toBe('1')
  entries = saveTableLayout(entries, { ...entry('1'), layout: defaultColumns(3) })
  expect(entries.at(-1)?.key).toBe('1'); expect(entries).toHaveLength(MAX_TABLE_LAYOUTS)
  const large = { ...entry(), columns: Array.from({ length: 100 }, (_, i) => ({ name: String(i), type: 'x'.repeat(2048) })), layout: defaultColumns(100) }
  for (let i = 0; i < 10; i++) entries = saveTableLayout(entries, { ...large, key: `large-${i}` })
  expect(JSON.stringify(entries).length).toBeLessThanOrEqual(MAX_TABLE_LAYOUT_CHARACTERS)
  expect(tableLayoutsSchema.safeParse(entries).success).toBe(true)
  expect(tableLayoutsSchema.safeParse([entry(), entry()]).success).toBe(false)
  expect(tableLayoutsSchema.safeParse(Array.from({ length: 10 }, (_, i) => ({ ...large, key: String(i) }))).success).toBe(false)
  expect(recoverTableLayouts([entry('valid'), { ...entry('bad'), layout: { ...entry().layout, hidden: [0, 1, 2] } }, entry('other')]).map(entry => entry.key)).toEqual(['valid', 'other'])
  expect(recoverTableLayouts(null)).toEqual([])
})

it('bounds transient layouts without mutating another tab or the saved preference', () => {
  const saved = entry().layout, otherTab = withColumnView({}, 'same-table', saved)
  let views = withColumnView({}, 'same-table', saved)
  views = withColumnView(views, 'same-table', { ...saved, widths: { 2: 410 } })
  expect(otherTab['same-table'].widths[2]).toBe(330); expect(saved.widths[2]).toBe(330)
  for (let i = 0; i < 30; i++) views = withColumnView(views, `table:${i}`, defaultColumns(3))
  expect(Object.keys(views)).toHaveLength(24)
  expect(views['same-table']).toBeUndefined()
})
