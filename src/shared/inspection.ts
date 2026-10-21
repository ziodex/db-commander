import type { Cell, GridTable } from './contracts'

export const INSPECT_LIMIT = 262144
export function inspectionPrefix(value:string) { const prefix=value.slice(0,INSPECT_LIMIT); return /[\uD800-\uDBFF]$/.test(prefix)?prefix.slice(0,-1):prefix }
export interface CellInspection { value: Cell; encoding: 'text' | 'hex'; truncated: boolean; source: 'snapshot' | 'live-row'; notice: string }
export interface ForeignKey { id: string; name: string; columns: string[]; target: GridTable; targetColumns: string[] }
export interface CellMark { row: number; column: number; truncated?: boolean; unavailable?: boolean; binary?: boolean }

/** Formatting never parses numbers into JS doubles or drops duplicate JSON keys. */
export function formatJson(text: string): string {
  JSON.parse(text) // Validate only; retain the original tokens, numbers and key order.
  let output = '', depth = 0, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    if (output.length > 1_000_000) throw new Error('Formatted JSON exceeds the display limit. Use Text.')
    const char = text[i]
    if (quoted) { output += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') { quoted = true; output += char }
    else if (/\s/.test(char)) continue
    else if (char === '{' || char === '[') { if (++depth > 100) throw new Error('JSON exceeds the 100-level formatting limit. Use Text.'); output += char + '\n' + '  '.repeat(depth) }
    else if (char === '}' || char === ']') { output += '\n' + '  '.repeat(--depth) + char }
    else if (char === ',') output += ',\n' + '  '.repeat(depth)
    else output += char === ':' ? ': ' : char
  }
  return output
}
export function hexDump(value: string, encoding: CellInspection['encoding'], offset = 0) {
  if(encoding==='hex'&&(!/^[\da-f]*$/i.test(value)||value.length%2))throw new Error('Incomplete or invalid hexadecimal bytes. Use Text to inspect the representation.')
  const bytes = encoding === 'hex' ? Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair,16)) : new TextEncoder().encode(value)
  const lines: string[] = []
  for (let at = offset; at < Math.min(bytes.length, offset + 4096); at += 16) {
    const row = bytes.slice(at, at + 16)
    lines.push(at.toString(16).padStart(8,'0') + '  ' + [...row].map(b => b.toString(16).padStart(2,'0')).join(' ').padEnd(47) + '  ' + [...row].map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join(''))
  }
  return { text: lines.join('\n'), bytes: bytes.length }
}
