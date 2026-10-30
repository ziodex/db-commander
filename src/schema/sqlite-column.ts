import type { ObjectDetail } from '../shared/catalog'

type Token = { text: string; start: number; end: number; depth: number; quoted: boolean }
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []; let depth = 0, i = 0
  while (i < sql.length) {
    const c = sql[i], start = i
    if (/\s/.test(c)) { i++; continue }
    if (c === '-' && sql[i+1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue }
    if (c === '/' && sql[i+1] === '*') { const end = sql.indexOf('*/', i+2); if (end < 0) throw new Error('Unterminated schema comment.'); i = end+2; continue }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const endQuote = c === '[' ? ']' : c; i++; let closed = false
      while (i < sql.length) {
        if (sql[i] === endQuote) { if (c !== '[' && sql[i+1] === endQuote) { i += 2; continue }; i++; closed = true; break }; i++
      }
      if (!closed) throw new Error('Unterminated schema quote.')
      tokens.push({ text: sql.slice(start,i), start, end: i, depth, quoted: true }); continue
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) { i++; while (i < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i])) i++; tokens.push({ text: sql.slice(start,i), start, end: i, depth, quoted: false }); continue }
    if (c === '(') { tokens.push({ text: c, start, end: ++i, depth, quoted: false }); depth++; continue }
    if (c === ')') { depth--; if (depth < 0) throw new Error('Unbalanced schema definition.'); tokens.push({ text: c, start, end: ++i, depth, quoted: false }); continue }
    tokens.push({ text: c, start, end: ++i, depth, quoted: false })
  }
  if (depth !== 0) throw new Error('Unbalanced schema definition.')
  return tokens
}
function identifier(token: Token) {
  if (!token.quoted) return token.text
  const open = token.text[0], close = open === '[' ? ']' : open
  return token.text.slice(1,-1).replaceAll(close+close, close)
}
export function sqliteExplicitNotNullCount(detail: ObjectDetail | undefined, column: string): number {
  if (!detail?.definition.sql || detail.definition.source !== 'native' || detail.definition.truncated) throw new Error('The complete native table definition is required for this change.')
  const sql = detail.definition.sql, all = tokenize(sql), open = all.find(token => token.text === '(' && token.depth === 0), close = all.find(token => token.text === ')' && token.depth === 0 && token.start > (open?.start ?? Infinity))
  if (!open || !close) throw new Error('The native table definition cannot be safely parsed.')
  const bounds = [open.end, ...all.filter(token => token.text === ',' && token.depth === 1 && token.start > open.start && token.start < close.start).map(token => token.end), close.start+1]
  const segments = bounds.slice(0,-1).map((start,i) => sql.slice(start,bounds[i+1]-1).trim())
  const matches = segments.filter(segment => { const first = tokenize(segment)[0]; return first && identifier(first) === column })
  if (matches.length !== 1) throw new Error('The native column definition is missing or ambiguous. Refresh and review again.')
  const parts = tokenize(matches[0]), words = parts.filter(token => token.start >= parts[0].end && !token.quoted && token.depth === 0 && /^[A-Za-z_]+$/.test(token.text))
  return words.reduce((count, word, i) => count + (word.text.toUpperCase() === 'NOT' && words[i+1]?.text.toUpperCase() === 'NULL' && /^\s+$/.test(matches[0].slice(word.end,words[i+1].start)) ? 1 : 0), 0)
}
