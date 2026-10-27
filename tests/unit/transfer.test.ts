import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { delimitedRow, openDelimited, parseDelimited } from '../../src/transfer/delimited'
import { exportFile, validateExportSql } from '../../src/transfer/export'
import { engineSchema } from '../../src/shared/contracts'
import { transferRequestSchema } from '../../src/shared/transfer'
import { bindRequest } from '../../src/driver/parameters'

async function parse(input: string, width = 1, delimiter: ',' | '\t' = ',') {
  async function* chunks() { for (let i = 0; i < input.length; i += width) yield input.slice(i, i + width) }
  const rows = []; for await (const row of parseDelimited(chunks(), delimiter)) rows.push(row); return rows
}
describe('data transfer file contracts', () => {
  it('preserves quoting, line endings, Unicode, NULL and empty text across chunk boundaries', async () => {
    const rows = [['heading', 'second'], ['comma,quote"\r\nΩ', null], ['', '\\N'], ['=SUM(A1)', 'last']]
    const data = '\uFEFF' + rows.map(row => delimitedRow(row, ',')).join('')
    for (const width of [1, 2, 7, 64]) expect(await parse(data, width)).toEqual(rows)
    expect(await parse('a\tb\n"two\tparts"\t\\N', 1, '\t')).toEqual([['a', 'b'], ['two\tparts', null]])
  })
  it.each(['a,b\n"unterminated', 'a,b\n"closed"x,1', 'a,b\nnot"quoted,1', 'a\0b', 'a'.repeat(16385), Array(102).fill('x').join(',')])('rejects malformed or excessive records (%#)', async input => {
    await expect(parse(input, 32768)).rejects.toThrow()
  })
  it('validates headers and UTF-8 without silently replacing invalid bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-files-')), file = join(directory, 'data.csv')
    try {
      for (const input of ['a,a\n1,2', 'a,\n1,2', '', Buffer.from([0xff, 0x2c, 0x61])]) {
        await writeFile(file, input); await expect(openDelimited(file, 'csv')).rejects.toThrow()
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('checks one explicit query while respecting strings, identifiers and comments', () => {
    for (const engine of engineSchema.options) {
      expect(() => validateExportSql("/* comment */ SELECT 'DROP; DELETE', 1; -- trailing", engine)).not.toThrow()
      for (const sql of ['DELETE FROM t', 'SELECT 1; SELECT 2', 'SELECT * INTO backup FROM t', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x']) expect(() => validateExportSql(sql, engine)).toThrow()
    }
  })
  it('accepts named export bindings without treating their names as SQL commands', () => {
    for (const engine of engineSchema.options) {
      const sql = "SELECT :update, :into, ':ignored; DELETE' /* :comment */"
      expect(() => validateExportSql(sql, engine)).not.toThrow()
      const parameters = [{ name: 'update', type: 'text' as const, value: "'; DELETE FROM customers; --" }, { name: 'into', type: 'null' as const, value: '' }]
      const bound = bindRequest({ sessionId: 'session', sql, parameters, maxRows: 1 }, engine).bound!
      expect(bound.sql).not.toContain(parameters[0].value); expect(bound.values).toEqual(parameters)
      expect(() => validateExportSql(sql + ' DELETE FROM customers', engine)).toThrow()
      for (const invalid of ["SELECT ':unterminated", 'SELECT 1 /* unfinished']) expect(() => validateExportSql(invalid, engine)).toThrow(/Complete SQL/)
    }
    expect(() => validateExportSql(String.raw`SELECT '\', :value`, 'mysql', { noBackslashEscapes: true, ansiQuotes: true })).not.toThrow()
    expect(() => validateExportSql(String.raw`SELECT '\', :value`, 'mysql')).toThrow(/Complete SQL/)
  })
  it('validates export parameters at IPC and never accepts bindings on imports', () => {
    const request = { action: 'export', sessionId: 'e21c06a3-a25c-475a-bac4-39ab8747cb0d', sql: 'SELECT :value', file: '/tmp/output.json', format: 'json', confirmed: true, parameters: [{ name: 'value', type: 'integer', value: '9223372036854775807' }] }
    expect(transferRequestSchema.parse(request)).toEqual(request)
    for (const patch of [{ parameters: [] }, { parameters: [{ ...request.parameters[0], value: '9223372036854775808' }] }, { bound: { sql: 'DELETE FROM t', values: [] } }]) expect(transferRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false)
    const { sql, ...rest } = request
    expect(transferRequestSchema.safeParse({ ...rest, action: 'import', format: 'csv', table: { schema: 'public', name: 't' }, mapping: ['id'], signature: 'a'.repeat(64) }).success).toBe(false)
  })
  it('publishes only complete exports and never replaces an existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-publish-')), file = join(directory, 'data.json'), controller = new AbortController()
    const request = { action: 'export' as const, sessionId: 'test', sql: 'SELECT 1', format: 'json' as const, file, confirmed: true as const }
    const context = { signal: controller.signal, progress() {} }
    const metadata = { type: 'result' as const, sessionId: 'test', queryId: 'test', result: { index: 0, statement: 'SELECT 1', columns: [{ name: 'value', typeId: 0 }], rowCount: 1, command: 'SELECT', truncated: false } }
    try {
      await expect(exportFile(request, context, async consume => { await consume(metadata); throw new Error('disk or query failed') })).rejects.toThrow('failed')
      expect(await readdir(directory)).toEqual([])
      await exportFile(request, context, async consume => { await consume(metadata); await consume({ type: 'rows', sessionId: 'test', queryId: 'test', index: 0, rows: [['9007199254740993']] }) })
      expect(JSON.parse(await readFile(file, 'utf8')).rows).toEqual([['9007199254740993']])
      await expect(exportFile(request, context, async () => { throw new Error('must not execute') })).rejects.toThrow('already exists')
      expect(await readdir(directory)).toEqual(['data.json'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
