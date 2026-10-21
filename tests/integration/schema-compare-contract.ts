import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { comparisonSql, type CompareScope, type CompareSchemaRequest } from '../../src/shared/schema-compare'
import { transactionalDdl } from '../../src/shared/schema-changes'

export async function verifySchemaComparison(config: ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-compare-')),engine=config.engine,embedded=['sqlite','duckdb'].includes(engine),events:DatabaseEvent[]=[]
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')}),prefix='cmp_'+randomUUID().replaceAll('-','').slice(0,8),q=(v:string)=>quoteIdentifier(v,engine)
  const sourceConfig={...config,...(embedded?{filePath:join(directory,'source.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const a=await driver.connect(sourceConfig),b=await driver.connect({...sourceConfig,...(embedded?{filePath:join(directory,'target.db')}:engine==='oracle'?{user:'dbcommander_compare'}:['mysql','mariadb'].includes(engine)?{database:'comparison_target'}:{})})
  const nativeSchema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?a.user.toUpperCase():['mysql','mariadb'].includes(engine)?a.database:'main'
  const newSchema=['postgres','sqlserver','azure-sql'].includes(engine)
  const left:CompareScope={sessionId:a.id,schema:nativeSchema,...(engine==='duckdb'?{catalog:a.database}:{})},right:CompareScope={sessionId:b.id,schema:newSchema?prefix:engine==='oracle'?b.user.toUpperCase():['mysql','mariadb'].includes(engine)?b.database:'main',...(engine==='duckdb'?{catalog:b.database}:{})}
  const full=(s:CompareScope,n:string)=>[...(s.catalog?[q(s.catalog)]:[]),q(s.schema),q(n)].join('.')
  const name=prefix+'_shared',onlySource=prefix+'_source',onlyTarget=prefix+'_target',odd=engine==='oracle'?"added ' ` ]":"added ' \" ` ]"
  const request:CompareSchemaRequest={source:left,target:right,kinds:['table'],filter:prefix}
  const drops:{sessionId:string;sql:string}[]=[]
  async function run(sql:string,id=a.id){const queryId=driver.start({sessionId:id,sql,maxRows:100});await driver.wait(id);const done=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>;expect(done?.status,`${sql}: ${done?.error}`).toBe('completed');return queryId}
  async function create(scope:CompareScope,n:string,extra=false){await run(`CREATE TABLE ${full(scope,n)} (${q('id')} INTEGER${extra?`,${q(odd)} INTEGER`:''})`,scope.sessionId);drops.unshift({sessionId:scope.sessionId,sql:`DROP TABLE ${full(scope,n)}`})}
  try {
    if(newSchema)await run(`CREATE SCHEMA ${q(right.schema)}`,b.id)
    await create(left,name,true);await create(right,name);await create(left,onlySource);await create(right,onlyTarget)
    const cached=await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42'),before=events.length
    const pending=driver.compareSchemas(request)
    for(const id of [a.id,b.id])expect(()=>driver.start({sessionId:id,sql:'SELECT 1',maxRows:1})).toThrow(/operation/)
    const result=await pending
    expect(events).toHaveLength(before)
    expect(result.objects.map(o=>[o.name,o.status])).toEqual(expect.arrayContaining([[name,'changed'],[onlySource,'source-only'],[onlyTarget,'target-only']]))
    const change=result.objects.find(o=>o.name===name)!
    expect(change.sql,JSON.stringify(change.source?.sections)).toHaveLength(1)
    expect(change.sql[0]).toContain(full(right,name));expect(change.sql[0]).toContain(q(odd))
    expect(result.objects.find(o=>o.name===onlySource)?.notices.join(' ')).toContain('commented reference')
    const defaultSql=comparisonSql(result,result.objects.map(o=>o.key)),dangerous=comparisonSql(result,result.objects.map(o=>o.key),true)
    expect(defaultSql.split('\n').filter(s=>s.startsWith('DROP TABLE'))).toHaveLength(0)
    expect(dangerous).toContain(`\nDROP TABLE ${full(right,onlyTarget)};`)
    await driver.exportCsv(cached,0,join(directory,'cached.csv'));expect(readFileSync(join(directory,'cached.csv'),'utf8')).toContain('42')
    const same=await driver.connect({...sourceConfig,sqliteMode:'read-write',duckdbMode:'read-write',environment:'production'})
    const equal=await driver.compareSchemas({...request,target:{...left,sessionId:same.id}})
    expect(equal.objects.every(o=>o.status==='matching'),JSON.stringify(equal.objects.map(o=>[o.name,o.status]))).toBe(true)
    expect(driver.sessionSafety(same.id)).toMatchObject({protected:true,unlockedUntil:0});await driver.disconnect(same.id)
    const begin=engine==='oracle'?'SAVEPOINT CMP_GUARD':['sqlserver','azure-sql'].includes(engine)?'BEGIN TRANSACTION':'BEGIN'
    await run(begin,b.id);await expect(driver.compareSchemas(request)).rejects.toThrow(/Commit or roll back/);await run('ROLLBACK',b.id)
    const migration=driver.prepareMigration({sourceId:result.migrationSourceId!,name:'compared_schema',selected:[change.key],transaction:transactionalDdl(engine)?'transaction':'caller',includeDestructive:false})
    expect(migration.sql).toContain(change.sql[0]);expect(migration.sql).toContain('Partial schema-comparison');expect(migration.sql).not.toMatch(/^DROP TABLE/m)
    await run(migration.sql,b.id)
    const refreshed=await driver.compareSchemas(request)
    expect(refreshed.objects.find(o=>o.name===name)?.sql).toEqual([])
    const detail=refreshed.objects.find(o=>o.name===name)?.target!
    expect(detail.sections.find(s=>s.title==='Columns')?.rows.flat()).toContain(odd)
    expect(driver.getSession(a.id).transaction).toBe('idle');expect(driver.getSession(b.id).transaction).toBe('idle')
  } finally {
    for(const id of [a.id,b.id])try{await run('ROLLBACK',id)}catch{}
    for(const drop of drops)try{await run(drop.sql,drop.sessionId)}catch{}
    if(newSchema)try{await run(`DROP SCHEMA ${q(right.schema)}`,b.id)}catch{}
    await driver.close();rmSync(directory,{recursive:true,force:true})
  }
}
