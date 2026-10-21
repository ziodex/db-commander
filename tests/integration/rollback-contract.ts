import { randomUUID } from 'node:crypto'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig,DatabaseEvent } from '../../src/shared/contracts'
import { activityMonitor } from '../activity-fixture'

export async function verifyRollbackInspection(config:ConnectionConfig) {
  const engine=config.engine,embedded=['sqlite','duckdb'].includes(engine),tds=['sqlserver','azure-sql'].includes(engine),directory=mkdtempSync(join(tmpdir(),'dbcommander-rollback-')),events:DatabaseEvent[]=[]
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')}),fixture=activityMonitor(config,true)
  const local={...config,...(embedded?{filePath:join(directory,'data.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  let source='',holder='',checker='',table='',terminated=false
  async function run(sessionId:string,sql:string){const id=driver.start({sessionId,sql,maxRows:10});await driver.wait(sessionId);const done=events.find(e=>e.type==='complete'&&e.queryId===id) as Extract<DatabaseEvent,{type:'complete'}>;expect(done?.status,done?.error).toBe('completed');return id}
  const fresh=()=>driver.inspectActivity({sessionId:source,includeSql:false}),begin=engine==='oracle'?'SAVEPOINT ROLLBACK_TEST':tds?'BEGIN TRANSACTION':'BEGIN'
  try {
    source=(await driver.connect({...fixture.config,...(embedded?local:{}),name:'Rollback monitor',environment:'production'})).id
    holder=(await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'})).id
    driver.unlockSession(source,'Rollback monitor');await run(source,begin)
    const cached=await run(source,engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42');driver.lockSession(source)
    const native=(await driver.inspectActivity({sessionId:holder,includeSql:false})).currentSessionId
    await expect(Promise.resolve().then(()=>driver.inspectRollback({sessionId:source,targetId:native}))).rejects.toThrow(/Refresh/)
    await fresh()
    if(embedded){const snap=await driver.inspectRollback({sessionId:source,targetId:native});expect(snap.status).toBe('unsupported');expect((await driver.inspectRollback({sessionId:source,inspectionId:snap.id})).status).toBe('unsupported');return}
    checker=(await driver.connect(config)).id
    const q=(s:string)=>quoteIdentifier(s,engine),schema=engine==='postgres'?'public':tds?'dbo':engine==='oracle'?config.user.toUpperCase():config.database
    table=`${q(schema)}.${q('rollback_'+randomUUID().replaceAll('-','').slice(0,10))}`
    await run(holder,`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await run(holder,`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await run(holder,'COMMIT')
    await run(holder,begin);await run(holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    await new Promise(r=>setTimeout(r,200));await fresh()
    if(engine==='oracle'){const denied=await driver.inspectRollback({sessionId:source,targetId:native});expect(denied.status).toBe('unavailable')}
    fixture.enableRollback()
    const sourceState=driver.getSession(source),before=events.filter(e=>'sessionId' in e&&e.sessionId===source).length
    const snapshot=await driver.inspectRollback({sessionId:source,targetId:native})
    expect(snapshot.status,JSON.stringify(snapshot)).toBe('observed');expect(snapshot.percent).toBeNull();expect(snapshot.identity).toHaveLength(4);expect(snapshot.metrics.length).toBeGreaterThan(0)
    expect(snapshot.metrics.some(m=>m.label==='Rows modified (reported)'||m.label==='Undo records used'||m.label==='Session state'||m.label==='Transaction state code')).toBe(true)
    const pending=driver.inspectRollback({sessionId:source,inspectionId:snapshot.id})
    expect(()=>driver.inspectRollback({sessionId:source,inspectionId:snapshot.id})).toThrow(/operation/)
    expect((await pending).identity).toEqual(snapshot.identity)
    await expect(Promise.resolve().then(()=>driver.inspectRollback({sessionId:holder,inspectionId:snapshot.id}))).rejects.toThrow(/another/)
    await run(holder,'ROLLBACK')
    let finished=await driver.inspectRollback({sessionId:source,inspectionId:snapshot.id}),deadline=Date.now()+5000
    while(finished.status!=='not-visible'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,150));finished=await driver.inspectRollback({sessionId:source,inspectionId:snapshot.id})}
    expect(finished.status,JSON.stringify(finished)).toBe('not-visible');expect(finished.notices.join(' ')).toContain('never proves rollback completed')
    // The same session opens a different transaction: refresh stays on the old one.
    await run(holder,begin);await run(holder,`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`);await new Promise(r=>setTimeout(r,200))
    expect((await driver.inspectRollback({sessionId:source,inspectionId:snapshot.id})).status).toBe('not-visible')
    await fresh();const next=await driver.inspectRollback({sessionId:source,targetId:native});expect(next.status).toBe('observed');expect(next.identity).not.toEqual(snapshot.identity)
    await expect(Promise.resolve().then(()=>driver.inspectRollback({sessionId:source,inspectionId:snapshot.id}))).rejects.toThrow(/replaced/)
    expect(events.filter(e=>'sessionId' in e&&e.sessionId===source)).toHaveLength(before);expect(driver.getSession(source)).toEqual(sourceState)
    await driver.exportCsv(cached,0,join(directory,'source.csv'));expect(readFileSync(join(directory,'source.csv'),'utf8')).toContain('42')
    // The reviewed action captures before dispatch and hands inspection to the UI.
    driver.unlockSession(source,'Rollback monitor');const review=await driver.prepareActivityAction({sessionId:source,targetId:native,action:'terminate'})
    const result=await driver.applyActivityAction({sessionId:source,reviewId:review.id,confirmation:review.confirmation,acknowledge:true});expect(result.status).toBe('requested');terminated=true
    expect(result.rollback?.identity).toEqual(next.identity);expect(result.rollback?.notices.join(' ')).toContain('before the reviewed command')
    const after=await driver.inspectRollback({sessionId:source,inspectionId:result.rollback!.id});expect(['observed','rolling-back','not-visible']).toContain(after.status)
    const check=await run(checker,`SELECT ${q('value')} FROM ${table} WHERE ${q('id')}=1`)
    expect(events.filter(e=>e.type==='rows'&&e.queryId===check).flatMap(e=>e.type==='rows'?e.rows:[])[0][0]).toBe('10')
    // Oracle may retain a killed idle client's resources until its transport closes.
    await driver.disconnect(holder);holder=''
    await run(source,'ROLLBACK');await run(checker,`DROP TABLE ${table}`);table=''
  } finally {
    if(holder&&!terminated)await run(holder,'ROLLBACK').catch(()=>{})
    if(source){driver.unlockSession(source,'Rollback monitor');await run(source,'ROLLBACK').catch(()=>{})}
    if(table&&checker)await run(checker,`DROP TABLE ${table}`).catch(()=>{})
    await driver.close();fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
}
