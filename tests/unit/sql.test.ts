import { describe, expect, it } from 'vitest'
import { csvCell, firstKeyword, quoteIdentifier, splitPostgresScript } from '../../src/shared/sql/common'
import { connectionSchema, legacyWorkspaceSchema as workspaceSchema } from '../../src/shared/contracts'

describe('PostgreSQL script boundaries', () => {
  it('preserves strings, quoted identifiers, and dollar-quoted function bodies', () => {
    expect(splitPostgresScript(`SELECT ';' AS "a;b"; DO $body$ BEGIN RAISE NOTICE 'hello;'; END $body$; SELECT 3;`)).toHaveLength(3)
  })
  it('handles escaped strings, doubled quotes, nested comments and line comments', () => {
    const sql = String.raw`SELECT E'it\'s; safe', 'it''s; safe'; /* outside /* nested; */ still; */ SELECT 2; -- ignored;` + '\nSELECT 3;'
    expect(splitPostgresScript(sql)).toHaveLength(3)
  })
  it('does not start dollar quotes in identifiers', () => { expect(splitPostgresScript('SELECT a$tag$ FROM t; SELECT 2')).toHaveLength(2) })
  it('rejects unterminated syntax before executing any of the script', () => { expect(() => splitPostgresScript("DELETE FROM t; SELECT 'bad")).toThrow('Unterminated') })
  it('ignores empty statements and comments', () => { expect(splitPostgresScript('; -- empty\n /* comment */ ;')).toEqual([]) })
  it('recognizes unsupported protocol commands behind nested comments', () => { expect(firstKeyword('-- heading\n /* a /* b */ c */ COPY t TO STDOUT')).toBe('COPY') })
})
describe('serialization and validation', () => {
  it('quotes identifiers without interpreting SQL', () => expect(quoteIdentifier('x"; DROP TABLE y;--')).toBe('"x""; DROP TABLE y;--"'))
  it('preserves null, empty, commas, quotes and newlines in CSV', () => {
    expect([null, '', 'a,b', 'a"b', 'a\nb'].map(csvCell)).toEqual(['', '""', '"a,b"', '"a""b"', '"a\nb"'])
  })
  it('refuses credentials in recoverable workspace state', () => {
    const profile = { name: 'test', host: 'localhost', port: 5432, database: 'db', user: 'user', password: 'secret', tls: 'verify-full' }
    expect(connectionSchema.safeParse(profile).success).toBe(true)
    expect(workspaceSchema.safeParse({ sql: '', profile }).success).toBe(false)
  })
})
