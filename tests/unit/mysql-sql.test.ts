import { describe, expect, it } from 'vitest'
import { splitMysqlScript } from '../../src/shared/sql/mysql'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { legacyWorkspaceSchema as workspaceSchema, connectionSchema } from '../../src/shared/contracts'

describe('MySQL/MariaDB script boundaries', () => {
  it('handles backticks, quotes, backslash escapes and engine-specific comments', () => {
    expect(splitMysqlScript(String.raw`SELECT 'it\'s;safe', 'a''b', 1 AS \`x;y\`; # ignored;
SELECT 2--3; -- ignored;
/* comment; */ SELECT 4;`.replaceAll('\\`', '`'))).toHaveLength(3)
  })
  it('preserves version and MariaDB executable comments', () => {
    expect(splitMysqlScript('/*!40101 SET @a=1 */; /*M!100100 SET @b=2 */; /* ignored */;')).toEqual(['/*!40101 SET @a=1 */', '/*M!100100 SET @b=2 */'])
  })
  it('handles DELIMITER scripts with multiple statements in routines', () => {
    const sql = "-- heading\nDELIMITER $$\nCREATE PROCEDURE test() BEGIN SELECT ';'; SELECT 2; END$$\nDELIMITER ;\nCALL test();"
    expect(splitMysqlScript(sql)).toEqual(["CREATE PROCEDURE test() BEGIN SELECT ';'; SELECT 2; END", 'CALL test()'])
    expect(splitMysqlScript('DELIMITER //\nSELECT 1//\nDELIMITER ;\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })
  it('honors NO_BACKSLASH_ESCAPES and ANSI_QUOTES', () => {
    expect(splitMysqlScript(String.raw`SELECT 'a\', "identifier\"; SELECT 2;`, { noBackslashEscapes: true, ansiQuotes: true })).toHaveLength(2)
  })
  it('rejects malformed strings and misplaced directives before execution', () => {
    for (const sql of ["UPDATE t SET x=1; SELECT 'oops", 'SELECT `oops', 'SELECT 1; /* oops', 'SELECT 1\nDELIMITER $$\nSELECT 2$$']) expect(() => splitMysqlScript(sql)).toThrow()
    expect(splitMysqlScript('; # comment\n-- comment\n/* comment */')).toEqual([])
  })
  it('quotes MySQL and MariaDB identifiers with doubled backticks', () => {
    expect(quoteIdentifier('table`name', 'mysql')).toBe('`table``name`')
    expect(quoteIdentifier('table`name', 'mariadb')).toBe('`table``name`')
  })
})
describe('engine profile compatibility', () => {
  const profile = { name: 'legacy', host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', tls: 'verify-full' }
  it('accepts legacy PostgreSQL profiles for migration', () => {
    expect(workspaceSchema.parse({ sql: 'SELECT 1', profile }).profile?.engine).toBe('postgres')
  })
  it('persists each selected engine and rejects unknown drivers and secrets', () => {
    for (const engine of ['mysql', 'mariadb']) expect(workspaceSchema.parse({ sql: '', profile: { ...profile, engine } }).profile?.engine).toBe(engine)
    expect(connectionSchema.safeParse({ ...profile, engine: 'unknown', password: '' }).success).toBe(false)
    expect(workspaceSchema.safeParse({ sql: '', profile: { ...profile, engine: 'mysql', password: 'secret' } }).success).toBe(false)
  })
})
