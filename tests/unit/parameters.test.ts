import { expect,it } from 'vitest'
import { compileParameters,parameterNames,parametersSchema,type QueryParameter } from '../../src/shared/parameters'
import { engineSchema,runSchema } from '../../src/shared/contracts'
import { formatSql } from '../../src/language/format'
import { bindRequest, boundValue } from '../../src/driver/parameters'
const value:QueryParameter={name:'value',type:'text',value:"'; DELETE FROM customers; -- Ω"}
for(const engine of engineSchema.options)it(`compiles ${engine} marker spans without interpolating values`,()=>{
  const sql="SELECT :value, :value, ':ignored' /* :comment */ -- :line\n;",result=compileParameters(sql,engine,[value])
  expect(result.values).toEqual([value,value]);expect(result.sql).not.toContain(value.value);expect(result.sql).toContain("':ignored'");expect(result.sql).not.toMatch(/;$/)
  expect(parameterNames(sql,engine)).toEqual(['value'])
  expect(compileParameters('SELECT :go',engine,[{...value,name:'go'}]).values).toHaveLength(1)
  expect(()=>compileParameters('SELECT :missing',engine,[value])).toThrow(/exactly/)
  expect(()=>compileParameters('SELECT :value; DELETE FROM customers',engine,[value])).toThrow(/one SELECT/)
})
it('ignores dialect literals, casts, comments and quoted identifiers',()=>{
  expect(parameterNames('SELECT :id::bigint, $$ :ignored $$, $x$:also_ignored$x$, "colon:name" /* nested /* :skip */ ok */','postgres')).toEqual(['id'])
  expect(parameterNames("SELECT q'[it's :ignored]', :id FROM dual",'oracle')).toEqual(['id'])
  expect(parameterNames('SELECT :NEW.id,:old.id,:parent.id,:value FROM dual','oracle')).toEqual(['value'])
  expect(parameterNames("SELECT ':skip\\' :still_skip', :value, `:ignore`",'mysql')).toEqual(['value'])
  expect(()=>compileParameters("SELECT ':unterminated",'postgres',[value])).toThrow(/Unterminated/)
})
it('rejects invalid, duplicate, excessive and mixed native bindings before execution',()=>{
  for(const p of [{...value,type:'integer',value:'9223372036854775808'},{...value,type:'integer',value:'1.2'},{...value,type:'integer',value:'oops'},{...value,type:'hex',value:'0ff'},{...value,type:'null',value:'NULL'},{...value,type:'boolean',value:'1'}])expect(parametersSchema.safeParse([p]).success).toBe(false)
  for(const n of ['9223372036854775807','-9223372036854775808'])expect(parametersSchema.safeParse([{...value,type:'integer',value:n}]).success).toBe(true)
  expect(parametersSchema.safeParse([value,value]).success).toBe(false)
  expect(()=>compileParameters('SELECT :value, ?', 'mysql',[value])).toThrow(/native placeholder/)
  expect(()=>compileParameters('SELECT :value, @local', 'sqlserver',[value])).toThrow(/native placeholder/)
  expect(()=>compileParameters('SELECT :value /*! UNION SELECT 2 */','mysql',[value])).toThrow(/Executable comments/)
  expect(()=>compileParameters('SET @local=:value','mysql',[value])).toThrow(/one SELECT/)
  expect(()=>bindRequest({sessionId:'id',sql:'SELECT :value',maxRows:1},'postgres')).toThrow(/required/)
  expect(runSchema.safeParse({sessionId:'e21c06a3-a25c-475a-bac4-39ab8747cb0d',sql:'SELECT 1',maxRows:1,bound:{sql:'DELETE FROM customers',values:[]}}).success).toBe(false)
})

it('formats portable bind markers without changing their adjacency on every dialect',()=>{
  for(const engine of engineSchema.options){const sql='select :value, :id from customers where id=:id';const formatted=formatSql(sql,engine);expect(parameterNames(formatted,engine)).toEqual(['value','id']);expect(compileParameters(formatted,engine,[value,{name:'id',type:'integer',value:'1'}]).values).toHaveLength(3)}
})
it('uses native MySQL quote and backslash rules for marker discovery',()=>{
  const sql=String.raw`SELECT '\', :value`;expect(parameterNames(sql,'mysql',true,true)).toEqual(['value']);expect(compileParameters(sql,'mysql',[value],true,true).values).toEqual([value])
  const quoted=String.raw`SELECT "colon\", :value`;expect(parameterNames(quoted,'mariadb',false,true)).toEqual(['value'])
})
it('keeps standalone PostgreSQL and MySQL binary parameters binary without interpolating bytes',()=>{
  const bytes:QueryParameter={name:'bytes',type:'hex',value:'00ff8041'}
  expect(compileParameters('SELECT :bytes','postgres',[bytes]).sql).toBe('SELECT CAST($1 AS BYTEA)')
  for(const engine of ['mysql','mariadb'] as const)expect(compileParameters('SELECT :bytes',engine,[bytes]).sql).toBe('SELECT CAST(? AS BINARY)')
})

