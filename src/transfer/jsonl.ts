import { parseJsonImport } from './json'
import type { Cell } from '../shared/contracts'

/** Db Commander JSON Lines: a columns object, followed by one array per line.
 * Reuse the exact-string JSON parser rather than coercing numeric JSON tokens. */
export async function* parseJsonLines(chunks: AsyncIterable<string>): AsyncGenerator<Cell[]> {
  async function* envelope() {
    let line = '', first = true, rows = 0
    function consume(raw: string) {
      const value = raw.trim()
      if (!value) return ''
      if (first) {
        first = false
        if (!value.endsWith('}')) throw new Error('JSON Lines starts with a columns object.')
        return value.slice(0, -1) + ',"rows":['
      }
      // One physical record is one array, never a comma-separated row fragment.
      if (!Array.isArray(JSON.parse(value))) throw new Error('Each JSON Lines data record must be an array.')
      return (rows++ ? ',' : '') + value
    }
    for await (const chunk of chunks) for (const character of chunk) {
      if (character === '\n') { const value = consume(line); line = ''; if (value) yield value }
      else { line += character; if (line.length > 1024 * 1024) throw new Error('JSON Lines exceeds the 1 MiB line limit.') }
    }
    if (line.trim()) yield consume(line)
    if (first) throw new Error('The JSON Lines file is empty.')
    yield ']}'
  }
  yield* parseJsonImport(envelope())
}
