import type { ObjectDetail } from '../shared/catalog'

type Token = { kind: 'word' | 'quoted' | 'punct'; text: string; start: number; end: number; depth: number }
function tokens(sql: string, backslash: boolean): Token[] {
  const result: Token[] = []; let depth = 0, i = 0
  while (i < sql.length) {
    const c = sql[i], start = i
    if (/\s/.test(c)) { i++; continue }
    if (c === '#' || c === '-' && sql[i+1] === '-' && /\s/.test(sql[i+2] ?? ' ')) { while (i < sql.length && sql[i] !== '\n') i++; continue }
    if (c === '/' && sql[i+1] === '*') { const end = sql.indexOf('*/', i+2); if (end < 0) throw new Error('Unterminated column-definition comment.'); i = end+2; continue }
    if (c === "'" || c === '"' || c === '`') {
      i++; let closed = false
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === c) { if (sql[i+1] === c) { i += 2; continue }; i++; closed = true; break }
        i++
      }
      if (!closed) throw new Error('Unterminated column-definition quote.')
      result.push({ kind: 'quoted', text: sql.slice(start,i), start, end: i, depth }); continue
    }
    if (/[A-Za-z_]/.test(c)) { i++; while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++; result.push({ kind: 'word', text: sql.slice(start,i).toUpperCase(), start, end: i, depth }); continue }
    if (c === '(') { result.push({ kind: 'punct', text: c, start, end: ++i, depth }); depth++; continue }
    if (c === ')') { depth--; if (depth < 0) throw new Error('Unbalanced column definition.'); result.push({ kind: 'punct', text: c, start, end: ++i, depth }); continue }
    result.push({ kind: 'punct', text: c, start, end: ++i, depth })
  }
  if (depth !== 0) throw new Error('Unbalanced column definition.')
  return result
}
function stableTokens(sql: string) {
  const a = tokens(sql, false), b = tokens(sql, true)
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('The native definition depends on SQL string-escape mode. Review it with explicit SQL.')
  return a
}
function unquoteIdentifier(value: string) {
  const quote = value[0]
  if ((quote !== '`' && quote !== '"') || value.at(-1) !== quote || value.includes('\\')) throw new Error('The native column identifier cannot be safely reconstructed.')
  return value.slice(1,-1).replaceAll(quote+quote, quote)
}
export function mysqlModifiedColumn(detail: ObjectDetail | undefined, column: string, oldType: string, change: { kind: 'type'; sql: string } | { kind: 'nullability'; nullable: boolean }, currentNullable: boolean): { sql: string; hadDefault: boolean } {
  if (!detail?.definition.sql || detail.definition.source !== 'native' || detail.definition.truncated) throw new Error('The complete native table definition is required for this change.')
  const ddl = detail.definition.sql, parts = stableTokens(ddl)
  const open = parts.find(token => token.text === '(' && token.depth === 0)
  const close = parts.find(token => token.text === ')' && token.depth === 0 && token.start > (open?.start ?? Infinity))
  if (!open || !close) throw new Error('The native table definition cannot be safely parsed.')
  const boundaries = [open.end, ...parts.filter(token => token.text === ',' && token.depth === 1 && token.start > open.start && token.start < close.start).map(token => token.end), close.start+1]
  const segments = boundaries.slice(0,-1).map((start,i) => ddl.slice(start, boundaries[i+1]-1).trim())
  const matches = segments.filter(segment => { const first = stableTokens(segment)[0]; return first?.kind === 'quoted' && unquoteIdentifier(first.text) === column })
  if (matches.length !== 1) throw new Error('The native column definition is missing or ambiguous. Refresh and review again.')
  const segment = matches[0], columnTokens = stableTokens(segment), first = columnTokens[0]
  if (/\/\*(?:!|M!)/i.test(segment)) throw new Error('The native column definition contains executable version comments. Inspect it with explicit SQL.')
  if (columnTokens.some(token => token.kind === 'quoted' && token.text.includes('\\'))) throw new Error('The native column definition contains backslashes whose meaning depends on SQL mode. Review it with explicit SQL.')
  if (columnTokens.some(token => token.text === ';' && token.depth === 0)) throw new Error('The native column definition has an unexpected statement separator.')
  const typeStart = segment.slice(first.end).search(/\S/) + first.end
  if (typeStart < first.end || segment.slice(typeStart,typeStart+oldType.length) !== oldType || /[A-Za-z0-9_$]/.test(segment[typeStart+oldType.length] ?? '')) throw new Error('The native column type does not match catalog metadata. Refresh and review again.')
  const typeEnd = typeStart+oldType.length
  const words = columnTokens.filter(token => token.kind === 'word' && token.depth === 0 && token.start >= typeEnd)
  const hadDefault = words.some(word => word.text === 'DEFAULT')
  if (change.kind === 'type') return { sql: segment.slice(0,typeStart) + change.sql + segment.slice(typeEnd), hadDefault }
  if (!change.nullable && words.some((word,i) => word.text === 'DEFAULT' && words[i+1]?.text === 'NULL')) throw new Error('The existing DEFAULT NULL conflicts with NOT NULL. Change the default first, then review nullability.')
  const notNull = words.flatMap((word,i) => word.text === 'NOT' && words[i+1]?.text === 'NULL' && /^\s+$/.test(segment.slice(word.end, words[i+1].start)) ? [{ start: word.start, end: words[i+1].end }] : [])
  if (notNull.length > 1 || currentNullable === Boolean(notNull.length)) throw new Error('The native nullability is ambiguous. Inspect the column definition with explicit SQL.')
  if (notNull.length) return { sql: segment.slice(0,notNull[0].start) + 'NULL' + segment.slice(notNull[0].end), hadDefault }
  const bareNull = words.find((word,i) => word.text === 'NULL' && words[i-1]?.text !== 'DEFAULT')
  if (bareNull) return { sql: segment.slice(0,bareNull.start) + 'NOT NULL' + segment.slice(bareNull.end), hadDefault }
  const firstAttribute = words.find(word => ['DEFAULT','COMMENT','AUTO_INCREMENT','GENERATED','ON','INVISIBLE','VISIBLE','CHECK','REFERENCES','COLUMN_FORMAT','STORAGE','PRIMARY','UNIQUE','SRID'].includes(word.text))
  const insert = firstAttribute?.start ?? segment.length
  return { sql: segment.slice(0,insert).trimEnd() + ' NOT NULL' + (insert < segment.length ? ` ${segment.slice(insert)}` : ''), hadDefault }
}