it('rejects semicolon-free T-SQL batches while preserving common single-statement forms',()=>{
  for(const sql of ['SELECT :value DELETE FROM customers','SELECT :value SELECT 2','SELECT :value SET IMPLICIT_TRANSACTIONS ON','UPDATE customers SET name=:value COMMIT','WITH c AS (SELECT 1 AS id) SELECT :value FROM c DROP TABLE customers'])expect(()=>compileParameters(sql,'sqlserver',[value])).toThrow()
  for(const sql of ['SELECT :value UNION ALL SELECT :value','INSERT INTO customers(name) SELECT :value','WITH c AS (SELECT :value AS name) UPDATE customers SET name=(SELECT name FROM c)','DELETE FROM customers OUTPUT deleted.name WHERE name=:value','SELECT :value WHERE EXISTS(SELECT 1 FROM customers)'])expect(compileParameters(sql,'azure-sql',[value]).values.length).toBeGreaterThan(0)
})

it('validates decimals without floating point conversion, rounding or permissive parsing',()=>{
  for(const n of ['0','-0','0.00','-0.001','9007199254740993.12345678','9'.repeat(38),'0.'+'9'.repeat(30),'12345678.'+'9'.repeat(30)])expect(parametersSchema.safeParse([{name:'n',type:'decimal',value:n}]).success,n).toBe(true)
  for(const n of ['', ' 1', '1 ', '1\n', '+1','01','1.','.1','1e3','NaN','Infinity','1,23','1_000','9'.repeat(39),'0.'+'9'.repeat(31),'123456789.'+'9'.repeat(30),"1'; DROP TABLE x; --"])expect(parametersSchema.safeParse([{name:'n',type:'decimal',value:n}]).success,n).toBe(false)
})
it('validates Gregorian dates and timezone-free microsecond timestamps without Date normalization',()=>{
  for(const d of ['1000-01-01','9999-12-31','2000-02-29','2024-02-29'])expect(parametersSchema.safeParse([{name:'d',type:'date',value:d}]).success,d).toBe(true)
  for(const d of ['2040-02-29\n','0999-12-31','0000-01-01','10000-01-01','1900-02-29','2023-02-29','2024-04-31','2024-00-10','2024-13-10','2024-01-00','2024-1-01','2024-01-01Z','2024-01-01 00:00:00'])expect(parametersSchema.safeParse([{name:'d',type:'date',value:d}]).success,d).toBe(false)
  for(const t of ['2024-02-29 23:59:59','2024-02-29T23:59:59.1','2024-02-29 23:59:59.123456','2026-03-29 02:30:00','1000-01-01 00:00:00','9999-12-31 23:59:59.499999'])expect(parametersSchema.safeParse([{name:'t',type:'timestamp',value:t}]).success,t).toBe(true)
  for(const t of ['2024-02-29 00:00:00\n','2023-02-29 00:00:00','2024-01-01 24:00:00','2024-01-01 23:60:00','2024-01-01 23:59:60','2024-01-01 00:00:00.1234567','2024-01-01 00:00:00Z','2024-01-01 00:00:00+02:00','2024-01-01','2024-01-01 0:00:00','2024-01-01 00:00:00.'])expect(parametersSchema.safeParse([{name:'t',type:'timestamp',value:t}]).success,t).toBe(false)
  expect(boundValue({name:'t',type:'timestamp',value:'2026-03-29T02:30:00.1'})).toBe('2026-03-29 02:30:00.100000')
  expect(boundValue({name:'d',type:'decimal',value:'9007199254740993.12345678'})).toBe('9007199254740993.12345678')
})
for(const engine of engineSchema.options)it(`compiles exact decimal and temporal parameters for ${engine} without embedding values`,()=>{
  const parameters:QueryParameter[]=[{name:'n',type:'decimal',value:'9007199254740993.12345678'},{name:'d',type:'date',value:'2040-02-29'},{name:'t',type:'timestamp',value:'2040-02-29T12:34:56.123456'}]
  const result=compileParameters('SELECT :n, :d, :t, :n',engine,parameters)
  expect(result.values).toEqual([...parameters,parameters[0]])
  for(const p of parameters)expect(result.sql).not.toContain(p.value)
  expect(result.sql).toContain(engine==='sqlite'?'AS TEXT':engine==='oracle'?'NUMBER(24,8)':'DECIMAL(24,8)')
  if(engine==='oracle'){expect(result.sql).toContain("NLS_NUMERIC_CHARACTERS=''.,''");expect(result.sql).toContain('FXYYYY-MM-DD HH24:MI:SS.FF6');expect(result.sql).toContain('NLS_CALENDAR=GREGORIAN')}
  if(['sqlserver','azure-sql'].includes(engine))expect(result.sql).toContain('DATETIME2(6)')
  expect(()=>compileParameters('SELECT :t',engine,[{name:'t',type:'timestamp',value:'2040-02-30 12:00:00'}])).toThrow()
})
