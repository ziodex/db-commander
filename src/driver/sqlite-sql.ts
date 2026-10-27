/** Inspect only trivia/parameters. SQLite itself parses statement boundaries,
 * including trigger bodies; no SQL is rewritten or split on semicolons. */
export function inspectSqliteSql(sql: string): { hasSql: boolean; hasParameters: boolean } {
  let hasSql = false, hasParameters = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1]
    if (/\s/.test(c) || c === ';') continue
    if (c === '-' && next === '-') { const end = sql.indexOf('\n', i + 2); if (end < 0) break; i = end; continue }
    if (c === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue }
    hasSql = true
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c
      for (i++; i < sql.length; i++) if (sql[i] === end) { if (c !== '[' && sql[i + 1] === end) i++; else break }
    } else if (c === '?' || /[$:@]/.test(c) && /[\p{L}\p{N}_]/u.test(next ?? '') && !/[\p{L}\p{N}_$]/u.test(sql[i - 1] ?? '')) hasParameters = true
  }
  return { hasSql, hasParameters }
}
