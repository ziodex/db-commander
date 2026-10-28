import type { ResultSet } from '../shared/contracts'

/** Keep native result indexes intact, including sparse or count-only results. */
export function preferredResult(results: ResultSet[], fallback: number) {
  return (results.find(result => result?.columns.length && result.rows.length)
    ?? results.find(result => result?.columns.length)
    ?? results.find(Boolean))?.index ?? fallback
}

export function resultCount(result: ResultSet) {
  if (!result.columns.length) return result.rowCount === null || !/^(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/i.test(result.command) ? 'Statement completed' : `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? 'row' : 'rows'} affected`
  return `${result.rows.length.toLocaleString()} ${result.rows.length === 1 ? 'row' : 'rows'} fetched${result.truncated ? ' · Preview limit reached; result is incomplete' : ''}`
}

export function resultCommand(result: ResultSet) {
  return result.command.trim() || 'SQL'
}

export function resultDescription(result: ResultSet) {
  const source = result.statement.length > 1000 ? `Source SQL excerpt: ${result.statement.slice(0, 1000)}…` : `Source SQL: ${result.statement}`
  return `${resultCount(result)}. ${result.statement ? source : 'Source SQL unavailable. Select a single query explicitly for full export.'}`
}
