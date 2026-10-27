import { expect, it } from 'vitest'
import { inspectSqliteSql } from '../../src/driver/sqlite-sql'
import { quoteIdentifier, tablePreviewSql } from '../../src/shared/sql/common'
import { connectionSchema, legacyWorkspaceSchema as workspaceSchema } from '../../src/shared/contracts'

it('ignores parameters in SQLite strings, identifiers and comments', () => {
  expect(inspectSqliteSql(`SELECT '?', ':foo', '$x', '@y', "a?", [b?], \`c?\`, 'it''s ?'; -- ?\n/* :foo */`)).toEqual({ hasSql: true, hasParameters: false })
  expect(inspectSqliteSql('; -- ?\n /* $p */ ;')).toEqual({ hasSql: false, hasParameters: false })
  expect(inspectSqliteSql('SELECT column$part FROM t').hasParameters).toBe(false)
})
it('detects all unbound parameter styles across scripts before executing anything', () => {
  for (const parameter of ['?', '?123', ':named', '@named', '$named', '$name::suffix(test)', ':名前']) expect(inspectSqliteSql(`DELETE FROM t; SELECT ${parameter}`).hasParameters).toBe(true)
})
it('quotes SQLite identifiers and generates LIMIT previews', () => {
  expect(quoteIdentifier('a"b', 'sqlite')).toBe('"a""b"')
  expect(tablePreviewSql('odd"schema', 'odd"table', 'sqlite')).toBe('SELECT *\nFROM "odd""schema"."odd""table"\nLIMIT 1000;')
})
it('persists SQLite file/mode options without credentials and validates supported modes', () => {
  const config = connectionSchema.parse({ engine: 'sqlite', name: 'Local', host: 'local', port: 1, database: 'SQLite', user: 'local', password: '', tls: 'disable', filePath: '/tmp/local.sqlite', sqliteMode: 'read-only' })
  const { password: _password, ...profile } = config
  expect(workspaceSchema.parse({ sql: '', profile }).profile).toEqual(profile)
  expect(connectionSchema.safeParse({ ...config, sqliteMode: 'overwrite' }).success).toBe(false)
})
