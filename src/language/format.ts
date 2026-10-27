import { formatDialect, postgresql, mysql, mariadb, transactsql, sqlite, plsql, duckdb } from 'sql-formatter'
import type { DatabaseEngine } from '../shared/contracts'
import { lexSql } from '../shared/sql/lexer'
import { parameterNames } from '../shared/parameters'
import { DEFAULT_SQL_FORMATTING, sqlFormattingSchema, type SqlFormattingSettings } from '../shared/editor-settings'
const dialects = { postgres: postgresql, mysql, mariadb, sqlserver: transactsql, 'azure-sql': transactsql, sqlite, oracle: plsql, duckdb }
const MAX_LANGUAGE_SQL = 200_000
/** A formatting failure returns no edit; never send editor text to a database. */
export function formatSql(sql: string, engine: DatabaseEngine, tabWidth = 2, useTabs = false, preferences: SqlFormattingSettings = DEFAULT_SQL_FORMATTING): string {
  const spacing = sqlFormattingSchema.parse(preferences)
  if (sql.length > MAX_LANGUAGE_SQL) throw new Error('Format a selection of at most 200,000 characters.')
  if (!sql.trim()) return sql
  const tokens = lexSql(sql, engine), code = tokens.filter(token => token.kind !== 'comment' && token.kind !== 'string').map(token => token.text.toUpperCase()).join(' ')
  if (tokens.some(token => !token.closed && token.kind !== 'comment')) throw new Error('Finish the quoted value or identifier before formatting.')
  if (/\bDELIMITER\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE)\b/.test(code) || engine === 'oracle' && /^(?:DECLARE|BEGIN)\b/.test(code)) throw new Error('Procedural bodies and DELIMITER scripts are not formatted. Select an ordinary SQL statement instead.')
  const render = (text: string) => formatDialect(text, { dialect: dialects[engine], tabWidth: Math.max(1, Math.min(8, tabWidth)), useTabs,
    paramTypes: { named: [':'] }, keywordCase: 'preserve', functionCase: 'preserve', dataTypeCase: 'preserve', ...spacing })
  let result: string
  if (engine === 'sqlserver' || engine === 'azure-sql') {
    // GO is a client line separator, including repeat counts. Keep it verbatim.
    const separators = tokens.filter(token => token.kind === 'word' && token.text.toUpperCase() === 'GO' && /^\s*GO(?:\s+\d+)?\s*(?:--[^\r\n]*)?$/i.test(sql.slice(sql.lastIndexOf('\n', token.start - 1) + 1, sql.indexOf('\n', token.start) === -1 ? sql.length : sql.indexOf('\n', token.start))))
    const chunks: string[] = []; let start = 0
    for (const token of separators) {
      const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1, lineEnd = sql.indexOf('\n', token.start)
      chunks.push(render(sql.slice(start, lineStart)).trimEnd(), sql.slice(lineStart, lineEnd === -1 ? sql.length : lineEnd))
      start = lineEnd === -1 ? sql.length : lineEnd + 1
    }
    chunks.push(render(sql.slice(start))); result = chunks.join('\n')
  } else result = render(sql)
  if (JSON.stringify(parameterNames(sql, engine)) !== JSON.stringify(parameterNames(result, engine))) throw new Error('Formatting would change parameter names. The original SQL was kept.')
  const after = lexSql(result, engine)
  if (after.length !== tokens.length || after.some((token, i) => token.text !== tokens[i].text || token.kind !== tokens[i].kind)) throw new Error('Formatting would change SQL tokens. The original text was kept; select a smaller statement.')
  if (engine === 'mysql' || engine === 'mariadb') {
    const beforeMode = lexSql(sql, engine, true), afterMode = lexSql(result, engine, true)
    if (beforeMode.length !== afterMode.length || afterMode.some((token, i) => token.text !== beforeMode[i].text || token.kind !== beforeMode[i].kind)) throw new Error('Formatting is ambiguous under NO_BACKSLASH_ESCAPES. The original text was kept.')
  }
  // PostgreSQL concatenates adjacent string literals only across a newline.
  if (engine === 'postgres') for (let i = 1; i < tokens.length; i++) {
    if (tokens[i - 1].kind === 'string' && tokens[i].kind === 'string' && /[\r\n]/.test(sql.slice(tokens[i - 1].end, tokens[i].start)) !== /[\r\n]/.test(result.slice(after[i - 1].end, after[i].start))) throw new Error('Formatting would change adjacent string literal semantics. The original text was kept.')
  }
  return result.replace(/\r?\n/g, sql.includes('\r\n') ? '\r\n' : '\n')
}
