/** PostgreSQL lexical boundaries, including nested comments and dollar-quoted bodies.
 * SQL is not rewritten. Unsupported psql commands fail visibly at the server.
 */
export function splitPostgresScript(sql: string, located?: (start: number, end: number) => void): string[] {
  const statements: string[] = []
  let start = 0
  let quote = ''
  let dollar = ''
  let lineComment = false
  let commentDepth = 0
  let escapedString = false
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (commentDepth) {
      if (char === '/' && next === '*') { commentDepth++; i++ }
      else if (char === '*' && next === '/') { commentDepth--; i++ }
      continue
    }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = '' }; continue }
    if (quote) {
      if (escapedString && char === '\\') { i++; continue }
      if (char === quote) { if (next === quote) i++; else quote = '' }
      continue
    }
    if (char === '-' && next === '-') { lineComment = true; i++; continue }
    if (char === '/' && next === '*') { commentDepth++; i++; continue }
    if (char === '"' || char === "'") {
      quote = char
      escapedString = char === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i))
      continue
    }
    if (char === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
      const match = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)
      if (match) { dollar = match[0]; i += dollar.length - 1; continue }
    }
    if (char === ';') { const part = sql.slice(start, i).trim(); if (hasSql(part)) { statements.push(part); located?.(start + sql.slice(start, i).indexOf(part), start + sql.slice(start, i).indexOf(part) + part.length) }; start = i + 1 }
  }
  if (quote || dollar || commentDepth) throw new Error('Unterminated SQL string, identifier, dollar quote, or comment.')
  const tail = sql.slice(start).trim()
  if (hasSql(tail)) { statements.push(tail); located?.(start + sql.slice(start).indexOf(tail), start + sql.slice(start).indexOf(tail) + tail.length) }
  return statements
}
function hasSql(text: string): boolean { return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0 }
export function firstKeyword(sql: string): string {
  let index = 0
  while (index < sql.length) {
    if (/\s/.test(sql[index])) { index++; continue }
    if (sql.startsWith('--', index)) { const end = sql.indexOf('\n', index); index = end === -1 ? sql.length : end + 1; continue }
    if (sql.startsWith('/*', index)) {
      let depth = 1; index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2 }
        else if (sql.startsWith('*/', index)) { depth--; index += 2 }
        else index++
      }
      continue
    }
    return sql.slice(index).match(/^[a-zA-Z]+/)?.[0].toUpperCase() ?? ''
  }
  return ''
}
export function quoteIdentifier(value: string, engine = 'postgres'): string {
  if (engine === 'sqlserver' || engine === 'azure-sql') return '[' + value.replaceAll(']', ']]') + ']'
  if (engine === 'mysql' || engine === 'mariadb') return '`' + value.replaceAll('`', '``') + '`'
  return '"' + value.replaceAll('"', '""') + '"' }
export function csvCell(value: string | null): string {
  if (value === null) return ''
  // Quote every non-null cell to distinguish NULL from an empty string.
  return '"' + value.replaceAll('"', '""') + '"'
}

export function tablePreviewSql(schema: string, name: string, engine: string, catalog?: string): string {
  const table = `${engine === 'duckdb' && catalog ? quoteIdentifier(catalog, engine) + '.' : ''}${quoteIdentifier(schema, engine)}.${quoteIdentifier(name, engine)}`
  if (engine === 'oracle') return `SELECT *\nFROM ${table}\nFETCH FIRST 1000 ROWS ONLY;`
  return engine === 'sqlserver' || engine === 'azure-sql' ? `SELECT TOP (1000) *\nFROM ${table};` : `SELECT *\nFROM ${table}\nLIMIT 1000;`
}
