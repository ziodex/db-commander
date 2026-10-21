import { describe, expect, it } from 'vitest'
import { builderSql } from '../../src/query-builder/sql'
import { builderQuerySchema, emptyBuilder, type BuilderQuery } from '../../src/shared/query-builder'
import { engineSchema, type SchemaSnapshot } from '../../src/shared/contracts'
import { compileParameters, parameterNames } from '../../src/shared/parameters'

const table = {schema:'sample',name:"odd ' ` ] table"}
const snapshot: SchemaSnapshot = {database:'db',source:'catalog-connection',fetchedAt:'2026-10-14T00:00:00Z',truncated:false,objects:[{...table,kind:'table',columns:[{name:'id',type:'INTEGER',nullable:false,ordinal:1},{name:'category',type:'VARCHAR(30)',nullable:true,ordinal:2}]}]}
const base = ():BuilderQuery => ({...emptyBuilder(),sources:[{table}],projections:[{column:{source:0,column:'id'},aggregate:'none',alias:'result'}]})
describe('visual SELECT builder',()=>{
  it.each(engineSchema.options)('quotes identifiers and generates bounded bound-parameter SELECT for %s',engine=>{
    const query = base(); query.filters=[{column:{source:0,column:'id'},operator:'gte',parameter:'min_id'}];query.distinct=true;query.limit=7;query.order=[{projection:0,direction:'desc'}]
    const result=builderSql(query,engine,snapshot)
    expect(result.parameters).toEqual(['min_id']);expect(parameterNames(result.sql,engine)).toEqual(['min_id'])
    expect(result.sql).toContain('ORDER BY 1 DESC')
    expect(result.sql).toMatch(engine==='oracle'?/FETCH FIRST 7 ROWS ONLY;$/ : ['sqlserver','azure-sql'].includes(engine)?/^SELECT DISTINCT TOP \(7\)/:/LIMIT 7;$/)
    expect(()=>compileParameters(result.sql,engine,[{name:'min_id',type:'integer',value:'9007199254740993'}])).not.toThrow()
  })
  it('builds composite self joins and groups every non-aggregate output with aggregate HAVING',()=>{
    const query=base();query.sources.push({table,join:{type:'left',on:[{left:{source:0,column:'id'},right:'id'},{left:{source:0,column:'category'},right:'category'}]}})
    query.projections=[{column:{source:0,column:'category'},aggregate:'none',alias:'category'},{column:{source:1,column:'id'},aggregate:'sum',alias:'total'},{aggregate:'count-all',alias:'rows'}]
    query.having=[{projection:1,operator:'gt',parameter:'minimum'},{projection:2,operator:'gte',parameter:'minimum'}];query.havingLogic='or'
    const result=builderSql(query,'postgres',snapshot)
    expect(result.sql).toContain('LEFT JOIN');expect(result.sql).toContain('"t1"."id" = "t2"."id" AND "t1"."category" = "t2"."category"')
    expect(result.sql).toContain('GROUP BY "t1"."category"');expect(result.sql).toContain('HAVING SUM("t2"."id") > :minimum\n  OR COUNT(*) >= :minimum');expect(result.parameters).toEqual(['minimum'])
  })
  it('supports NULL predicates, literal LIKE parameters and aggregate-only queries without GROUP BY',()=>{
    const query=base();query.projections=[{column:{source:0,column:'category'},aggregate:'count-distinct',alias:'categories'}]
    query.filters=[{column:{source:0,column:'category'},operator:'is-null',parameter:''},{column:{source:0,column:'category'},operator:'like',parameter:'pattern'}];query.filterLogic='or'
    const result=builderSql(query,'sqlite',snapshot)
    expect(result.sql).toContain('COUNT(DISTINCT "t1"."category")');expect(result.sql).not.toContain('GROUP BY');expect(result.sql).toContain('IS NULL\n  OR "t1"."category" LIKE :pattern')
  })
  it('rejects arbitrary SQL, invalid enums and bounds before compilation',()=>{
    for(const bad of [{...base(),sql:'DROP DATABASE x'}, {...base(),limit:1001}, {...base(),sources:Array(6).fill({table})}, {...base(),projections:[{aggregate:'SUM);DROP',alias:'x'}]}, {...base(),filters:[{column:{source:0,column:'id'},operator:'eq OR 1=1',parameter:'x'}]}]) expect(builderQuerySchema.safeParse(bad).success).toBe(false)
  })
  it('rejects stale, truncated or ambiguous metadata and references outside the current sources',()=>{
    expect(()=>builderSql(base(),'postgres',{...snapshot,truncated:true})).toThrow(/incomplete/)
    expect(()=>builderSql(base(),'postgres',{...snapshot,objects:[]})).toThrow(/unavailable/)
    expect(()=>builderSql(base(),'postgres',{...snapshot,objects:[...snapshot.objects,...snapshot.objects]})).toThrow(/ambiguous/)
    const query=base();query.projections[0].column={source:1,column:'id'};expect(()=>builderSql(query,'postgres',snapshot)).toThrow(/Column/)
    query.projections[0].column={source:0,column:'id"; DROP TABLE x;--'};expect(()=>builderSql(query,'postgres',snapshot)).toThrow(/Column/)
  })
  it('rejects invalid grouping, duplicate aliases/sorts, malformed parameters and nonnumeric sums',()=>{
    const cases:[BuilderQuery,RegExp][]=[]
    cases.push([{...base(),having:[{projection:0,operator:'eq',parameter:'x'}]},/aggregate/])
    cases.push([{...base(),projections:[base().projections[0],{...base().projections[0],alias:'RESULT'}]},/distinct/])
    cases.push([{...base(),projections:[{column:{source:0,column:'category'},aggregate:'sum',alias:'x'}]},/numeric/])
    cases.push([{...base(),order:[{projection:2,direction:'asc'}]},/unavailable/])
    cases.push([{...base(),order:[{projection:0,direction:'asc'},{projection:0,direction:'desc'}]},/once/])
    cases.push([{...base(),filters:[{column:{source:0,column:'id'},operator:'eq',parameter:'x;DROP'}]},/parameter name/])
    cases.push([{...base(),filters:[{column:{source:0,column:'id'},operator:'is-null',parameter:'x'}]},/do not take/])
    for(const [query,error] of cases) expect(()=>builderSql(query,'postgres',snapshot)).toThrow(error)
  })
  it('rejects disconnected/forward/duplicate joins and keeps output aliases inert',()=>{
    const query=base();query.sources.push({table});expect(()=>builderSql(query,'postgres',snapshot)).toThrow(/Choose a join/)
    query.sources[1].join={type:'inner',on:[{left:{source:1,column:'id'},right:'id'}]};expect(()=>builderSql(query,'postgres',snapshot)).toThrow(/earlier source/)
    const pair={left:{source:0,column:'id'},right:'id'};query.sources[1].join.on=[pair,pair];expect(()=>builderSql(query,'postgres',snapshot)).toThrow(/Duplicate/)
    const safe=base();safe.projections[0].alias='a"; DROP TABLE x;--'
    expect(builderSql(safe,'postgres',snapshot).sql).toContain('AS "a""; DROP TABLE x;--"')
    safe.projections[0].alias='界'.repeat(22);expect(()=>builderSql(safe,'postgres',snapshot)).toThrow(/UTF-8/)
  })
})
