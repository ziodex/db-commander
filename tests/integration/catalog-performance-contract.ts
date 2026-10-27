import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { PERFORMANCE_CATALOG_SIZES, catalogProcessMemory, performanceCatalogSeed, performanceTable } from '../fixtures/catalog-performance'

export async function verifyCatalogPerformance(config:ConnectionConfig) {
  const engine=config.engine, embedded=['sqlite','duckdb'].includes(engine), prefix='perf_'+randomUUID().replaceAll('-','').slice(0,8)+'_'
  if(!embedded && !/^dbcommander-test-\d+$/.test(process.env.SQLCOMMANDER_TEST_PROJECT??'')) throw new Error('Use the disposable Docker driver runner for server catalog performance checks.')
  const events: DatabaseEvent[] = [], measurements: unknown[] = []
  const driver = new DriverRegistry(event => { events.push(event) },{workerPath:resolve('out/main/sqlite-worker.cjs')})
  const session=await driver.connect(config)
  const q=(name:string)=>quoteIdentifier(name,engine), table=(index:number)=>performanceTable(index,prefix)
  let created=0, completed=false, failed=false
  async function run(sql:string,target=session.id) {
    events.length=0
    const id=driver.start({sessionId:target,sql,maxRows:1}); await driver.wait(target)
    const done=events.find(event => event.type==='complete' && event.queryId===id) as Extract<DatabaseEvent,{type:'complete'}>
    expect(done?.status,done?.error).toBe('completed')
    return events.flatMap(event => event.type==='rows' && event.queryId===id ? event.rows : [])
  }
  async function probe(target:string,tables:number,record:{refreshMs:number[];inspectMs:number[]}) {
    for(let sample=0;sample<3;sample++) {
      let start=performance.now(); const schema=await driver.schema(target); record.refreshMs.push(performance.now()-start)
      expect(schema.truncated).toBe(true); expect(schema.objects.flatMap(object => object.columns)).toHaveLength(10000)
      expect(schema.catalog?.truncated).toBe(true); expect(schema.catalog?.objects).toHaveLength(2000)
      expect(schema.catalog!.objects.every(object => object.kind==='table')).toBe(true)
      expect(schema.catalog!.objects.some(object => object.name===table(tables-1))).toBe(false)
      const last=schema.catalog!.objects.find(object => object.name===table(1900))!
      expect(last).toBeDefined(); expect(schema.objects.some(object => object.name===last.name)).toBe(false)
      start=performance.now(); const detail=await driver.inspectObject({sessionId:target,object:last}); record.inspectMs.push(performance.now()-start)
      expect(detail.definition.sql).toContain(last.name); expect(detail.sections.find(section => section.title==='Columns')!.rows).toHaveLength(8)
    }
    expect(Math.max(...record.refreshMs),'refresh').toBeLessThan(10000)
    expect(Math.max(...record.inspectMs),'inspection').toBeLessThan(5000)
  }
  try {
    for (const tables of PERFORMANCE_CATALOG_SIZES) {
      const record={tables,seedMs:0,refreshMs:[] as number[],inspectMs:[] as number[],memory:undefined as ReturnType<typeof catalogProcessMemory>|undefined}; measurements.push(record)
      let start=performance.now()
      while(created<tables) {
        const start=created; created=Math.min(tables,created+150)
        const sql=performanceCatalogSeed(engine,start,created,prefix)
        await run(['sqlite','duckdb','postgres'].includes(engine) ? 'BEGIN;\n'+sql+'\nCOMMIT;' : sql)
      }
      record.seedMs=performance.now()-start
      if(tables===PERFORMANCE_CATALOG_SIZES[0]) { await run(`INSERT INTO ${q(table(0))}(id,label) VALUES (1,'committed')`); if(engine==='oracle')await run('COMMIT') }
      await run(`${engine==='oracle'?'':engine==='sqlserver'?'BEGIN TRANSACTION;':'BEGIN;'} UPDATE ${q(table(0))} SET label='uncommitted' WHERE id=1`)
      events.length=0
      await probe(session.id,tables,record)
      expect(events).toEqual([]); expect(driver.getSession(session.id).transaction).toBe('transaction')
      expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`)).toEqual([['uncommitted']])
      await run('ROLLBACK'); expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`)).toEqual([['committed']])
      record.memory=catalogProcessMemory()
      console.log(engine,JSON.stringify(record))
    }
    if(engine==='sqlserver') {
      const azure=await driver.connect({...config,engine:'azure-sql'}), record={profile:'azure-sql',tables:PERFORMANCE_CATALOG_SIZES[1],refreshMs:[] as number[],inspectMs:[] as number[],memory:undefined as ReturnType<typeof catalogProcessMemory>|undefined}; measurements.push(record)
      try {
        await run(`BEGIN TRANSACTION; UPDATE ${q(table(0))} SET label='uncommitted' WHERE id=1`,azure.id); events.length=0
        await probe(azure.id,record.tables,record)
        expect(events).toEqual([]); expect(driver.getSession(azure.id).transaction).toBe('transaction')
        expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`,azure.id)).toEqual([['uncommitted']])
        await run('ROLLBACK',azure.id); expect(await run(`SELECT label FROM ${q(table(0))} WHERE id=1`,azure.id)).toEqual([['committed']])
        record.memory=catalogProcessMemory(); console.log('azure-sql',JSON.stringify(record))
      } finally { if(driver.getSession(azure.id).transaction!=='idle')await run('ROLLBACK',azure.id); await driver.disconnect(azure.id) }
    }
    completed=true
  } catch(error) { failed=true; throw error }
  finally {
    try {
      if(!embedded) {
        if(driver.getSession(session.id).transaction!=='idle')await run('ROLLBACK')
        for(let start=0;start<created;start+=150) await run(Array.from({length:Math.min(150,created-start)},(_,offset)=>`DROP TABLE IF EXISTS ${q(table(start+offset))}${engine==='oracle'?' PURGE':''};`).join('\n'))
      }
    } catch(error) { if(!failed)throw error;console.error('Catalog performance cleanup failed',engine,prefix,String(error)) }
    finally { await driver.close()
    if(process.env.SQLCOMMANDER_CATALOG_EVIDENCE) {
      mkdirSync(process.env.SQLCOMMANDER_CATALOG_EVIDENCE,{recursive:true})
      writeFileSync(resolve(process.env.SQLCOMMANDER_CATALOG_EVIDENCE,`${engine}-performance.json`),JSON.stringify({engine,version:session.version,completed,node:process.versions.node,platform:`${process.platform}/${process.arch}`,measurements},null,2))
    }
    }
  }
}
