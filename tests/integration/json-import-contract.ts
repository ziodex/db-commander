import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent, GridTable } from '../../src/shared/contracts'
import type { ImportRequest, TransferRequest } from '../../src/shared/transfer'

export async function verifyJsonImport(config: ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-json-import-')), events:DatabaseEvent[]=[]
  const engine=config.engine, oracle=engine==='oracle', tds=['sqlserver','azure-sql'].includes(engine)
  const file=join(directory,'input.json'), output=join(directory,'export.json')
  let effect: 'cancel' | 'replace' | undefined
  const driver=new DriverRegistry(e=>{events.push(e)}, {workerPath:resolve('out/main/sqlite-worker.cjs')}, {}, ()=>{}, job=>{
    if(job.action!=='import'||job.status!=='running'||job.rows===0||!effect)return
    const action=effect;effect=undefined
    if(action==='cancel')driver.cancelTransfer(job.id)
    else {const bytes=readFileSync(file);renameSync(file,file+'.old');writeFileSync(file,bytes)}
  })
  if(['sqlite','duckdb'].includes(engine))config={...config,filePath:join(directory,'values.db'),sqliteMode:'create',duckdbMode:'create'}
  const session=await driver.connect(config), other=await driver.connect({...config,sqliteMode:'read-write',duckdbMode:'read-write'})
  const q=(s:string)=>quoteIdentifier(s,engine), name='json_'+randomUUID().slice(0,8)
  const special="O'Brien, \"quoted\"\nΩ 😀 \\N", exact='9007199254740993.12345678', max='9223372036854775807'
  async function run(sql:string,id=session.id,maxRows=2000) {
    const queryId=driver.start({sessionId:id,sql,maxRows});await driver.wait(id)
    const complete=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status,complete.error).toBe('completed')
    return {queryId,rows:events.flatMap(e=>e.type==='rows'&&e.queryId===queryId?e.rows:[])}
  }
  const content=(rows:unknown[])=>JSON.stringify({columns:['source_id','source_label','amount','note','ignore'].map(name=>({name,typeId:0,typeName:'ignored source type'})),rows})
  const rows=Array.from({length:1205},(_,i)=>[i===0?max:String(i),i===0?special:'payload '+i,exact,i===0?null:i===1?'':i===2?'\\N':'value','skip me'])
  let table:GridTable, copy:GridTable
  async function load(path=file,target=table):Promise<ImportRequest> {
    const source={sessionId:session.id,table:target,file:path,format:'json' as const}, preview=await driver.inspectImport(source)
    return {...source,action:'import',confirmed:true,signature:preview.signature,mapping:preview.headers.map(h=>h==='source_id'?'id':h==='source_label'?'label':h==='ignore'?null:h)}
  }
  async function transfer(request:TransferRequest) {
    const job=driver.startTransfer(request)
    expect(()=>driver.start({sessionId:session.id,sql:'SELECT 1',maxRows:1})).toThrow(/operation/)
    expect((await run(oracle?'SELECT 1 FROM dual':'SELECT 1',other.id)).rows).toEqual([['1']])
    await driver.waitTransfer(job.id);return driver.listTransferJobs().find(j=>j.id===job.id)!
  }
  const count=async(target=table)=>(await run(`SELECT COUNT(*) FROM ${q(target.name)}`)).rows
  try {
    for(const suffix of ['', '_copy'])await run(`CREATE TABLE ${q(name+suffix)} (${q('id')} ${oracle?'NUMBER(19)':'BIGINT'} NOT NULL PRIMARY KEY,${q('label')} ${tds?'NVARCHAR':oracle?'VARCHAR2':'VARCHAR'}(200),${q('amount')} ${engine==='sqlite'?'TEXT':oracle?'NUMBER(24,8)':'DECIMAL(24,8)'},${q('note')} ${tds?'NVARCHAR':oracle?'VARCHAR2':'VARCHAR'}(40),${q('omitted')} INTEGER DEFAULT 7)`)
    const objects=(await driver.schema(session.id)).objects
    const ref=(n:string)=>{const object=objects.find(o=>o.name===n)!;return {name:n,schema:object.schema,...(object.catalog?{catalog:object.catalog}:{})}}
    table=ref(name);copy=ref(name+'_copy')
    writeFileSync(file,'\uFEFF'+content(rows))
    const preview=await driver.inspectImport({sessionId:session.id,table,file,format:'json'})
    expect(preview.rows).toEqual(rows.slice(0,10));expect(preview.columns.find(c=>c.name==='amount')?.type).not.toContain('ignored source type')
    let request=await load()
    for(const mapping of [['id','id','amount','note',null],[null,'label','amount','note',null],['id','unknown','amount','note',null]]) {
      const failed=await transfer({...request,mapping});expect(failed.status,failed.phase).toBe('failed');expect(await count()).toEqual([['0']])
    }
    const retained=await run(oracle?'SELECT 42 FROM dual':'SELECT 42')
    let job=await transfer(request)
    expect(job,job.phase).toMatchObject({status:'completed',rows:1205,session:{transaction:'transaction'}})
    const cached=join(directory,'cached.csv');await driver.exportCsv(retained.queryId,0,cached);expect(readFileSync(cached,'utf8')).toContain('42')
    expect(()=>driver.startTransfer(request)).toThrow(/Commit or roll back/)
    expect((await run(`SELECT ${q('id')},${q('label')},${q('amount')},${q('note')},${q('omitted')} FROM ${q(name)} WHERE ${q('id')}=${max}`)).rows).toEqual([[max,special,exact,null,'7']])
    await run('ROLLBACK');expect(await count()).toEqual([['0']])
    job=await transfer(request);expect(job.status,job.phase).toBe('completed');await run('COMMIT')
    expect((await run(`SELECT COUNT(*) FROM ${q(name)}`,other.id)).rows).toEqual([['1205']])
    expect((await run(`SELECT ${q('note')} FROM ${q(name)} WHERE ${q('id')}=1`)).rows).toEqual([[oracle?null:'']])
    expect((await run(`SELECT ${q('note')} FROM ${q(name)} WHERE ${q('id')}=2`)).rows).toEqual([['\\N']])
    const query=`SELECT * FROM ${q(name)} ORDER BY ${q('id')}`
    expect((await run(query,session.id,2)).rows).toHaveLength(2)
    job=await transfer({action:'export',sessionId:session.id,sql:query,file:output,format:'json',confirmed:true});expect(job.status,job.phase).toBe('completed')
    const exported=JSON.parse(readFileSync(output,'utf8'))
    expect(exported.rows).toHaveLength(1205)
    job=await transfer(await load(output,copy));expect(job.status,job.phase).toBe('completed')
    expect((await run(query.replace(q(name),q(copy.name)))).rows).toEqual(exported.rows)
    await run('ROLLBACK');expect(await count(copy)).toEqual([['0']])
    // Errors beyond the ten-row preview and after the final row must undo all inserts.
    const valid=Array.from({length:11},(_,i)=>[String(8000+i),'new',exact,'note','skip'])
    for(const late of [content([...valid,['1','duplicate',exact,null,'skip']]),content([...valid,[9007199254740992,'number',exact,null,'skip']]),content([...valid,['9001',{nested:true},exact,null,'skip']]),content([...valid,['9001','short']]),content(valid)+' trailing']) {
      writeFileSync(file,late);job=await transfer(await load());expect(job.status,job.phase).toBe('failed');expect(job.phase).toMatch(/entire import was rolled back/)
      expect(job.session?.transaction).toBe('idle');expect(await count()).toEqual([['1205']])
    }
    writeFileSync(file,content(valid));request=await load();writeFileSync(file,content([...valid,['9001','changed',exact,null,'skip']]))
    job=await transfer(request);expect(job.status).toBe('failed');expect(job.phase).toMatch(/changed/);expect(await count()).toEqual([['1205']])
    // SQLite reports worker progress every 100 rows; include enough rows to trigger replacement before completion.
    writeFileSync(file,content(Array.from({length:1205},(_,i)=>[String(10000+i),'replace',exact,null,'skip'])));request=await load();effect='replace'
    job=await transfer(request);expect(job.status,job.phase).toBe('failed');expect(job.phase).toMatch(/changed during import/);expect(await count()).toEqual([['1205']])
    writeFileSync(file,content(Array.from({length:1205},(_,i)=>[String(10000+i),'cancel',exact,null,'skip'])));request=await load();effect='cancel'
    job=await transfer(request);expect(job,job.phase).toMatchObject({status:'cancelled',session:{transaction:'idle'}});expect(await count()).toEqual([['1205']])
    writeFileSync(file,content([]));job=await transfer(await load());expect(job.status).toBe('failed');expect(job.phase).toContain('no data records')
    writeFileSync(file,content(valid));request=await load(file,copy)
    await run(`ALTER TABLE ${q(copy.name)} ADD ${q('added')} INTEGER DEFAULT 0`)
    job=await transfer(request);expect(job.status).toBe('failed');expect(job.phase).toMatch(/definition changed/);expect(await count(copy)).toEqual([['0']])
    await run(`DROP TABLE ${q(copy.name)}`);await run(`DROP TABLE ${q(name)}`)
  } finally {
    try{await run('ROLLBACK');await run(`DROP TABLE ${q(name+'_copy')}`);await run(`DROP TABLE ${q(name)}`)}catch{}
    await driver.close();rmSync(directory,{recursive:true,force:true})
  }
}
