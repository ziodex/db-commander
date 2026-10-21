import { randomUUID } from 'node:crypto'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig,DatabaseEvent } from '../../src/shared/contracts'
import type { ActivityAction,ActivityActionReview } from '../../src/shared/activity-control'
import { activityMonitor } from '../activity-fixture'

export async function verifyActivityControls(config:ConnectionConfig) {
  const engine=config.engine,embedded=['sqlite','duckdb'].includes(engine),tds=['sqlserver','azure-sql'].includes(engine),directory=mkdtempSync(join(tmpdir(),'dbcommander-control-')),events:DatabaseEvent[]=[]
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')})
  const fixture=activityMonitor(config),local={...config,...(embedded?{filePath:join(directory,'data.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  let source='',holder='',waiter='',nativeHolder='',nativeWaiter='',table=''
  async function run(id:string,sql:string) {const queryId=driver.start({sessionId:id,sql,maxRows:20});await driver.wait(id);const done=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>;expect(done?.status,done?.error).toBe('completed');return queryId}
  const inspect=(id=source)=>driver.inspectActivity({sessionId:id,includeSql:false})
  const prepare=async(targetId:string,action:ActivityAction)=>{await inspect();return driver.prepareActivityAction({sessionId:source,targetId,action})}
  const apply=(r:ActivityActionReview)=>Promise.resolve().then(()=>driver.applyActivityAction({sessionId:source,reviewId:r.id,confirmation:r.confirmation,acknowledge:true}))
  try {
    source=(await driver.connect({...fixture.config,...(embedded?local:{}),name:'Control monitor',environment:'production'})).id
    holder=(await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write',name:'Protected target',environment:'production'})).id
    waiter=(await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'})).id
    driver.unlockSession(source,'Control monitor');driver.unlockSession(holder,'Protected target')
    const cached=await run(source,engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42'),sourceState=driver.getSession(source).transaction
    if(embedded) {
      await inspect();for(const action of ['cancel','terminate'] as const)await expect(prepare(holder,action)).rejects.toThrow(/owning tab/)
      expect(driver.getSession(holder).transaction).toBe('idle');return
    }
    nativeHolder=(await inspect(holder)).currentSessionId;nativeWaiter=(await inspect(waiter)).currentSessionId
    const discarded=await prepare(nativeWaiter,'terminate');await inspect();await expect(apply(discarded)).rejects.toThrow(/used/)
    const own=await inspect();await expect(driver.prepareActivityAction({sessionId:source,targetId:own.currentSessionId,action:'terminate'})).rejects.toThrow(/own session/)
    if(engine!=='postgres') {
      const denied=await prepare(nativeWaiter,'terminate');expect((await apply(denied)).status).toBe('rejected');await run(waiter,engine==='oracle'?'SELECT 1 FROM dual':'SELECT 1')
    }
    fixture.enableControl()
    const q=(s:string)=>quoteIdentifier(s,engine),schema=engine==='postgres'?'public':tds?'dbo':engine==='oracle'?config.user.toUpperCase():config.database
    table=`${q(schema)}.${q('control_'+randomUUID().replaceAll('-','').slice(0,10))}`
    await run(holder,`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await run(holder,`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await run(holder,'COMMIT')
    const begin=engine==='oracle'?'SAVEPOINT CONTROL_TEST':tds?'BEGIN TRANSACTION':'BEGIN'
    await run(holder,begin);await run(holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    if(tds)await expect(prepare(nativeWaiter,'cancel')).rejects.toThrow(/query-only/)
    else {
      await run(waiter,begin)
      let blocked=driver.start({sessionId:waiter,sql:`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`,maxRows:1})
      let snapshot=await inspect();const deadline=Date.now()+10000
      while(!snapshot.waits.rows.some(w=>w.waiting===nativeWaiter)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));snapshot=await inspect()}
      expect(snapshot.waits.rows.some(w=>w.waiting===nativeWaiter)).toBe(true)
      const locked=await prepare(nativeWaiter,'cancel');driver.lockSession(source);await expect(apply(locked)).rejects.toThrow(/protected connection is locked/);driver.unlockSession(source,'Control monitor')
      const cancel=await prepare(nativeWaiter,'cancel'),before=events.filter(e=>'sessionId' in e&&e.sessionId===source).length
      expect((await apply(cancel)).status).toBe('requested');await driver.wait(waiter)
      expect(events.find(e=>e.type==='complete'&&e.queryId===blocked)).not.toMatchObject({status:'completed'})
      expect(events.filter(e=>'sessionId' in e&&e.sessionId===source)).toHaveLength(before)
      await expect(apply(cancel)).rejects.toThrow(/used/);await run(waiter,'ROLLBACK')
      // Review a real active statement, let it complete, then refuse the stale cancellation.
      await run(waiter,begin);blocked=driver.start({sessionId:waiter,sql:`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`,maxRows:1})
      await new Promise(r=>setTimeout(r,200));const stale=await prepare(nativeWaiter,'cancel')
      await run(holder,'ROLLBACK');await driver.wait(waiter);await run(waiter,'ROLLBACK')
      await expect(apply(stale)).rejects.toThrow(/changed/)
      await run(waiter,engine==='oracle'?'SELECT 7 FROM dual':'SELECT 7')
      await run(holder,begin);await run(holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    }
    // The issuing profile cannot bypass protection on a recognized local target.
    await new Promise(r=>setTimeout(r,200));const protectedTarget=await prepare(nativeHolder,'terminate');driver.lockSession(holder)
    await expect(apply(protectedTarget)).rejects.toThrow(/protected connection is locked/);driver.unlockSession(holder,'Protected target')
    const terminate=await prepare(nativeHolder,'terminate');expect((await apply(terminate)).status).toBe('requested')
    await expect(apply(terminate)).rejects.toThrow(/used/)
    expect(()=>driver.getSession(holder)).toThrow(/disconnected/)
    // A successful termination must roll back the target's uncommitted update.
    const check=await run(waiter,`SELECT ${q('value')} FROM ${table} WHERE ${q('id')}=1`)
    expect(events.filter(e=>e.type==='rows'&&e.queryId===check).flatMap(e=>e.type==='rows'?e.rows:[])[0][0]).toBe('10')
    expect(driver.getSession(source).transaction).toBe(sourceState)
    await driver.exportCsv(cached,0,join(directory,'source.csv'));expect(readFileSync(join(directory,'source.csv'),'utf8')).toContain('42')
    // Oracle can finish row rollback before releasing the killed session's TM lock.
    if(engine==='oracle')await run(waiter,'ALTER SESSION SET DDL_LOCK_TIMEOUT=10')
    await run(waiter,`DROP TABLE ${table}`);table=''
  } finally {
    // Release the blocker before waiting on any blocked Oracle call.
    if(holder)try{await run(holder,'ROLLBACK')}catch{}
    for(const id of [waiter,holder,source].filter(Boolean)){try{await driver.cancel(id);await driver.wait(id);await run(id,'ROLLBACK')}catch{}}
    if(table&&waiter)try{await run(waiter,`DROP TABLE ${table}`)}catch{}
    await driver.close();fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
}
