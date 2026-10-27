import type { DatabaseEngine } from '../database-engines'
export interface Token { kind: 'word' | 'identifier' | 'string' | 'comment' | 'symbol'; text: string; value: string; start: number; end: number; closed: boolean }
/** Tolerant lexical scanner, not a SQL parser or an execution authorization boundary. */
export function lexSql(sql: string, engine: DatabaseEngine, noBackslashEscapes = false, ansiQuotes = false): Token[] {
  const tokens: Token[] = [], mysql = engine === 'mysql' || engine === 'mariadb'
  const nested = ['postgres', 'duckdb', 'sqlserver', 'azure-sql'].includes(engine)
  const wordStart = ['sqlserver', 'azure-sql', 'mysql', 'mariadb'].includes(engine) ? /[\p{L}_@#]/u : /[\p{L}_]/u
  const wordPart = ['sqlserver', 'azure-sql', 'oracle'].includes(engine) ? /[\p{L}\p{N}_$@#]/u : mysql ? /[\p{L}\p{N}_$@]/u : /[\p{L}\p{N}_$]/u
  let i = 0
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue }
    const start = i
    let kind: Token['kind'] = 'symbol', closed = true, value: string | undefined
    if (sql.startsWith('--', i) && (!mysql || !sql[i + 2] || /\s/.test(sql[i + 2])) || mysql && sql[i] === '#') {
      kind = 'comment'; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
      closed = i < sql.length
    } else if (sql.startsWith('/*', i)) {
      kind = 'comment'; let depth = 1; i += 2
      while (i < sql.length && depth) {
        if (nested && sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 } else i++
      }
      closed = depth === 0
    } else {
      const dollar = ['postgres', 'duckdb'].includes(engine) ? /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i))?.[0] : undefined
      const oracle = engine === 'oracle' ? /^(?:n?q)'([^\s])/i.exec(sql.slice(i)) : null
      const prefix = /^(?:[eEnNbBxX]|[uU]&)(')/.exec(sql.slice(i))
      if (dollar) {
        kind = 'string'; const end = sql.indexOf(dollar, i + dollar.length); closed = end !== -1; i = closed ? end + dollar.length : sql.length
      } else if (oracle) {
        kind = 'string'; const closing = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[oracle[1]] ?? oracle[1]
        const end = sql.indexOf(closing + "'", i + oracle[0].length); closed = end !== -1; i = closed ? end + 2 : sql.length
      } else if (sql[i] === "'" || sql[i] === '"' || sql[i] === '`' || sql[i] === '[' && ['sqlite', 'sqlserver', 'azure-sql'].includes(engine) || prefix) {
        const opener = prefix ? "'" : sql[i], closer = opener === '[' ? ']' : opener
        kind = opener === "'" || mysql && !ansiQuotes && opener === '"' ? 'string' : 'identifier'
        i += prefix ? prefix[0].length : 1
        value = ''; closed = false
        while (i < sql.length) {
          if (sql[i] === closer) {
            if (sql[i + 1] === closer) { value += closer; i += 2; continue }
            i++; closed = true; break
          }
          if (sql[i] === '\\' && (mysql && kind === 'string' && !noBackslashEscapes || prefix?.[0].toUpperCase() === "E'")) { value += sql.slice(i, i + 2); i += Math.min(2, sql.length - i) }
          else value += sql[i++]
        }
      } else if (wordStart.test(sql[i])) {
        kind = 'word'; i++; while (i < sql.length && wordPart.test(sql[i])) i++
      } else {
        const operator = /^(?:->>|#>>|::|->|#>|>=|<=|<>|!=|\|\||&&|:=|=>|<<|>>|!~\*|!~|~\*)/.exec(sql.slice(i))
        i += operator?.[0].length ?? 1
      }
    }
    tokens.push({ kind, text: sql.slice(start, i), value: value ?? sql.slice(start, i), start, end: i, closed })
  }
  return tokens
}
