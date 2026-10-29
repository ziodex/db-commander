import { expect, it } from 'vitest'
import type { CatalogObject, ObjectDetail } from '../../src/shared/catalog'
import { objectScripts, qualifySourceDeclaration } from '../../src/shared/object-scripts'

const object: CatalogObject = { schema: 'odd"schema', name: 'find"it', kind: 'function', identity: '123', signature: 'integer, INOUT "strange name" text' }
const detail: ObjectDetail = { object, sections: [], source: 'catalog-connection', fetchedAt: '', definition: { source: 'native', sql: 'CREATE OR REPLACE FUNCTION test() RETURNS int LANGUAGE SQL AS $$SELECT 1$$' } }

it('scripts an overloaded PostgreSQL routine with quoted identifiers and its identity arguments', () => {
  const scripts = objectScripts('postgres', object, detail)
  expect(scripts.drop).toBe('DROP FUNCTION "odd""schema"."find""it"(integer, INOUT "strange name" text);')
  expect(scripts.alter).toBe(detail.definition.sql)
  expect(scripts.notice).toContain('do not run')
})
it('refuses an unsafe or missing overload signature instead of generating ambiguous SQL', () => {
  for (const signature of [undefined, 'integer); DROP TABLE x; --', "integer, 'text'"]) expect(objectScripts('postgres', { ...object, signature }, detail).drop).toBeUndefined()
})
it('qualifies triggers by engine and retains generated-definition warnings', () => {
  const trigger = { ...object, kind: 'trigger' as const, parent: 'table"name' }
  expect(objectScripts('postgres', trigger, detail).drop).toBe('DROP TRIGGER "find""it" ON "odd""schema"."table""name";')
  expect(objectScripts('sqlite', trigger, detail).drop).toBe('DROP TRIGGER "odd""schema"."find""it";')
  expect(objectScripts('mysql', trigger, { ...detail, definition: { source: 'generated', sql: 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @x=1' } }).notice).toContain('generated summary')
})
it('does not present an incomplete definition or a DuckDB macro body as CREATE SQL', () => {
  expect(objectScripts('postgres', object, { ...detail, definition: { ...detail.definition, truncated: true } }).create).toBeUndefined()
  expect(objectScripts('duckdb', { ...object, kind: 'macro', catalog: 'db' }, detail).create).toBeUndefined()
})
it('distinguishes SQL Server CREATE from ALTER definitions', () => {
  const view = { ...object, kind: 'view' as const }
  const sqlServer = { ...detail, definition: { source: 'native' as const, sql: 'ALTER VIEW [dbo].[v] AS SELECT 1 AS n' } }
  const scripts = objectScripts('sqlserver', view, sqlServer)
  expect(scripts.create).toBe('CREATE VIEW [dbo].[v] AS SELECT 1 AS n')
  expect(scripts.alter).toBe(sqlServer.definition.sql)
})
it('qualifies an unqualified DuckDB source draft with the selected catalog and schema', () => {
  const view = { ...object, catalog: 'data', schema: 'main', name: 'items', kind: 'view' as const }
  expect(qualifySourceDeclaration('duckdb', view, 'CREATE OR REPLACE VIEW items AS SELECT 2;')).toBe('CREATE OR REPLACE VIEW "data"."main"."items" AS SELECT 2;')
  expect(qualifySourceDeclaration('duckdb', view, 'CREATE VIEW "main"."items" AS SELECT 2;')).toBe('CREATE VIEW "main"."items" AS SELECT 2;')
})
it('wraps a MySQL routine containing semicolons with a safe client delimiter', () => {
  const procedure = { ...object, kind: 'procedure' as const }
  const source = { ...detail, definition: { source: 'native' as const, sql: 'CREATE PROCEDURE test.p() BEGIN SELECT 1; SELECT 2; END' } }
  expect(objectScripts('mysql', procedure, source).create).toBe('DELIMITER $$\nCREATE PROCEDURE test.p() BEGIN SELECT 1; SELECT 2; END\n$$\nDELIMITER ;')
})
it('reconstructs a DuckDB macro without pretending its defaults are known', () => {
  const macro = { ...object, schema: 'main', name: 'f', kind: 'macro' as const, catalog: 'data' }
  const value = { ...detail, object: macro, definition: { source: 'native' as const, sql: '(x + y)' }, sections: [{ title: 'Macro', columns: ['Body','Parameters','Kind','Return type','Parameter names (JSON)'], rows: [['(x + y)','[x, y]','macro',null,'["x","y"]']] }] }
  const scripts = objectScripts('duckdb', macro, value)
  expect(scripts.alter).toBe('CREATE OR REPLACE MACRO "data"."main"."f"("x", "y") AS (x + y)')
  expect(scripts.notice).toContain('parameter defaults and types may be omitted')
})
