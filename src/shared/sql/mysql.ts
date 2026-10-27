export interface MysqlSqlMode { noBackslashEscapes: boolean; ansiQuotes: boolean }

/** MySQL/MariaDB client script boundaries. DELIMITER is a client command,
 * removed here; statement contents (including executable comments) are preserved.
 */
export function splitMysqlScript(sql: string, mode: MysqlSqlMode = { noBackslashEscapes: false, ansiQuotes: false }, located?: (start: number, end: number, delimiter: string) => void): string[] {
  const statements: string[] = []
  let start = 0, quote = '', comment = false, line = false, delimiter = ';'
  const add = (end: number) => { const part = sql.slice(start, end).trim(); if (hasMysqlSql(part)) { statements.push(part); const begin = start + sql.slice(start, end).indexOf(part); located?.(begin, begin + part.length, delimiter) } }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1]
    if (line) { if (c === '\n') line = false; continue }
    if (comment) { if (c === '*' && n === '/') { comment = false; i++ }; continue }
    if (quote) {
      const string = quote === "'" || (quote === '"' && !mode.ansiQuotes)
      if (string && !mode.noBackslashEscapes && c === '\\') { i++; continue }
      if (c === quote) { if (n === quote) i++; else quote = '' }
      continue
    }
    if (i === 0 || sql[i - 1] === '\n') {
      const directive = sql.slice(i).match(/^[\t ]*DELIMITER[\t ]+(\S+)[\t ]*(?:\r?\n|$)/i)
      if (directive) {
        if (hasMysqlSql(sql.slice(start, i))) throw new Error('DELIMITER must appear between completed statements.')
        delimiter = directive[1]
        if (delimiter.length > 16 || /['"`\\]/.test(delimiter)) throw new Error('Unsupported DELIMITER. Use ;, $$ or //.')
        i += directive[0].length - 1; start = i + 1; continue
      }
    }
    if (sql.startsWith(delimiter, i)) { add(i); i += delimiter.length - 1; start = i + 1; continue }
    if (c === '#' || (c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? '\n'))) { line = true; continue }
    if (c === '/' && n === '*') { comment = true; i++; continue }
    if (c === "'" || c === '"' || c === '`') quote = c
  }
  if (quote || comment) throw new Error('Unterminated SQL string, identifier, or comment.')
  add(sql.length)
  return statements
}

function hasMysqlSql(sql: string): boolean {
  // Executable /*! ... */ and /*M! ... */ comments are SQL, even by themselves.
  return sql.replace(/\/\*(?![!]|M!)[\s\S]*?\*\//gi, '').replace(/--(?=\s|$)[^\n]*|#[^\n]*/g, '').trim().length > 0
}
export function mysqlKeyword(sql: string): string {
  return sql.replace(/\/\*(?![!]|M!)[\s\S]*?\*\//gi, ' ').replace(/--(?=\s|$)[^\n]*|#[^\n]*/g, ' ').trim().match(/^[a-z]+/i)?.[0].toUpperCase() ?? ''
}
