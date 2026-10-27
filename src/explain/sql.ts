import { parameterTokens } from '../shared/parameters'
import type { DatabaseEngine } from '../shared/contracts'
import type { ExplainRequest } from '../shared/explain'

/** Conservative boundaries for generated EXPLAIN, not a general SQL parser. */
export function explainSql(input: string, engine: DatabaseEngine, noBackslash = false, ansiQuotes = false) {
  const { tokens: scanned, refs } = parameterTokens(input, engine, noBackslash, ansiQuotes)
  const markers = new Set(refs.map(ref => ref.start + 1))
  if (scanned.some(t => !t.closed && !(t.kind === 'comment' && /^(--|#)/.test(t.text)))) throw new Error('Complete SQL strings, identifiers and comments before explaining.')
  if (scanned.some(t => t.kind === 'comment' && /^\/\*(?:!|M!)/i.test(t.text))) throw new Error('Executable comments are not supported by Explain.')
  // Session SQL modes can change how these literals terminate. Refuse ambiguous
  // escapes instead of letting a generated prefix cover only part of a script.
  if ((engine === 'postgres' || ['mysql','mariadb'].includes(engine) && !noBackslash) && scanned.some(t => ['string','identifier'].includes(t.kind) && t.text.includes('\\') && !t.text.startsWith('$'))) throw new Error('Explain requires unambiguous quoted values. Use doubled quotes instead of backslash escapes.')
  const tokens = scanned.filter(t => t.kind !== 'comment')
  const first = tokens[0]?.text.toUpperCase(), server = ['sqlserver','azure-sql'].includes(engine)
  if (!(server ? ['SELECT','WITH'] : ['SELECT','WITH','INSERT','UPDATE','DELETE','MERGE','VALUES']).includes(first)) throw new Error(server ? 'SQL Server Explain accepts one SELECT or WITH query.' : 'Explain accepts one SELECT, WITH or data manipulation statement.')
  if (tokens.some((t,i) => t.kind === 'symbol' && t.text === ';' && i !== tokens.length - 1)) throw new Error('Explain one statement at a time. Select it in the editor first.')
  if (tokens.some(t => !markers.has(t.start) && t.kind === 'word' && /^(EXPLAIN|ANALYZE|GO|DELIMITER|SHOWPLAN_XML|SHOWPLAN_TEXT|SHOWPLAN_ALL)$/.test(t.text.toUpperCase()))) throw new Error('Select the original SQL without EXPLAIN options or batch directives.')
  if (server && tokens.some(t => !markers.has(t.start) && t.kind === 'word' && /^(SET|EXEC|EXECUTE|DECLARE|USE|CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|INTO|BACKUP|RESTORE|DBCC|WAITFOR|COMMIT|ROLLBACK|GRANT|REVOKE|DENY|BEGIN)$/.test(t.text.toUpperCase()))) throw new Error('SQL Server Explain accepts a query without control statements or additional batches.')
  const last = tokens.at(-1)!
  return input.slice(0, last.text === ';' ? last.start : last.end).trim()
}
export function explainStatement(sql: string, engine: DatabaseEngine, mode: ExplainRequest['mode']) {
  if (mode === 'analyze' && engine !== 'postgres') throw new Error('Execution statistics are currently available only for PostgreSQL.')
  if (engine === 'postgres') return `EXPLAIN (FORMAT JSON, VERBOSE, COSTS, SUMMARY${mode === 'analyze' ? ', ANALYZE, BUFFERS, TIMING' : ''})\n${sql}`
  if (engine === 'mysql' || engine === 'mariadb') return `EXPLAIN FORMAT=JSON\n${sql}`
  if (engine === 'sqlite') return `EXPLAIN QUERY PLAN\n${sql}`
  return `EXPLAIN\n${sql}`
}
