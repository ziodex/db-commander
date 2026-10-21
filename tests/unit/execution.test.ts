import { expect, it } from 'vitest'
import { currentExecution, executionUnits, failureSource } from '../../src/language/execution'
import { errorSource } from '../../src/shared/execution'
import { engineSchema, runSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) it(`${engine} locates repeated SQL by UTF-16 offsets, not text search`, () => {
  const select = engine === 'oracle' ? "SELECT '😀;Ω' FROM dual" : "SELECT '😀;Ω'"
  const separator = ['sqlserver', 'azure-sql'].includes(engine) ? '\r\nGO\r\n' : ';\r\n'
  const sql = `  ${select}${separator}  ${select}${separator}`
  const units = executionUnits(sql, engine)
  expect(units).toHaveLength(2)
  expect(units[1].start).toBe(sql.lastIndexOf('SELECT'))
  expect(currentExecution(sql, units[1].start + 2, engine).sql).toBe(units[1].sql)
  expect(failureSource(sql, engine, 1)).toEqual({ start: units[1].start, end: units[1].end, scope: ['sqlserver', 'azure-sql'].includes(engine) ? 'batch' : 'statement' })
})
it('keeps PostgreSQL dollar-quoted bodies, escape strings and nested comments intact', () => {
  const body = "DO $body$ BEGIN PERFORM ';'; PERFORM 2; END $body$"
  const sql = `SELECT E'a\\\';b';\n/* outer /* inner ; */ done */ ${body}; SELECT 9;`
  expect(executionUnits(sql, 'postgres')).toHaveLength(3)
  expect(currentExecution(sql, sql.indexOf('PERFORM 2'), 'postgres').sql).toContain(body)
  expect(currentExecution('SELECT 1;', 9, 'postgres').sql).toBe('SELECT 1')
  expect(() => currentExecution('SELECT 1;\n\nSELECT 2', 10, 'postgres')).toThrow('cursor')
  expect(() => currentExecution("SELECT 1; SELECT 'bad", 2, 'postgres')).toThrow('Unterminated')
  for (const sql of ['CREATE FUNCTION f() RETURNS INT LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;', 'CREATE RULE r AS ON INSERT TO t DO (INSERT INTO x VALUES(1); INSERT INTO y VALUES(2));']) expect(() => currentExecution(sql, 2, 'postgres')).toThrow('explicitly')
})
for (const engine of ['mysql', 'mariadb'] as const) it(`${engine} retains routine delimiters and honors session quoting modes`, () => {
  const routine = "CREATE PROCEDURE p() BEGIN SELECT ';'; SELECT 2; END"
  const sql = `SELECT 0;\nDELIMITER $$\n${routine}$$\nSELECT :value$$\nDELIMITER ;\nSELECT 3;`
  expect(currentExecution(sql, sql.indexOf('SELECT 2'), engine).sql).toBe(`DELIMITER $$\n${routine}$$`)
  expect(currentExecution(sql, sql.indexOf(':value'), engine).sql).toBe('SELECT :value')
  expect(() => currentExecution(routine + ';', routine.indexOf('SELECT 2'), engine)).toThrow('DELIMITER')
  const mode = { noBackslashEscapes: true, ansiQuotes: true }, unusual = String.raw`SELECT '\'; SELECT "a;b";`
  expect(executionUnits(unusual, engine, mode)).toHaveLength(2)
  expect(currentExecution(unusual, unusual.length, engine, mode).sql).toBe('SELECT "a;b"')
})
it('keeps Oracle PL/SQL and alternative quotes intact while allowing a bound current statement', () => {
  const body = "BEGIN NULL; DBMS_OUTPUT.PUT_LINE(q'[hello;world]'); END;"
  const sql = `${body}\n/\nSELECT :value FROM dual;`
  expect(currentExecution(sql, sql.indexOf('NULL'), 'oracle').sql).toBe(body)
  expect(currentExecution(sql, sql.indexOf(':value'), 'oracle').sql).toBe('SELECT :value FROM dual')
})
for (const engine of ['sqlserver', 'azure-sql'] as const) it(`${engine} executes the whole batch once and maps GO repeats to the original batch`, () => {
  const batch = "DECLARE @n INT=42;\r\nSELECT @n, 'GO;'; -- comment"
  const sql = `${batch}\r\nGO 3 -- repeat\r\nSELECT 4\r\nGO`
  const units = executionUnits(sql, engine)
  expect(units).toHaveLength(4); expect(units[0]).toEqual(units[2])
  expect(currentExecution(sql, sql.indexOf('@n,'), engine).sql).toBe(batch)
  expect(failureSource(sql, engine, 3)).toMatchObject({ start: sql.indexOf('SELECT 4'), scope: 'batch' })
})
it('keeps SQLite trigger bodies and nested CASE expressions atomic, but separates transactions', () => {
  const body = "CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(CASE WHEN 1 THEN CASE WHEN 2 THEN ';' END ELSE 'x' END); UPDATE t SET x=1; END;"
  const sql = `BEGIN;\n${body}\nCOMMIT;`
  expect(executionUnits(sql, 'sqlite')).toHaveLength(3)
  expect(currentExecution(sql, sql.indexOf('UPDATE'), 'sqlite').sql).toBe(body)
  expect(() => currentExecution(body.replace(' END;', ''), 2, 'sqlite')).toThrow('trigger')
  expect(currentExecution('SELECT 1; -- end', 2, 'sqlite').sql).toBe('SELECT 1;')
})
it('keeps DuckDB dollar-quoted macros intact and declines inaccurate native-unit mapping', () => {
  const sql = "CREATE MACRO text() AS $$hello;world$$; SELECT text();"
  expect(currentExecution(sql, 2, 'duckdb').sql).toBe('CREATE MACRO text() AS $$hello;world$$')
  expect(failureSource(sql, 'duckdb', 1, false, undefined, 3)).toEqual({ start: 0, end: sql.length, scope: 'script' })
})
it('maps failures into selections and delimiter prefixes only while the document is unchanged', () => {
  const document = 'SELECT 0;\r\n  SELECT 1; SELECT missing', start = document.indexOf('SELECT 1'), sql = document.slice(start)
  const source = { document, sql, start, end: document.length, prefixLength: 0 }
  expect(errorSource(source, failureSource(sql, 'postgres', 1), document)).toEqual({ start: document.indexOf('SELECT missing'), end: document.length })
  expect(errorSource(source, failureSource(sql, 'postgres', 1), document + ' ')).toBeUndefined()
  expect(failureSource(sql, 'postgres', 1, true)).toEqual({ start: 0, end: sql.length, scope: 'script' })
  for (const start of [-1, NaN, 0.5, sql.length + 1]) expect(errorSource(source, { start, end: sql.length, scope: 'script' }, document)).toBeUndefined()
  const routine = 'CREATE PROCEDURE p() BEGIN SELECT 1; END', prefix = 'DELIMITER $$\n'
  const wrapped = { document: routine, sql: prefix + routine + '$$', start: 0, end: routine.length, prefixLength: prefix.length }
  expect(errorSource(wrapped, failureSource(wrapped.sql, 'mysql', 0), routine)).toEqual({ start: 0, end: routine.length })
})
it('validates current-execution flags at IPC without accepting caller-provided failure locations', () => {
  const request = { sessionId: '00000000-0000-0000-0000-000000000000', sql: 'SELECT 1', maxRows: 1, singleUnit: true }
  expect(runSchema.parse(request).singleUnit).toBe(true)
  expect(() => runSchema.parse({ ...request, singleUnit: 'true' })).toThrow()
  expect(() => runSchema.parse({ ...request, failure: { start: 0, end: 1 } })).toThrow()
})
