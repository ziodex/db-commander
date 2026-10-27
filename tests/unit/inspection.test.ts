import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { gridRequestSchema, engineSchema } from '../../src/shared/contracts'
import { formatJson, hexDump, inspectionPrefix, INSPECT_LIMIT } from '../../src/shared/inspection'
import { inspectExpression } from '../../src/driver/inspection-sql'
import { GridSql } from '../../src/driver/grid-sql'

it('accepts only retained row/column identities, never renderer SQL or foreign-key values',()=>{
  const base={sessionId:randomUUID(),snapshotId:randomUUID()}
  expect(gridRequestSchema.safeParse({...base,action:'inspect-cell',row:0,column:1}).success).toBe(true)
  for(const extra of [{row:200,column:0},{row:0,column:-1},{row:0,column:0,table:{schema:'secret',name:'x'}},{row:0,column:0,sql:'SELECT password'}])expect(gridRequestSchema.safeParse({...base,action:'inspect-cell',...extra}).success).toBe(false)
  expect(gridRequestSchema.safeParse({...base,action:'follow-reference',row:0,referenceId:'a'.repeat(64),values:['forged']}).success).toBe(false)
})
it('formats JSON without rounding numbers, dropping duplicate keys or changing string escapes',()=>{
  const source='{"n":9007199254740993,"n":1.234567890123456789e+200,"s":"a\\n\\u1234","a":[true,null,{}]}'
  const formatted=formatJson(source)
  expect(formatted).toContain('9007199254740993');expect(formatted).toContain('1.234567890123456789e+200')
  expect(formatted.match(/"n"/g)).toHaveLength(2);expect(formatted).toContain('a\\n\\u1234')
  expect(JSON.parse(formatted)).toEqual(JSON.parse(source))
  expect(()=>formatJson('{bad}')).toThrow()
  expect(()=>formatJson('['.repeat(101)+'0'+']'.repeat(101))).toThrow(/100-level/)
})
it('shows exact binary bytes and offsets separately from UTF-8 text encoding',()=>{
  expect(hexDump('00ff8041','hex')).toMatchObject({bytes:4,text:'00000000  00 ff 80 41                                      ...A'})
  expect(hexDump('Ω','text').text).toContain('ce a9')
  const page=hexDump('ff'.repeat(5000),'hex',4096);expect(page.bytes).toBe(5000);expect(page.text).toMatch(/^00001000/)
  expect(()=>hexDump('0xz','hex')).toThrow();expect(()=>hexDump('a','hex')).toThrow()
  expect(inspectionPrefix('x'.repeat(INSPECT_LIMIT-1)+'😀')).toBe('x'.repeat(INSPECT_LIMIT-1))
})
it('generates bounded value conversions with quoted catalog identifiers for each engine',()=>{
  for(const engine of engineSchema.options) {
    const d=new GridSql(engine),name='name" ]; DROP TABLE x; --',column={name,type:engine==='oracle'?'CLOB':'TEXT',nullable:true,generated:false,hasDefault:false,primaryKey:false}
    const expr=inspectExpression(d,column)
    expect(expr.value).toContain(d.q(name));expect(expr.value).toContain('262145')
    if(engine!=='sqlite')expect(()=>inspectExpression(d,{...column,type:'untrusted_type); DROP TABLE x'})).toThrow()
    else expect(inspectExpression(d,{...column,type:'untrusted_type); DROP TABLE x'}).value).not.toContain('untrusted_type')
  }
})
it.each(['sqlserver','azure-sql'] as const)('inspects %s XML without applying a temporal conversion style',engine=>{
  const d=new GridSql(engine),column={name:'markup',type:'xml',nullable:true,generated:false,hasDefault:false,primaryKey:false}
  expect(inspectExpression(d,column)).toEqual({value:'SUBSTRING(CONVERT(nvarchar(max),[markup]),1,262145)',kind:"'text'"})
  expect(inspectExpression(d,{...column,type:'datetime2'}).value).toContain(',126)')
  expect(inspectExpression(d,{...column,type:'varbinary'})).toEqual({value:'SUBSTRING(CONVERT(varchar(max),[markup],2),1,262145)',kind:"'hex'"})
})
