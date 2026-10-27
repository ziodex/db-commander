/** T-SQL is sent as whole batches, preserving variable and temporary-table scope.
 * Only a standalone GO line (optional repeat count/comment) is a separator. */
export function splitSqlServerBatches(sql: string, located?: (start: number, end: number) => void): string[] {
  const batches: string[] = []
  let batch = '', quote = '', depth = 0, hasSql = false, offset = 0, batchStart = 0
  const locate = () => { const begin = batchStart + batch.indexOf(batch.trim()); located?.(begin, begin + batch.trim().length) }
  for (const line of sql.split(/(?<=\n)/)) {
    offset += line.length
    if (!quote && !depth) {
      const separator = line.match(/^\s*GO(?:\s+(\d+))?\s*(?:--[^\r\n]*)?\r?\n?$/i)
      if (separator) {
        const repeats = separator[1] === undefined ? 1 : Number(separator[1])
        if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 200) throw new Error('GO repeat count must be between 1 and 200.')
        if (hasSql) for (let i = 0; i < repeats; i++) { batches.push(batch.trim()); locate(); if (batches.length > 200) throw new Error('A script may contain up to 200 batches.') }
        batch = ''; batchStart = offset; hasSql = false; continue
      }
      if (/^\s*(?:GO\s|:|!!)/i.test(line)) throw new Error('Unsupported SQLCMD command or GO syntax. Only GO and GO <count> are supported.')
    }
    batch += line
    for (let i = 0; i < line.length; i++) {
      const c = line[i], next = line[i + 1]
      if (depth) {
        if (c === '/' && next === '*') { depth++; i++ }
        else if (c === '*' && next === '/') { depth--; i++ }
      } else if (quote) {
        if (c === quote) { if (next === quote) i++; else quote = '' }
      } else if (c === '-' && next === '-') break
      else if (c === '/' && next === '*') { depth++; i++ }
      else if (c === "'" || c === '"' || c === '[') { quote = c === '[' ? ']' : c; hasSql = true }
      else if (!/[\s;]/.test(c)) hasSql = true
    }
  }
  if (quote || depth) throw new Error('Unterminated T-SQL string, identifier, or comment.')
  if (hasSql) { batches.push(batch.trim()); locate() }
  if (batches.length > 200) throw new Error('A script may contain up to 200 batches.')
  return batches
}
