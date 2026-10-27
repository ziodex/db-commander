import {expect,it,vi} from 'vitest'
import {mysqlSchema} from '../../src/driver/mysql-schema'
import type {Cell} from '../../src/shared/contracts'
function fixture(tables:Cell[][],columns:Cell[][]=[]) {
  const query=vi.fn(async()=>tables).mockResolvedValueOnce(tables).mockResolvedValueOnce(columns)
  return {query,read:()=>mysqlSchema(query,'odd\' database')}
}
it('returns an empty snapshot without issuing an empty column-name predicate',async()=>{
  const {query,read}=fixture([])
  expect(await read()).toMatchObject({objects:[],truncated:false,source:'catalog-connection'})
  expect(query).toHaveBeenCalledTimes(1)
})
it('binds names as data and retains views and visible objects without exposed columns',async()=>{
  const tables:Cell[][]=[['odd\' database','odd` table','BASE TABLE'],['odd\' database','view name','VIEW']]
  const {query,read}=fixture(tables,[['odd` table','exact decimal','decimal(38,18)','NO','1']])
  const result=await read()
  expect(result.objects).toMatchObject([{name:'odd` table',kind:'table',columns:[{name:'exact decimal',type:'decimal(38,18)',nullable:false,ordinal:1}]},{name:'view name',kind:'view',columns:[]}])
  expect(query.mock.calls[1]).toEqual([expect.not.stringContaining('odd` table'),["odd' database",'odd` table','view name']])
})
it('retains an overflow sentinel when more than 2000 objects have no visible columns',async()=>{
  const {read}=fixture(Array.from({length:2001},(_,i)=>['db','table'+i,'BASE TABLE']))
  const result=await read();expect(result.objects).toHaveLength(2000);expect(result.truncated).toBe(true)
})
it('counts empty-object rows toward the column preview and preserves native column order',async()=>{
  const tables:Cell[][]=[['db','a','BASE TABLE'],['db','b','VIEW'],['db','c','BASE TABLE']]
  const columns:Cell[][]=[...Array.from({length:5000},(_,i)=>['a','a'+i,'int','YES',String(i+1)]),...Array.from({length:5001},(_,i)=>['c','c'+i,'int','NO',String(i+1)])]
  const result=await fixture(tables,columns).read()
  expect(result.truncated).toBe(true);expect(result.objects.map(object=>object.columns.length)).toEqual([5000,0,4999])
  expect(result.objects[2].columns.at(-1)).toMatchObject({name:'c4998',ordinal:4999,nullable:false})
})
it('propagates column-read errors instead of reporting a complete empty schema',async()=>{
  const failure=new Error('metadata connection timed out'),query=vi.fn().mockResolvedValueOnce([['db','t','BASE TABLE']]).mockRejectedValueOnce(failure)
  await expect(mysqlSchema(query,'db')).rejects.toBe(failure)
})
