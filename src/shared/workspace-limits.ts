export const MAX_SQL_CHARACTERS = 1_000_000
export const MAX_WORKSPACE_SQL_CHARACTERS = 5_000_000

/** Explain an unsavable editor snapshot without dropping or truncating its SQL. */
export function workspaceSqlLimit(tabs: readonly { title: string; sql: string }[]): string | undefined {
  const oversized = tabs.find(tab => tab.sql.length > MAX_SQL_CHARACTERS)
  if (oversized) return `"${oversized.title}" exceeds the 1,000,000-character query limit. Undo the last edit or shorten this query, then retry saving. Copy SQL before closing if you need to keep the oversized text.`
  if (tabs.reduce((sum, tab) => sum + tab.sql.length, 0) > MAX_WORKSPACE_SQL_CHARACTERS) {
    return 'The workspace exceeds the 5,000,000-character SQL limit. Undo the last edit or save SQL copies and shorten a query, then retry saving.'
  }
}
