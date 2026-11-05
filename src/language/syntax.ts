import type { DatabaseEngine } from '../shared/database-engines'
import { lexSql, type Token } from '../shared/sql/lexer'

export const ANALYSIS_LIMIT = 200_000
export const identifier = (token?: Token): token is Token => token?.kind === 'word' || token?.kind === 'identifier'
export const word = (token?: Token) => token?.kind === 'word' ? token.text.toUpperCase() : ''
export const symbol = (token: Token | undefined, text: string) => token?.kind === 'symbol' && token.text === text
export const folded = (name: string) => name.toLowerCase()

export interface AnalysisDialect {
  engine: DatabaseEngine
  noBackslashEscapes?: boolean
  ansiQuotes?: boolean
}
export interface SourceRange { start: number; end: number }

export function sqlTokens(sql: string, dialect: AnalysisDialect) {
  return lexSql(sql, dialect.engine, dialect.noBackslashEscapes, dialect.ansiQuotes)
}

/** Statement boundaries for editor assistance only. Execution keeps its own splitter. */
export function statementAt(sql: string, tokens: Token[], offset: number, engine: DatabaseEngine) {
  let start = 0, end = tokens.length
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (symbol(token, ';')) {
      if (token.end <= offset) start = index + 1
      else { end = index; break }
    } else if ((engine === 'sqlserver' || engine === 'azure-sql') && word(token) === 'GO') {
      const lineStart = sql.lastIndexOf('\n', token.start - 1) + 1
      const newline = sql.indexOf('\n', token.end)
      const lineEnd = newline < 0 ? sql.length : newline
      if (!/^\s*GO(?:\s+\d+)?\s*(?:--.*)?$/i.test(sql.slice(lineStart, lineEnd))) continue
      if (lineEnd < offset) {
        while (tokens[index + 1] && tokens[index + 1].end <= lineEnd) index++
        start = index + 1
      } else { end = index; break }
    }
  }
  return tokens.slice(start, end)
}

export function namePath(tokens: Token[], start: number) {
  const names: Token[] = []
  let end = start
  while (identifier(tokens[end])) {
    names.push(tokens[end++])
    if (!symbol(tokens[end], '.') || !identifier(tokens[end + 1])) break
    end++
  }
  return { names, end }
}

export function parentheses(tokens: Token[]) {
  const open: number[] = [], close = new Map<number, number>(), extra: number[] = []
  for (const [index, token] of tokens.entries()) {
    if (symbol(token, '(')) open.push(index)
    if (symbol(token, ')')) {
      const left = open.pop()
      if (left === undefined) extra.push(index)
      else close.set(left, index)
    }
  }
  return { open, close, extra }
}
