import { randomUUID } from 'node:crypto'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig,DatabaseEvent } from '../../src/shared/contracts'
import { activityMonitor } from '../activity-fixture'

export async function verifyActivity(config:ConnectionConfig) {
  const engine=config.engine,embedded=['sqlite','duckdb'].includes(engine),directory=mkdtempSync(join(tmpdir(),'dbcommander-activity-')),events:DatabaseEvent[]=[]
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')})
  const local={...config,...(embedded?{filePath:join(directory,'activity.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const source=await driver.connect(local),actor=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'}),fixture=activityMonitor(config)
  let monitor:string|undefined
  const schema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?source.user.toUpperCase():embedded?'main':source.database
  const name='activity_'+randomUUID().replaceAll('-','').slice(0,10),q=(s:string)=>quoteIdentifier(s,engine),table=`${q(schema)}.${q(name)}`
  async function run(sql:string,id=source.id) {const queryId=driver.start({sessionId:id,sql,maxRows:50});await driver.wait(id);const done=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>;expect(done?.status,done?.error).toBe('completed');return queryId}
  const inspect=(id=source.id,includeSql=false)=>driver.inspectActivity({sessionId:id,includeSql})
  try {
    const cached=await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42'),before=events.length
    const pending=inspect();expect(()=>inspect()).toThrow(/inspection/);const first=await pending
    expect(events).toHaveLength(before);expect(first.sessions.rows.every(r=>r.query===null)).toBe(true)
    await driver.exportCsv(cached,0,join(directory,'before.csv'));expect(readFileSync(join(directory,'before.csv'),'utf8')).toContain('42')
    if(!embedded&&engine!=='postgres')expect([first.sessions,first.locks,first.waits].some(s=>s.status==='unavailable')).toBe(true)
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await run(`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await run('COMMIT')
    const begin=engine==='oracle'?'SAVEPOINT ACTIVITY_TEST':['sqlserver','azure-sql'].includes(engine)?'BEGIN TRANSACTION':'BEGIN'
    await run(begin);await run(`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    expect(driver.getSession(source.id).transaction).toBe('transaction');const during=await inspect();expect(driver.getSession(source.id).transaction).toBe('transaction')
    if(embedded) {
      expect(during.sessions.rows.find(r=>r.id===source.id)?.transaction).toBe('transaction');expect(during.sessions.rows.some(r=>r.id===actor.id)).toBe(true)
      expect(during.locks.status).toBe('unsupported');expect(during.waits.status).toBe('unsupported');expect(during.locks.rows).toEqual([])
    } else {
      const actorId=(await inspect(actor.id)).currentSessionId
      const observer=await driver.connect({...fixture.config,environment:'production'});monitor=observer.id
      expect(driver.sessionSafety(monitor)).toMatchObject({protected:true,unlockedUntil:0})
      if(engine==='postgres')await run("SET lock_timeout='20s'",actor.id)
      if(['mysql','mariadb'].includes(engine))await run('SET innodb_lock_wait_timeout=20',actor.id)
      if(['sqlserver','azure-sql'].includes(engine))await run('SET LOCK_TIMEOUT 20000',actor.id)
      await run(begin,actor.id)
      const marker='waiting_'+name,queryId=driver.start({sessionId:actor.id,sql:`/* ${marker} */ UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`,maxRows:1})
      // Inspection must work on the connection whose query is currently blocked.
      await inspect(actor.id)
      let snapshot=await inspect(monitor,true)
      const deadline=Date.now()+10000
      while(!snapshot.waits.rows.some(w=>w.waiting===actorId&&w.blocking===first.currentSessionId)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,150));snapshot=await inspect(monitor,true)}
      expect(snapshot.waits.status,JSON.stringify(snapshot.waits)).toBe('available')
      expect(snapshot.waits.rows,JSON.stringify(snapshot)).toContainEqual(expect.objectContaining({waiting:actorId,blocking:first.currentSessionId}))
      expect(snapshot.locks.rows.some(l=>l.sessionId===actorId&&/wait/i.test(l.status??''))).toBe(true)
      // SQL Server can expose an auto-parameterized statement with comments
      // removed. The unique table still identifies this exact blocked query.
      expect(snapshot.sessions.rows.find(s=>s.id===actorId)?.query).toContain(['sqlserver','azure-sql'].includes(engine) ? name : marker)
      expect(events.some(e=>e.type==='complete'&&e.queryId===queryId)).toBe(false)
      expect(driver.getSession(source.id).transaction).toBe('transaction')
      await run('ROLLBACK');await driver.wait(actor.id)
      expect(events.find(e=>e.type==='complete'&&e.queryId===queryId)).toMatchObject({status:'completed'})
      await run('ROLLBACK',actor.id)
      let settled=await inspect(monitor);const settleDeadline=Date.now()+5000
      while(settled.waits.rows.some(w=>w.waiting===actorId)&&Date.now()<settleDeadline){await new Promise(r=>setTimeout(r,150));settled=await inspect(monitor)}
      expect(settled.waits.rows.some(w=>w.waiting===actorId)).toBe(false)
      expect(driver.sessionSafety(monitor).unlockedUntil).toBe(0)
    }
    // Server sessions were rolled back above to release and verify the lock
    // wait. SQL Server correctly rejects a second rollback without a BEGIN.
    if(embedded)await run('ROLLBACK')
    expect(driver.getSession(source.id).transaction).toBe('idle')
    expect(driver.getSession(actor.id).transaction).toBe('idle')
    await run(`DROP TABLE ${table}`)
    const lastInspection=inspect(actor.id),closing=driver.disconnect(actor.id)
    expect(()=>driver.start({sessionId:actor.id,sql:'SELECT 1',maxRows:1})).toThrow(/operation/)
    await lastInspection;await closing;await expect(Promise.resolve().then(()=>inspect(actor.id))).rejects.toThrow(/disconnected/)
  } finally {
    try{if(driver.getSession(source.id).transaction!=='idle')await run('ROLLBACK')}catch{}
    for(const id of [actor.id,source.id]) {try{await driver.cancel(id);await driver.wait(id);if(driver.getSession(id).transaction!=='idle')await run('ROLLBACK',id)}catch{}}
    try{await run(`DROP TABLE ${table}`)}catch{}
    await driver.close();fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
}
