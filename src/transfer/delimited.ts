import { openRecords } from './file-source'
import type { Cell } from '../shared/contracts'

export const MAX_CELL = 16384
/** UTF-8, RFC-style quoting, CRLF/LF, embedded newlines, and unquoted \\N for NULL.
 * Limits apply before a record can grow without bound. Quoted \\N is literal text. */
export async function* parseDelimited(chunks: AsyncIterable<string>, delimiter: ',' | '\t'): AsyncGenerator<Cell[]> {
  let row: Cell[] = [], field = '', quoted = false, inQuote = false, afterQuote = false, cr = false, first = true, touched = false, size = 0
  const append = (c: string) => { field += c; size++; if (field.length > MAX_CELL || size > 1024 * 1024) throw new Error('Import exceeds the 16,384-character cell or 1 MiB record limit.') }
  const finishField = () => { row.push(!quoted && field === '\\N' ? null : field); if (row.length > 100) throw new Error('Import supports up to 100 columns.'); field = ''; quoted = false; afterQuote = false }
  for await (const chunk of chunks) for (const c of chunk) {
    if (first) { first = false; if (c === '\uFEFF') continue }
    if (c === '\0') throw new Error('NUL characters are not supported in imported text.')
    if (cr) { cr = false; if (c === '\n') continue }
    touched = true
    if (inQuote) { if (c === '"') { inQuote = false; afterQuote = true } else append(c); continue }
    if (afterQuote && c === '"') { append('"'); inQuote = true; afterQuote = false; continue }
    if (c === delimiter) { finishField(); continue }
    if (c === '\r' || c === '\n') { finishField(); yield row; row = []; size = 0; touched = false; cr = c === '\r'; continue }
    if (afterQuote) throw new Error('Unexpected character after a closing quote in the import file.')
    if (c === '"') { if (field.length) throw new Error('A quote inside an unquoted field must be escaped.'); quoted = true; inQuote = true; continue }
    append(c)
  }
  if (inQuote) throw new Error('The import file ends inside a quoted field.')
  if (touched || row.length) { finishField(); yield row }
}

export async function openDelimited(file: string, format: 'csv' | 'tsv') {
  return openRecords(file, chunks => parseDelimited(chunks, format === 'csv' ? ',' : '\t'))
}

export function delimitedRow(row: Cell[], delimiter: string) {
  return row.map(value => value === null ? '\\N' : `"${value.replaceAll('"', '""')}"`).join(delimiter) + '\r\n'
}
