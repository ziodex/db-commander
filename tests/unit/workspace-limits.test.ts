import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE, workspaceSchema, type Workspace } from '../../src/shared/contracts'
import { MAX_SQL_CHARACTERS, MAX_WORKSPACE_SQL_CHARACTERS, workspaceSqlLimit } from '../../src/shared/workspace-limits'

function workspace(lengths: number[]): Workspace {
  const tabs = lengths.map((length, index) => ({ id: randomUUID(), title: `Query ${index + 1}.sql`, sql: 'x'.repeat(length), profile: DEFAULT_PROFILE }))
  return { version: 2, activeTabId: tabs[0].id, tabs, profiles: [] }
}
it('accepts a query at the exact persisted character limit', () => {
  const value = workspace([MAX_SQL_CHARACTERS])
  expect(workspaceSqlLimit(value.tabs)).toBeUndefined()
  expect(workspaceSchema.safeParse(value).success).toBe(true)
})
it('accepts twenty tabs at the exact total character limit', () => {
  const value = workspace([...Array(5).fill(MAX_SQL_CHARACTERS), ...Array(15).fill(0)])
  expect(value.tabs.reduce((sum, tab) => sum + tab.sql.length, 0)).toBe(MAX_WORKSPACE_SQL_CHARACTERS)
  expect(workspaceSqlLimit(value.tabs)).toBeUndefined()
  expect(workspaceSchema.safeParse(value).success).toBe(true)
})
it('names an oversized query and explains undo and copying without changing its contents', () => {
  const value = workspace([MAX_SQL_CHARACTERS + 1]), before = value.tabs[0].sql
  expect(workspaceSqlLimit(value.tabs)).toContain('"Query 1.sql" exceeds the 1,000,000-character query limit')
  expect(workspaceSqlLimit(value.tabs)).toContain('Undo')
  expect(workspaceSqlLimit(value.tabs)).toContain('Copy SQL before closing')
  expect(value.tabs[0].sql).toBe(before)
  expect(workspaceSchema.safeParse(value).success).toBe(false)
})
it('explains total overflow when every query is individually supported', () => {
  const value = workspace([...Array(5).fill(MAX_SQL_CHARACTERS), 1])
  expect(workspaceSqlLimit(value.tabs)).toContain('5,000,000-character SQL limit')
  expect(workspaceSqlLimit(value.tabs)).toContain('Undo')
  expect(workspaceSchema.safeParse(value).success).toBe(false)
})
it('prioritizes the specific query when both limits are exceeded', () => {
  const value = workspace([...Array(4).fill(MAX_SQL_CHARACTERS), MAX_SQL_CHARACTERS + 1])
  expect(workspaceSqlLimit(value.tabs)).toContain('"Query 5.sql" exceeds the 1,000,000-character query limit')
  expect(workspaceSchema.safeParse(value).success).toBe(false)
})
