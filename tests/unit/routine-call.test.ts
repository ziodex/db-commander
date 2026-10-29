import { expect, it } from 'vitest'
import type { ObjectDetail } from '../../src/shared/catalog'
import { routineCall } from '../../src/shared/routine-call'
import { compileParameters } from '../../src/shared/parameters'

const detail: ObjectDetail = { object: { schema: 'public', name: 'f', kind: 'function', identity: '42', signature: 'integer' }, source: 'catalog-connection', fetchedAt: '', definition: { source: 'native', sql: 'CREATE FUNCTION ...' }, sections: [{ title: 'Parameters', columns: ['Name','Mode','Type','Position'], rows: [['value','i','integer','1'],['result','o','text','2']] }] }
it('builds a bound PostgreSQL call for the discovered overload, excluding OUT arguments', () => {
  const call = routineCall('postgres', detail)
  expect(call.sql).toBe('SELECT "public"."f"(CAST(:arg1 AS integer));')
  expect(call.arguments).toEqual([{ placeholder: 'arg1', name: 'value', type: 'integer', mode: 'IN' }])
  const bound = compileParameters(call.sql!, 'postgres', [{ name: 'arg1', type: 'integer', value: '12' }])
  expect(bound.sql).toContain('CAST(CAST($1 AS BIGINT) AS integer)'); expect(bound.values[0].value).toBe('12')
})
it('refuses incomplete or unsafe metadata and does not embed a type as arbitrary SQL', () => {
  const section = detail.sections[0]
  for (const type of ['integer); DROP TABLE t; --', 'integer) UNION SELECT 1']) {
    const result = routineCall('postgres', { ...detail, sections: [{ ...section, rows: [['x','i',type,'1']] }] })
    expect(result.sql).toBeUndefined()
  }
  expect(routineCall('postgres', { ...detail, sections: [{ ...section, truncated: true }] }).sql).toBeUndefined()
  expect(routineCall('postgres', { ...detail, sections: [{ ...section, rows: [['x','i','integer',null]] }] }).sql).toBeUndefined()
})
it('builds table-valued DuckDB macro calls using discovered names', () => {
  const macro: ObjectDetail = { ...detail, object: { ...detail.object, catalog: 'db', schema: 'main', kind: 'macro' }, sections: [{ title: 'Macro', columns: ['Kind','Parameter names (JSON)'], rows: [['table_macro','["id"]']] }] }
  expect(routineCall('duckdb', macro)).toMatchObject({ sql: 'SELECT * FROM "db"."main"."f"(:arg1);', arguments: [{ name: 'id' }] })
})
it('does not guess the SQL Server function kind or unsupported OUT parameters', () => {
  const value: ObjectDetail = { ...detail, sections: [{ title: 'Parameters', columns: ['Name','Type','Length','Output','Position'], rows: [['@x','int','4','1','1']] }] }
  expect(routineCall('sqlserver', value).sql).toBeUndefined()
  value.sections.push({ title: 'Routine', columns: ['Kind','Description'], rows: [['FN','SQL_SCALAR_FUNCTION']] })
  expect(routineCall('sqlserver', value).sql).toBeUndefined()
})
it('builds a PostgreSQL procedure call with typed input and an output placeholder', () => {
  const procedure: ObjectDetail = { ...detail, object: { ...detail.object, kind: 'procedure' }, sections: [{ ...detail.sections[0], rows: [['value','i','integer','1'],['result','o','integer','2']] }] }
  const call = routineCall('postgres', procedure)
  expect(call.sql).toBe('CALL "public"."f"(CAST(:arg1 AS integer), NULL);')
  expect(compileParameters(call.sql!, 'postgres', [{ name: 'arg1', type: 'integer', value: '7' }]).sql).toBe('CALL "public"."f"(CAST(CAST($1 AS BIGINT) AS integer), NULL)')
})
it('builds typed SQL Server local variables for a bound procedure call', () => {
  const procedure: ObjectDetail = { ...detail, object: { ...detail.object, schema: 'dbo', kind: 'procedure' }, sections: [{ title: 'Routine', columns: ['Kind'], rows: [['P ']] }, { title: 'Parameters', columns: ['Name','Type','Output','Position'], rows: [['@value','int','0','1']] }] }
  const call = routineCall('sqlserver', procedure)
  expect(call.sql).toBe('EXEC [dbo].[f] :arg1;')
  const bound = compileParameters(call.sql!, 'sqlserver', [{ name: 'arg1', type: 'integer', value: '7' }])
  expect(bound.sql).toBe('DECLARE @sc_arg1 BIGINT = CAST(@sc_p1 AS BIGINT);\nEXEC [dbo].[f] @sc_arg1')
  expect(bound.values[0].value).toBe('7')
})
it('rejects extra SQL and arbitrary expressions in a bound procedure call', () => {
  const value = [{ name: 'arg1', type: 'integer' as const, value: '7' }]
  for (const sql of ['CALL public.p(:arg1); DROP TABLE x;', 'CALL public.p(:arg1 + 1)', 'CALL public.p((SELECT :arg1))', 'CALL public.p(CAST(:arg1 AS integer)); SELECT 1']) expect(() => compileParameters(sql, 'postgres', value), sql).toThrow()
  for (const sql of ['EXEC dbo.p :arg1; DELETE FROM t', 'EXEC @name :arg1', 'EXEC dbo.p :arg1 OUTPUT']) expect(() => compileParameters(sql, 'sqlserver', value), sql).toThrow()
})
