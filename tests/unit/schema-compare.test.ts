import { describe, it, expect } from 'vitest'
import { compareSchemas } from '../../src/schema/compare'
import { compareSchemaSchema, comparisonSql, type CompareSchemaRequest } from '../../src/shared/schema-compare'
import type { CatalogRead } from '../../src/catalog/paging'
import type { ObjectDetail, CatalogObject } from '../../src/shared/catalog'
import type { SessionInfo } from '../../src/shared/contracts'
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002'
const request:CompareSchemaRequest={source:{sessionId:id,schema:'public'},target:{sessionId:other,schema:'public'},filter:'',kinds:['table']}
const table:CatalogObject={schema:'public',name:'table',identity:'1',kind:'table'}
const detail:ObjectDetail={object:table,sections:[{title:'Columns',columns:['Name','Type','Nullable','Default / expression','Identity','Generated','Comment'],rows:[['id','integer','true',null,'','',null]]}],definition:{sql:'CREATE TABLE "public"."table" (id integer);',source:'generated'},fetchedAt:'now',source:'catalog-connection'}
const session={id,engine:'postgres',database:'database',name:'name',transaction:'idle',autocommit:true} as SessionInfo
function reader(d: ObjectDetail|null=detail, overrides:Partial<SessionInfo>={},objects=[table]){return {getSession:()=>({...session,...overrides}),async explore(_id:string,o?:CatalogObject,_diagram?:unknown,read?:CatalogRead){return read?.incoming?{incoming:[]}:o?{detail:d??undefined}:{catalog:{objects,truncated:false,notice:'visible only'}}}}}
describe('schema comparison boundaries',()=>{
  it('rejects extra SQL, empty kinds and oversized filters',()=>{for(const input of [{...request,sql:'DROP TABLE x'},{...request,kinds:[]},{...request,filter:'x'.repeat(201)}])expect(()=>compareSchemaSchema.parse(input)).toThrow()})
  it('matches structural content across different catalog IDs and times',async()=>{const result=await compareSchemas(request,reader(),reader({...detail,object:{...table,identity:'99'},fetchedAt:'later'}));expect(result.objects[0].status).toBe('matching')})
  it('rejects mixed engines and active/manual transactions',async()=>{await expect(compareSchemas(request,reader(),reader(detail,{engine:'mysql'}))).rejects.toThrow(/same engine/);for(const state of [{transaction:'transaction' as const},{transaction:'failed' as const},{transaction:'unknown' as const},{autocommit:false}])await expect(compareSchemas(request,reader(),reader(detail,state))).rejects.toThrow(/Commit or roll back/)})
  it('classifies inaccessible or truncated metadata as unknown without destructive SQL',async()=>{for(const d of [null,{...detail,definition:{...detail.definition,truncated:true}},{...detail,sections:[{...detail.sections[0],truncated:true}]}]){const result=await compareSchemas(request,reader(null,{},[]),reader(d));expect(result.objects[0]).toMatchObject({status:'unknown',sql:[],destructiveSql:[]})}})
  it('refuses incomplete inventories, oversized scopes and changing identities',async()=>{const r=reader();await expect(compareSchemas(request,{...r,async explore(){return {catalog:{objects:[],truncated:true,notice:''}}}},r)).rejects.toThrow(/truncated/);await expect(compareSchemas(request,reader(detail,{},Array.from({length:41},(_,i)=>({...table,name:String(i)}))),r)).rejects.toThrow(/40 objects/);let reads=0;await expect(compareSchemas(request,{...r,async explore(id,o){if(o)return r.explore(id,o);return {catalog:{objects:[{...table,identity:String(++reads)}],truncated:false,notice:''}}}},r)).rejects.toThrow(/changed during/)} )
  it('generates qualified nullable numeric additions only and leaves conversions for manual review',async()=>{
    const source={...detail,sections:[{...detail.sections[0],rows:[...detail.sections[0].rows,['add"quote','integer','true',null,'','',null],['danger','text); DROP TABLE x;--','true',null,'','',null],['computed','integer','true','1','','s',null],['required','integer','false',null,'','',null]]}]}
    const result=await compareSchemas(request,reader(source),reader());expect(result.objects[0].sql).toEqual(['ALTER TABLE "public"."table" ADD "add""quote" INTEGER;']);expect(result.objects[0].notices.join(' ')).toContain('manual')
  })
  it('preserves reference SQL literally as inert line comments and excludes destructive SQL by default',async()=>{
    const text='CREATE TABLE x;\rDROP TABLE y;\u2028SELECT 1;\n*/ SELECT 2;'
    const result=await compareSchemas(request,reader(null,{},[]),reader({...detail,definition:{source:'native',sql:text}})),keys=result.objects.map(o=>o.key)
    expect(comparisonSql(result,keys).split('\n').filter(l=>l&&!l.startsWith('-- '))).toEqual([])
    expect(comparisonSql(result,keys,true).split('\n').filter(l=>l&&!l.startsWith('-- '))).toEqual(['DROP TABLE "public"."table";'])
    expect(comparisonSql(result,[])).not.toContain(text)
  })
  it('does not remap SQL strings or report equal definitions with different qualifiers',async()=>{const changed={...detail,definition:{source:'native' as const,sql:"SELECT 'public.table', * FROM other.table"}};expect((await compareSchemas(request,reader(),reader(changed))).objects[0].status).toBe('changed')})
})

it('preserves Oracle integer precision reported as NUMBER(*,0)',async()=>{
  const oracle={...detail,sections:[{title:'Columns',columns:['Name','Type','Precision','Scale','Nullable','Default','Identity','Virtual'],rows:[['id','NUMBER',null,'0','Y',null,'NO','NO']]}]}
  const target={...oracle,sections:[{...oracle.sections[0],rows:[]}]}
  const result=await compareSchemas(request,reader(oracle,{engine:'oracle'}),reader(target,{engine:'oracle'}))
  expect(result.objects[0].sql).toEqual(['ALTER TABLE "public"."table" ADD "id" NUMBER(*,0);'])
})

it('lists a large complete inventory without reading definitions or generating drops', async () => {
  const names = Array.from({ length: 101 }, (_, i) => ({ ...table, name: `table_${i}`, identity: String(i) }))
  const result = await compareSchemas({ ...request, mode: 'inventory' }, reader(null, {}, names), reader(null, {}, names.slice(0, 100)))
  expect(result.objects).toHaveLength(101)
  expect(result.objects.filter(object => object.status === 'unchecked')).toHaveLength(100)
  expect(result.objects.find(object => object.status === 'source-only')?.name).toBe('table_100')
  expect(result.objects.every(object => !object.source && !object.target && !object.sql.length && !object.destructiveSql.length)).toBe(true)
  const one = result.objects.find(object => object.name === 'table_100')!
  const focused = await compareSchemas({ ...request, selection: [one.key] }, reader(detail, {}, names), reader(null, {}, names.slice(0, 100)))
  expect(focused.objects.map(object => object.name)).toEqual(['table_100'])
})

it('withholds drop SQL if incoming reference metadata cannot be verified', async () => {
  const result = await compareSchemas(request, reader(null, {}, []), {
    ...reader(),
    async explore(_id, object, _diagram, read) {
      if (read?.incoming) throw new Error('Metadata denied')
      return reader().explore(_id, object, _diagram, read)
    }
  })
  expect(result.objects[0].destructiveSql).toEqual([])
  expect(result.objects[0].notices.join(' ')).toContain('Drop withheld')
})
