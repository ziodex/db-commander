import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { emptyBuilder, type BuilderQuery } from '../../src/shared/query-builder'
import type { QueryParameter } from '../../src/shared/parameters'

export async function verifyQueryBuilder(config:ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-builder-')),events:DatabaseEvent[]=[],engine=config.engine,embedded=['sqlite','duckdb'].includes(engine)
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')})
  const local={...config,...(embedded?{filePath:join(directory,'builder.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const session=await driver.connect(local), prefix='qb_'+randomUUID().slice(0,8), parent=prefix+" odd';--",child=prefix+'_items',view=prefix+'_view'
  const schema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?session.user.toUpperCase():embedded?'main':session.database
  const location={schema,...(engine==='duckdb'?{catalog:session.database}:{})},q=(s:string)=>quoteIdentifier(s,engine),full=(name:string)=>[location.catalog,schema,name].filter((s):s is string=>!!s).map(q).join('.')
  const numeric=engine==='oracle'?'NUMBER(19)':'BIGINT'
  async function run(sql:string,parameters?:QueryParameter[],id=session.id) {
    const queryId=driver.start({sessionId:id,sql,parameters,maxRows:1000});await driver.wait(id)
    const done=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(done?.status,`${sql}: ${done?.error}`).toBe('completed')
    return {queryId,rows:events.flatMap(e=>e.type==='rows'&&e.queryId===queryId?e.rows:[])}
  }
  const review=(query:BuilderQuery,id=session.id)=>driver.prepareQueryBuilder({sessionId:id,query})
  const plain=():BuilderQuery=>({...emptyBuilder(),sources:[{table:{...location,name:parent}}],projections:[{column:{source:0,column:'id'},aggregate:'none',alias:'id'}],order:[{projection:0,direction:'asc'}]})
  try {
    await run(`CREATE TABLE ${full(parent)} (${q('id')} ${numeric},${q('tenant')} INTEGER,${q('label')} VARCHAR(80))`)
    await run(`CREATE TABLE ${full(child)} (${q('parent_id')} ${numeric},${q('tenant')} INTEGER,${q('amount')} INTEGER)`)
    await run(`INSERT INTO ${full(parent)} VALUES (1,7,'one')`);await run(`INSERT INTO ${full(parent)} VALUES (2,7,NULL)`);await run(`INSERT INTO ${full(parent)} VALUES (9007199254740993,7,'big')`)
    for(const row of ['1,7,10','1,7,20','1,8,999'])await run(`INSERT INTO ${full(child)} VALUES (${row})`)
    if(engine==='oracle')await run('COMMIT')
    await run(`CREATE VIEW ${full(view)} AS SELECT ${q('id')} FROM ${full(parent)}`)
    const cached=await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42'),before=events.length
    const query=plain();query.sources.push({table:{...location,name:child},join:{type:'left',on:[{left:{source:0,column:'id'},right:'parent_id'},{left:{source:0,column:'tenant'},right:'tenant'}]}})
    query.projections.push({column:{source:1,column:'amount'},aggregate:'sum',alias:'total'},{column:{source:1,column:'parent_id'},aggregate:'count',alias:'matches'})
    const pending=review(query)
    expect(()=>driver.start({sessionId:session.id,sql:'SELECT 1',maxRows:1})).toThrow(/operation/)
    const result=await pending;expect(result.sql).toContain('LEFT JOIN');expect(result.sql).toContain('GROUP BY');expect(events).toHaveLength(before);expect(driver.getSession(session.id).transaction).toBe('idle')
    await driver.exportCsv(cached.queryId,0,join(directory,'cached.csv'));expect(readFileSync(join(directory,'cached.csv'),'utf8')).toContain('42')
    expect((await run(result.sql)).rows).toEqual([['1','30','2'],['2',null,'0'],['9007199254740993',null,'0']])
    query.sources[1].join!.type='inner';query.having=[{projection:1,operator:'gt',parameter:'min_total'}]
    expect((await run((await review(query)).sql,[{name:'min_total',type:'integer',value:'15'}])).rows).toEqual([['1','30','2']])
    const exact=plain();exact.filters=[{column:{source:0,column:'id'},operator:'eq',parameter:'key'}]
    expect((await run((await review(exact)).sql,[{name:'key',type:'integer',value:'9007199254740993'}])).rows).toEqual([['9007199254740993']])
    const attack=plain();attack.filters=[{column:{source:0,column:'label'},operator:'eq',parameter:'literal'}]
    expect((await run((await review(attack)).sql,[{name:'literal',type:'text',value:"one' OR 1=1 --"}])).rows).toEqual([])
    attack.filters=[{column:{source:0,column:'label'},operator:'is-null',parameter:''}]
    expect((await run((await review(attack)).sql)).rows).toEqual([['2']])
    attack.filterLogic='or';attack.filters.push({column:{source:0,column:'label'},operator:'like',parameter:'pattern'})
    expect((await run((await review(attack)).sql,[{name:'pattern',type:'text',value:'bi%'}])).rows).toEqual([['2'],['9007199254740993']])
    const distinct=plain();distinct.sources=[{table:{...location,name:child}}];distinct.projections=[{column:{source:0,column:'tenant'},aggregate:'none',alias:'tenant'}];distinct.distinct=true;distinct.limit=1;distinct.order=[{projection:0,direction:'desc'}]
    expect((await run((await review(distinct)).sql)).rows).toEqual([['8']])
    const onlyView=plain();onlyView.sources[0].table.name=view
    expect((await run((await review(onlyView)).sql)).rows).toHaveLength(3)
    const aggregates=plain();aggregates.sources=[{table:{...location,name:child}}];aggregates.order=[]
    aggregates.projections=[{column:{source:0,column:'tenant'},aggregate:'count-distinct',alias:'tenants'},...(['avg','min','max'] as const).map(aggregate=>({column:{source:0,column:'amount'},aggregate,alias:aggregate}))]
    const aggregateRows=(await run((await review(aggregates)).sql)).rows
    expect(aggregateRows).toHaveLength(1);expect(aggregateRows[0].map(Number)).toEqual([2,343,10,999])
    const self=plain();self.sources.push({table:{...location,name:parent},join:{type:'inner',on:[{left:{source:0,column:'id'},right:'id'}]}});self.projections=[{aggregate:'count-all',alias:'count'}];self.order=[]
    expect((await run((await review(self)).sql)).rows).toEqual([['3']])
    const other=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write',environment:'production'})
    expect((await review(plain(),other.id)).sql).toContain('SELECT');expect(driver.sessionSafety(other.id)).toMatchObject({protected:true,unlockedUntil:0});await driver.disconnect(other.id)
    const begin=engine==='oracle'?'SAVEPOINT QB_GUARD':['sqlserver','azure-sql'].includes(engine)?'BEGIN TRANSACTION':'BEGIN'
    await run(begin);await expect(review(plain())).rejects.toThrow(/commit or roll back/);expect(driver.getSession(session.id).transaction).toBe('transaction');await run('ROLLBACK')
    await run(`ALTER TABLE ${full(parent)} DROP COLUMN ${q('label')}`)
    await expect(review(attack)).rejects.toThrow(/Column.*unavailable/)
  } finally {
    try{if(driver.getSession(session.id).transaction!=='idle')await run('ROLLBACK')}catch{}
    try{await run(`DROP VIEW ${full(view)}`)}catch{}
    for(const name of [child,parent])try{await run(`DROP TABLE ${full(name)}`)}catch{}
    await driver.close();rmSync(directory,{recursive:true,force:true})
  }
}
