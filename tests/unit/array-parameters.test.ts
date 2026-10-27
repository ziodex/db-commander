import { expect, it } from 'vitest'
import { arrayParameterInfo, arrayParameterTypes, compileParameters, parametersSchema, type QueryParameter } from '../../src/shared/parameters'
import { boundValue } from '../../src/driver/parameters'
import { engineSchema } from '../../src/shared/contracts'

const array = (type: QueryParameter['type'], values: unknown[], name = 'items'): QueryParameter => ({ name, type, value: JSON.stringify(values) })
it('validates homogeneous JSON arrays without accepting already-rounded JSON numbers', () => {
  for (const [type, values] of [
    ['text[]', ['', 'NULL', 'comma, brace{} slash\\ quote" Ω', null]],
    ['integer[]', ['9223372036854775807', '-9223372036854775808', null]],
    ['decimal[]', ['9007199254740993.12345678', '-0.00000001', null]],
    ['boolean[]', [true, false, null]], ['hex[]', ['', '00ff80', null]],
    ['date[]', ['2040-02-29', null]], ['timestamp[]', ['2040-02-29T01:02:03.123456', null]],
    ['timestamptz[]', ['2040-02-29T00:00:00.000001+05:45', null]]
  ] as [QueryParameter['type'], unknown[]][]) expect(parametersSchema.safeParse([array(type, values)]).success, type).toBe(true)
  for (const type of arrayParameterTypes) for (const values of [[], [null], [null, null]]) expect(parametersSchema.safeParse([array(type, values)]).success).toBe(true)
  for (const [type, value] of [
    ['integer[]', '[9007199254740993]'], ['decimal[]', '[1.000000000000000000001]'], ['integer[]', '[1.000000000000000000001]'],
    ['text[]', '{}'], ['text[]', 'null'], ['text[]', '"hello"'], ['text[]', '["hello",]'], ['text[]', '[["nested"]]'], ['text[]', '[{}]'],
    ['integer[]', '["9223372036854775808"]'], ['integer[]', '["1\\n"]'], ['hex[]', '["a\\n"]'], ['hex[]', '["fff"]'],
    ['boolean[]', '["true"]'], ['text[]', '[true]'], ['text[]', '[42]'], ['decimal[]', '["1e2"]'],
    ['date[]', '["2040-02-30"]'], ['timestamp[]', '["2040-02-29T00:00:00Z"]'], ['timestamptz[]', '["2040-02-29T00:00:00-00:00"]']
  ]) expect(parametersSchema.safeParse([{ name:'items', type, value }]).success, `${type}: ${value}`).toBe(false)
  // Scalar validators share the same strict end-of-input rule as array elements.
  for (const [type,value] of [['integer','1\n'],['hex','a\n']]) expect(parametersSchema.safeParse([{name:'value',type,value}]).success).toBe(false)
})
it('bounds array size and aggregate values, and reports invalid elements without their contents', () => {
  expect(parametersSchema.safeParse([array('integer[]', Array(1000).fill('1'))]).success).toBe(true)
  expect(parametersSchema.safeParse([array('integer[]', Array(1001).fill('1'))]).success).toBe(false)
  expect(parametersSchema.safeParse([array('text[]', ['x'.repeat(65533)])]).success).toBe(false)
  expect(parametersSchema.safeParse(Array.from({length:5},(_,i)=>array('text[]',['x'.repeat(60000)],'p'+i))).success).toBe(false)
  const secret = 'private-invalid-number', result = parametersSchema.safeParse([array('integer[]',['1',secret])])
  expect(result.success).toBe(false)
  if (!result.success) { expect(result.error.message).toContain('Array element 2'); expect(result.error.message).not.toContain(secret) }
  expect(()=>boundValue(array('integer[]',['1']))).toThrow(/compiled into scalar/)
})
it('derives a lossless common decimal type instead of rounding heterogeneous elements', () => {
  const p = array('decimal[]',['12345','0.12345678',null])
  expect(arrayParameterInfo(p).shape).toEqual({precision:13,scale:8})
  for (const engine of ['postgres','duckdb'] as const) {
    const result=compileParameters('SELECT :items',engine,[p])
    expect(result.sql.match(/DECIMAL\(13,8\)/g)).toHaveLength(3)
    expect(result.values.map(boundValue)).toEqual(['12345','0.12345678',null])
  }
  expect(parametersSchema.safeParse([array('decimal[]',['9'.repeat(38),'0.1'])]).success).toBe(false)
})
for (const engine of engineSchema.options) it(`expands portable ${engine} IN arrays with safe values, NULLs and stable bind order`, () => {
  const hostile = "x'); DELETE FROM customers; -- Ω", p=array('text[]',[hostile,null,hostile])
  const result=compileParameters("SELECT :n WHERE :n IN ( /* values */ :items -- list\n) OR :n NOT IN (:items);",engine,[{name:'n',type:'text',value:'normal'},p])
  expect(result.values.map(boundValue)).toEqual(['normal','normal',hostile,null,hostile,'normal',hostile,null,hostile])
  expect(result.sql).not.toContain(hostile); expect(result.sql).not.toContain('normal'); expect(result.sql).toContain('/* values */'); expect(result.sql).not.toMatch(/;$/)
  const marker = engine==='postgres'||engine==='duckdb'?'$9':engine==='oracle'?':sc_p9':['sqlserver','azure-sql'].includes(engine)?'@sc_p9':'?'
  expect(result.sql).toContain(marker)
  for (const type of arrayParameterTypes) {
    const empty=compileParameters('SELECT 1 WHERE 1 NOT IN (:items)',engine,[array(type,[])])
    expect(empty.values).toEqual([]); expect(empty.sql).toContain('SELECT CAST(NULL AS '); expect(empty.sql).toContain('WHERE 1 = 0')
    expect(empty.sql.includes('FROM dual')).toBe(engine==='oracle')
  }
  for (const sql of ['SELECT 1 WHERE 1 IN (:items,2)','SELECT 1 WHERE 1 IN (2,:items)','SELECT 1 WHERE 1 IN (:items + 1)']) expect(()=>compileParameters(sql,engine,[p])).toThrow(/only value/)
  const full=array('integer[]',Array(1000).fill('1'))
  expect(compileParameters('SELECT 1 WHERE 1 IN (:items)',engine,[full]).values).toHaveLength(1000)
  expect(()=>compileParameters('SELECT 1 WHERE 1 IN (:items) OR 2 IN (:items)',engine,[full])).toThrow(/after array expansion/)
  expect(()=>compileParameters('SELECT :n WHERE 1 IN (:items)',engine,[full,{name:'n',type:'integer',value:'1'}])).toThrow(/after array expansion/)
  if (!['postgres','duckdb'].includes(engine)) expect(()=>compileParameters('SELECT :items',engine,[p])).toThrow(/require IN/)
})
it('supports explicitly typed native PostgreSQL arrays and DuckDB lists, including empty and all-NULL values', () => {
  for (const engine of ['postgres','duckdb'] as const) for (const type of arrayParameterTypes) for (const values of [[],[null,null]]) {
    const result=compileParameters('SELECT :items',engine,[array(type,values)])
    expect(result.sql).toMatch(engine==='postgres'?/CAST\(ARRAY\[.*\] AS .+\[\]\)/:/CAST\(\[.*\] AS .+\[\]\)/)
    expect(result.values.map(boundValue)).toEqual(values)
  }
  for (const engine of ['postgres','duckdb'] as const) {
    const p=array('integer[]',['9223372036854775807',null,'-9223372036854775808'])
    const result=compileParameters('SELECT :n = ANY(:items)',engine,[{name:'n',type:'integer',value:'9223372036854775807'},p])
    expect(result.values.map(boundValue)).toEqual(['9223372036854775807','9223372036854775807',null,'-9223372036854775808'])
    const time=compileParameters('SELECT :items',engine,[array('timestamptz[]',['2040-02-29T00:00:00.000001+05:45'])])
    expect(time.values.map(boundValue)).toEqual(['2040-02-28T18:15:00.000001+00:00'])
    const bytes=compileParameters('SELECT :items',engine,[array('hex[]',['00ff80',null])])
    expect(bytes.values.map(boundValue)).toEqual([Buffer.from('00ff80','hex'),null])
  }
})
it('does not expand markers inside dialect literals or comments and honors MySQL quote modes', () => {
  const p=array('text[]',['exact'])
  const pg=compileParameters("SELECT ':ignored', $$ IN (:items) $$ WHERE 'x' IN (/* ( */ :items /* ) */)",'postgres',[p])
  expect(pg.values).toHaveLength(1); expect(pg.sql).toContain('$$ IN (:items) $$')
  const mysql=compileParameters(String.raw`SELECT '\' WHERE 'x' IN (:items)`,'mysql',[p],true,true)
  expect(mysql.values).toHaveLength(1)
  expect(()=>compileParameters('SELECT 1 WHERE 1 IN (:items); DELETE FROM customers','sqlite',[p])).toThrow(/one SELECT/)
})
