import { expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertWriter } from '../../src/transfer/insert'
import { exportFile } from '../../src/transfer/export'
import { engineSchema, type Column, type DatabaseEngine, type DatabaseEvent } from '../../src/shared/contracts'
import { transferRequestSchema } from '../../src/shared/transfer'

const column = (engine: DatabaseEngine, type: 'text' | 'number' | 'binary', name = 'value'): Column => engine === 'postgres'
  ? { name, typeId: { text: 25, number: 1700, binary: 17 }[type] }
  : { name, typeId: { text: 253, number: 246, binary: 252 }[type], typeName: { text: 'TEXT', number: 'DECIMAL', binary: 'BINARY' }[type] }
it.each(engineSchema.options)('writes exact numbers, escaped text, bytes, NULL and empty text for %s', engine => {
  const writer = insertWriter(engine, { schema: 'schema ] ` "', name: 'table ] ` "' }, [column(engine,'number','id'),column(engine,'text','label'),column(engine,'binary','bytes'),column(engine,'text','note')])
  const value = "O'Brien \\ Ω 😀\n'); DELETE FROM target; --"
  const sql = writer.row(['9007199254740993.12345678',value,'0x00ff',null])
  expect(sql).toContain('9007199254740993.12345678'); expect(sql).toContain('NULL'); expect(sql).toMatch(/^INSERT INTO /)
  if (['mysql','mariadb'].includes(engine)) { expect(sql).toContain(Buffer.from(value).toString('hex')); expect(sql).toContain('USING utf8mb4') }
  else expect(sql).toContain("O''Brien")
  expect(writer.row(['0','','0x',null])).toContain('NULL')
  expect(() => writer.row(['1); DROP TABLE t',value,'0x00',null])).toThrow(/cannot represent/)
  expect(() => writer.row(['1',value,'0x0',null])).toThrow(/cannot represent/)
  expect(() => writer.row(['1','\0','0x00',null])).toThrow(/cannot represent/)
})
it('uses explicit temporal conversions without losing fractions or offsets', () => {
  const row = (engine: DatabaseEngine, typeId: number, typeName: string, value: string) => insertWriter(engine,{name:'t'},[{name:'at',typeId,typeName}]).row([value])
  expect(row('postgres',1184,'','2026-10-15 12:34:56.123456+02')).toContain("TIMESTAMPTZ '2026-10-15 12:34:56.123456+02:00'")
  expect(row('duckdb',0,'TIMESTAMP_NS','2026-10-15 12:34:56.123456789')).toContain('TIMESTAMP_NS')
  expect(row('sqlserver',0,'DateTimeOffset','2026-10-15 12:34:56.1234567+02:00')).toContain("CONVERT(datetimeoffset(7), '2026-10-15T12:34:56.1234567+02:00', 127)")
  expect(row('oracle',0,'DATE','2026-10-15 12:34:56')).toContain("TO_DATE('2026-10-15 12:34:56', 'FXYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')")
  expect(row('oracle',0,'TIMESTAMP WITH TIME ZONE','2026-10-15 12:34:56.123456789 +02:00')).toContain('TO_TIMESTAMP_TZ')
  expect(() => row('postgres',1082,'','15/10/2026')).toThrow()
  expect(() => row('sqlserver',0,'DateTime2','2026-10-15 12:34:56.123456789')).toThrow()
})
it('refuses ambiguous metadata, oversized values and unsafe identifiers without echoing data', () => {
  for (const columns of [[], [column('postgres','text',''),column('postgres','text')], [column('postgres','text','A'),column('postgres','text','a')], Array.from({length:101},(_,i)=>column('postgres','text',String(i)))]) expect(() => insertWriter('postgres',{name:'t'},columns)).toThrow()
  for(const name of ['','\nDROP TABLE','\0',' '.repeat(2)])expect(()=>insertWriter('postgres',{name},[column('postgres','text')])).toThrow()
  expect(()=>insertWriter('postgres',{name:'Ω'.repeat(32)},[column('postgres','text')])).toThrow(/identifier/)
  expect(()=>insertWriter('mysql',{name:'x'.repeat(65)},[column('mysql','text')])).toThrow(/identifier/)
  for(const [engine,metadata,value] of [
    ['postgres',{name:'x',typeId:1007},'{1,2}'], ['sqlite',{name:'x',typeId:0,typeName:'dynamic'},'secret'],
    ['sqlite',{name:'x',typeId:0,typeName:'TEXT'},'0x00'], ['mysql',{name:'x',typeId:255,typeName:'BINARY'},'0x00'],
    ['oracle',{name:'x',typeId:0,typeName:'VARCHAR2'},'Ω'.repeat(2001)]
  ] as const) expect(() => insertWriter(engine,{name:'t'},[metadata]).row([value])).toThrow(/cannot represent/)
  const writer=insertWriter('postgres',{name:'t'},[column('postgres','text')])
  expect(()=>writer.row(['x'.repeat(16385)])).toThrow();expect(()=>writer.row(['\ud800'])).toThrow();expect(()=>writer.row([])).toThrow(/match/)
})
it('validates target configuration at IPC and refuses targets on other formats', () => {
  const request={action:'export',sessionId:'e21c06a3-a25c-475a-bac4-39ab8747cb0d',sql:'SELECT 1',file:'/tmp/export.sql',format:'sql',confirmed:true,insertTarget:{schema:'public',name:'target'}}
  expect(transferRequestSchema.parse(request)).toEqual(request)
  for(const patch of [{insertTarget:undefined},{insertTarget:{name:'t',sql:'DELETE FROM t'}},{format:'json'},{insertTarget:{name:''}}])expect(transferRequestSchema.safeParse({...request,...patch}).success).toBe(false)
})
it('streams INSERT output, publishes only complete files and preserves existing destinations', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dbcommander-inserts-')),file=join(directory,'output.sql')
  const request={action:'export' as const,sessionId:'test',sql:'SELECT value',file,format:'sql' as const,confirmed:true as const,insertTarget:{name:'target'}}
  const metadata:DatabaseEvent={type:'result',sessionId:'test',queryId:'test',result:{index:0,statement:'SELECT value',columns:[column('postgres','number')],command:'SELECT',rowCount:null,truncated:false}}
  const context={signal:new AbortController().signal,progress(){}}
  try {
    await expect(exportFile(request,context,async consume=>{await consume(metadata);await consume({type:'rows',sessionId:'test',queryId:'test',index:0,rows:[['1'],['invalid']]})},'postgres')).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
    const controller=new AbortController()
    await expect(exportFile(request,{...context,signal:controller.signal},async consume=>{await consume(metadata);controller.abort();await consume({type:'rows',sessionId:'test',queryId:'test',index:0,rows:[['1']]})},'postgres')).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
    await exportFile(request,context,async consume=>{await consume(metadata);await consume({type:'rows',sessionId:'test',queryId:'test',index:0,rows:[['9223372036854775807']]})},'postgres')
    expect(await readFile(file,'utf8')).toContain('INSERT INTO "target" ("value") VALUES (9223372036854775807);')
    await expect(exportFile(request,context,async()=>{throw new Error('must not execute')},'postgres')).rejects.toThrow(/already exists/)
  } finally {await rm(directory,{recursive:true,force:true})}
})
