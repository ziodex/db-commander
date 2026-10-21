import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { tableKey } from '../../src/shared/diagram'

export async function verifyDiagram(config:ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-er-')),events:DatabaseEvent[]=[],engine=config.engine,embedded=['sqlite','duckdb'].includes(engine)
  const local={...config,...(embedded?{filePath:join(directory,'er.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')}),session=await driver.connect(local)
  const q=(s:string)=>quoteIdentifier(s,engine),prefix='er_'+randomUUID().replaceAll('-','').slice(0,8),parent=prefix+" p'<&",child=prefix+'_child',loose=prefix+'_loose',view=prefix+'_view',drops:string[]=[]
  async function run(sql:string,id=session.id){const queryId=driver.start({sessionId:id,sql,maxRows:100});await driver.wait(id);const result=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>;expect(result?.status,result?.error).toBe('completed');return queryId}
  try {
    await run(`CREATE TABLE ${q(parent)} (${q('tenant')} INTEGER NOT NULL,${q('code')} INTEGER NOT NULL,${q('self tenant')} INTEGER,${q('self code')} INTEGER,PRIMARY KEY(${q('tenant')},${q('code')}),CONSTRAINT ${q(prefix+'_self')} FOREIGN KEY(${q('self tenant')},${q('self code')}) REFERENCES ${q(parent)}(${q('tenant')},${q('code')}))`);drops.unshift(`DROP TABLE ${q(parent)}`)
    await run(`CREATE TABLE ${q(child)} (${q('id')} INTEGER PRIMARY KEY,${q('tenant')} INTEGER,${q('code')} INTEGER,CONSTRAINT ${q(prefix+'_fk')} FOREIGN KEY(${q('tenant')},${q('code')}) REFERENCES ${q(engine==='sqlite'?parent.toUpperCase():parent)}(${q('tenant')},${q('code')}),CONSTRAINT ${q(prefix+'_reverse')} FOREIGN KEY(${q('code')},${q('tenant')}) REFERENCES ${q(engine==='sqlite'?parent.toUpperCase():parent)}(${q('tenant')},${q('code')}))`);drops.unshift(`DROP TABLE ${q(child)}`)
    await run(`CREATE TABLE ${q(loose)} (${q('plain column')} VARCHAR(30))`);drops.unshift(`DROP TABLE ${q(loose)}`)
    await run(`CREATE VIEW ${q(view)} AS SELECT * FROM ${q(loose)}`);drops.unshift(`DROP VIEW ${q(view)}`)
    const cached=await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42'),before=events.length
    const all=await driver.diagram({sessionId:session.id}),tables=all.available.filter(o=>[parent,child,loose].includes(o.name))
    expect(tables).toHaveLength(3);expect(all.available.some(o=>o.name===view)).toBe(false)
    const loading=driver.diagram({sessionId:session.id,tables})
    expect(()=>driver.start({sessionId:session.id,sql:'SELECT 1',maxRows:1})).toThrow(/operation/)
    const result=await loading
    expect(events).toHaveLength(before);expect(result.source).toBe(embedded?'session':'catalog-connection');expect(result.nodes.every(n=>!n.notices.length),JSON.stringify(result.nodes)).toBe(true)
    expect(result.nodes).toHaveLength(3);expect(result.edges).toHaveLength(3)
    const p=result.nodes.find(n=>n.object.name===parent)!,c=result.nodes.find(n=>n.object.name===child)!
    expect(p.columns.filter(c=>c.primaryKey).map(c=>c.name)).toEqual(['tenant','code'])
    expect(p.columns.find(c=>c.name==='tenant')?.nullable).toBe(false);expect(p.columns.find(c=>c.name==='self code')?.nullable).toBe(true)
    expect(result.nodes.find(n=>n.object.name===loose)?.columns.every(c=>!c.primaryKey)).toBe(true)
    expect(result.edges.filter(e=>e.source===c.id).map(e=>e.columns)).toEqual(expect.arrayContaining([['tenant','code'],['code','tenant']]))
    expect(result.edges.every(e=>e.target===p.id&&e.targetColumns.join(',')==='tenant,code')).toBe(true)
    expect(result.edges.some(e=>e.source===e.target)).toBe(true)
    const single=await driver.diagram({sessionId:session.id,tables:[c.object]})
    expect(single.edges.every(e=>!e.target&&e.targetVisible)).toBe(true);expect(single.notices.join(' ')).toContain('outside')
    await expect(driver.diagram({sessionId:session.id,tables:[{...c.object,name:"missing'; DROP TABLE x;--"}]})).rejects.toThrow(/no longer visible/)
    await expect(driver.diagram({sessionId:session.id,tables:[c.object,c.object]})).rejects.toThrow(/only once/)
    await driver.exportCsv(cached,0,join(directory,'result.csv'));expect(readFileSync(join(directory,'result.csv'),'utf8')).toContain('42')
    await run(`INSERT INTO ${q(child)} (${q('id')}) VALUES(1)`);if(engine==='oracle')await run('COMMIT')
    const table={schema:c.object.schema,name:c.object.name,...(c.object.catalog?{catalog:c.object.catalog}:{})}
    const grid=await driver.editGrid({action:'open',sessionId:session.id,table});expect(grid.error).toBeUndefined()
    await driver.diagram({sessionId:session.id,tables})
    const applied=await driver.editGrid({action:'apply',sessionId:session.id,snapshotId:grid.grid!.id,changes:[{kind:'delete',row:0}]})
    expect(applied.error).toBeUndefined();expect(applied.applied).toBe(1);await run('ROLLBACK')
    await run(engine==='oracle'?'SAVEPOINT ER_CHECK':['sqlserver','azure-sql'].includes(engine)?'BEGIN TRANSACTION':'BEGIN')
    const state=driver.getSession(session.id).transaction
    await driver.diagram({sessionId:session.id,tables});expect(driver.getSession(session.id).transaction).toBe(state)
    await run('ROLLBACK')
    const protectedSession=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write',environment:'production'})
    expect((await driver.diagram({sessionId:protectedSession.id,tables})).edges).toHaveLength(3)
    expect(driver.sessionSafety(protectedSession.id)).toMatchObject({protected:true,unlockedUntil:0});await driver.disconnect(protectedSession.id)
    if(engine==='postgres'){
      const restricted=await driver.connect({...config,user:'browser_user',password:'local-test-only'})
      expect((await driver.diagram({sessionId:restricted.id})).available.some(o=>o.name===parent)).toBe(false)
      await expect(driver.diagram({sessionId:restricted.id,tables})).rejects.toThrow(/no longer visible/)
      await run(`GRANT SELECT ON ${q(child)} TO browser_user`)
      const partial=await driver.diagram({sessionId:restricted.id,tables:[c.object]})
      expect(partial.edges.every(e=>!e.targetVisible&&!e.target)).toBe(true)
      await driver.disconnect(restricted.id)
    }
    if(embedded){
      await run(`CREATE TEMP TABLE ${q(prefix+'_temp')} (value_arg INT)`)
      const a=await driver.diagram({sessionId:session.id}),other=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'})
      const b=await driver.diagram({sessionId:other.id})
      expect(a.available.some(o=>o.name===prefix+'_temp')).toBe(true);expect(b.available.some(o=>o.name===prefix+'_temp')).toBe(false);await driver.disconnect(other.id)
      if(engine==='sqlite'){
        // Unnamed SQLite REFERENCES uses the parent's ordered primary key.
        await run(`CREATE TABLE ${q(prefix+'_implicit')} (a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES ${q(parent)})`);drops.unshift(`DROP TABLE ${q(prefix+'_implicit')}`)
        const implicit=await driver.diagram({sessionId:session.id})
        expect(implicit.edges.find(e=>e.source===tableKey({schema:'main',name:prefix+'_implicit'}))?.targetColumns).toEqual(['tenant','code'])
        await run(`ATTACH ':memory:' AS other_er`);await run(`CREATE TABLE other_er.${q(loose)} (alternate INT PRIMARY KEY)`)
      }else {await run('CREATE SCHEMA other_er');await run(`CREATE TABLE other_er.${q(loose)} (alternate INT PRIMARY KEY)`)}
      const qualified=await driver.diagram({sessionId:session.id}),duplicates=qualified.nodes.filter(n=>n.object.name===loose)
      expect(duplicates).toHaveLength(2);expect(new Set(duplicates.map(n=>n.id)).size).toBe(2)
      expect(duplicates.find(n=>n.object.schema==='other_er')?.columns[0].name).toBe('alternate')
      if(engine==='duckdb')await run(`DROP SCHEMA other_er CASCADE`)
    }
    await run(`CREATE TABLE ${q(prefix+'_wide')} (${Array.from({length:101},(_,i)=>q('column_'+i)+' INTEGER').join(',')})`);drops.unshift(`DROP TABLE ${q(prefix+'_wide')}`)
    const wideObject=(await driver.schema(session.id)).catalog!.objects.find(o=>o.name===prefix+'_wide'&&o.kind==='table')!
    const wide=await driver.diagram({sessionId:session.id,tables:[wideObject]})
    expect(wide.nodes[0].columns).toHaveLength(100);expect(wide.nodes[0].notices.join(' ')).toContain('Column display limit')
    await run(`ALTER TABLE ${q(child)} ADD ${q('added later')} INTEGER`)
    expect((await driver.diagram({sessionId:session.id,tables:[c.object]})).nodes[0].columns.some(c=>c.name==='added later')).toBe(true)
    await run(`DROP TABLE ${q(child)}`);drops.splice(drops.indexOf(`DROP TABLE ${q(child)}`),1)
    await expect(driver.diagram({sessionId:session.id,tables:[c.object]})).rejects.toThrow(/no longer visible/)
    expect((await driver.diagram({sessionId:session.id})).available.some(o=>o.name===child)).toBe(false)
  }finally{for(const sql of drops){try{await run(sql)}catch{}}await driver.close();rmSync(directory,{recursive:true,force:true})}
}
