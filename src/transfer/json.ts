import type { Cell } from '../shared/contracts'
import { MAX_CELL } from './delimited'

const MAX_RECORD = 1024 * 1024
type Token = { kind: 'string' | 'atom' | 'symbol'; value: string }
const syntax = () => new Error('Invalid JSON import. Use an object with columns first, then rows, in Db Commander export format.')

/** Tokenize incrementally; neither whitespace nor an unfinished token can grow unbounded. */
async function* tokenize(chunks: AsyncIterable<string>, budget: { characters: number }): AsyncGenerator<Token> {
  let mode: 'normal' | 'string' | 'atom' = 'normal', raw = '', escaped = false, first = true
  for await (const chunk of chunks) for (const c of chunk) {
    if (first) { first = false; if (c === '\uFEFF') continue }
    budget.characters += c.length
    if (budget.characters > MAX_RECORD) throw new Error('JSON import exceeds 1,048,576 characters per header, record or separator.')
    if (mode === 'string') {
      raw += c
      if (raw.length > MAX_CELL * 6 + 2) throw new Error('JSON import exceeds the 16,384-character string limit.')
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c !== '"') continue
      let value: string
      try { value = JSON.parse(raw) as string } catch { throw new Error('Invalid JSON string or escape in the import file.') }
      if (value.length > MAX_CELL) throw new Error('JSON import exceeds the 16,384-character string limit.')
      if (value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw new Error('NUL and unpaired Unicode surrogates are not supported in imported text.')
      raw = ''; mode = 'normal'; yield { kind: 'string', value }; continue
    }
    const symbol = '{}[],:'.includes(c), space = /^[ \t\r\n]$/.test(c)
    if (mode === 'atom') {
      if (!symbol && !space) {
        raw += c
        if (raw.length > 32) throw new Error('Invalid JSON value. Data cells must be strings or null; quote numbers to preserve precision.')
        continue
      }
      const value = raw; raw = ''; mode = 'normal'; yield { kind: 'atom', value }
    }
    if (space) continue
    if (symbol) { yield { kind: 'symbol', value: c }; continue }
    raw = c; mode = c === '"' ? 'string' : 'atom'
  }
  if (mode === 'string') throw new Error('The JSON import file ends inside a string.')
  if (mode === 'atom') yield { kind: 'atom', value: raw }
}

/** Db Commander JSON: {"columns":[{"name":"id",...}],"rows":[["1"],...]}.
 * Column metadata is descriptive only; the target schema determines conversions.
 * Yield the header first to share the existing bounded table-import pipeline. */
export async function* parseJsonImport(chunks: AsyncIterable<string>): AsyncGenerator<Cell[]> {
  const budget = { characters: 0 }, tokens = tokenize(chunks, budget)
  const take = async () => (await tokens.next()).value as Token | undefined
  const is = (token: Token | undefined, value: string) => token?.kind === 'symbol' && token.value === value
  async function expect(value: string, kind: Token['kind'] = 'symbol') {
    const token = await take(); if (token?.kind !== kind || token.value !== value) throw syntax()
  }
  try {
    await expect('{'); await expect('columns', 'string'); await expect(':'); await expect('[')
    const headers: string[] = []
    for (;;) {
      await expect('{')
      const fields = new Set<string>(); let name: string | undefined
      for (;;) {
        const key = await take()
        if (key?.kind !== 'string' || !['name','typeId','typeName'].includes(key.value) || fields.has(key.value)) throw new Error('JSON columns accept unique name, typeId and typeName fields only.')
        fields.add(key.value); await expect(':')
        const value = await take()
        if (key.value === 'typeId') {
          if (value?.kind !== 'atom' || !/^-?(0|[1-9]\d*)$/.test(value.value) || !Number.isSafeInteger(Number(value.value))) throw new Error('JSON column typeId must be a safe integer.')
        } else {
          if (value?.kind !== 'string') throw new Error('JSON column names and type names must be strings.')
          if (key.value === 'name') name = value.value
        }
        const delimiter = await take()
        if (is(delimiter,'}')) break
        if (!is(delimiter,',')) throw syntax()
      }
      if (!name || headers.includes(name)) throw new Error('JSON columns must contain nonempty, unique names. Alias duplicate result columns before export.')
      headers.push(name)
      if (headers.length > 100) throw new Error('Import supports up to 100 columns.')
      const delimiter = await take()
      if (is(delimiter,']')) break
      if (!is(delimiter,',')) throw syntax()
    }
    await expect(','); await expect('rows','string'); await expect(':'); await expect('[')
    budget.characters = 0
    yield headers
    let token = await take()
    if (!is(token,']')) for (;;) {
      if (!is(token,'[')) throw syntax()
      const row: Cell[] = []
      token = await take()
      if (!is(token,']')) for (;;) {
        if (token?.kind === 'string') row.push(token.value)
        else if (token?.kind === 'atom' && token.value === 'null') row.push(null)
        else throw new Error('JSON data cells must be strings or null. Quote numeric values to preserve precision; nested values and booleans are not accepted.')
        if (row.length > headers.length) throw new Error('The JSON record has a different number of columns than the header.')
        token = await take()
        if (is(token,']')) break
        if (!is(token,',')) throw syntax()
        token = await take()
      }
      if (row.length !== headers.length) throw new Error('The JSON record has a different number of columns than the header.')
      budget.characters = 0
      yield row
      token = await take()
      if (is(token,']')) break
      if (!is(token,',')) throw syntax()
      token = await take()
    }
    await expect('}')
    if (await take()) throw syntax()
  } finally { await tokens.return(undefined) }
}
