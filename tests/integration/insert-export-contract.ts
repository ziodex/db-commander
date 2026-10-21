import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { lexSql } from '../../src/shared/sql/lexer'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'
import type { TransferRequest } from '../../src/shared/transfer'

export async function verifyInsertExport(config: ConnectionConfig) {
  const directory=await mkdtemp(join(tmpdir(),'dbcommander-insert-export-')),events:DatabaseEvent[]=[]
  let cancel=false
  const driver=new DriverRegistry(event=>{events.push(event)}, {workerPath:resolve('out/main/sqlite-worker.cjs')}, {}, ()=>{}, job=>{
    if(cancel && job.status==='running' && job.rows>0) driver.cancelTransfer(job.id)
  })
  const engine=config.engine, oracle=engine==='oracle', mysql=['mysql','mariadb'].includes(engine), tds=['sqlserver','azure-sql'].includes(engine)
  const local={...config,...(['sqlite','duckdb'].includes(engine)?{filePath:join(directory,'data.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  let session=await driver.connect(local)
  const q=(s:string)=>quoteIdentifier(s,engine), name='inserts_'+randomUUID().slice(0,8), target=name+'_copy'
  const special="O'Brien \\ Ω 😀\n'); DELETE FROM target; --", exact='9007199254740993.12345678', max='9223372036854775807'
  async function run(sql:string,parameters?:QueryParameter[]) {
    const queryId=driver.start({sessionId:session.id,sql,parameters,maxRows:2000});await driver.wait(session.id)
    const complete=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status,complete.error).toBe('completed')
    return {queryId,rows:events.flatMap(e=>e.type==='rows'&&e.queryId===queryId?e.rows:[])}
  }
  const request=(file:string,sql:string):Extract<TransferRequest,{action:'export'}>=>({action:'export',sessionId:session.id,file,sql,format:'sql',insertTarget:{name:target},confirmed:true})
  async function transfer(value:TransferRequest) { const job=driver.startTransfer(value);await driver.waitTransfer(job.id);return driver.listTransferJobs().find(j=>j.id===job.id)! }
  try {
    const definition=`(${q('id')} ${oracle?'NUMBER(19)':'BIGINT'},${q('label')} ${tds?'NVARCHAR':oracle?'VARCHAR2':'VARCHAR'}(200),${q('amount')} ${engine==='sqlite'?'TEXT':oracle?'NUMBER(24,8)':'DECIMAL(24,8)'},${q('at')} ${engine==='sqlite'?'TEXT':engine==='duckdb'?'TIMESTAMP':tds?'DATETIME2(6)':mysql?'DATETIME(6)':'TIMESTAMP(6)'},${q('bytes')} ${oracle?'RAW(40)':tds?'VARBINARY(40)':engine==='postgres'?'BYTEA':'BLOB'},${q('note')} ${oracle?'VARCHAR2':'VARCHAR'}(30))`
    for(const table of [name,target])await run(`CREATE TABLE ${q(table)} ${definition}`)
    for(let i=0;i<3;i++) await run(`INSERT INTO ${q(name)} (${['id','label','amount','at','bytes','note'].map(q).join(',')}) VALUES (:id,:label,:amount,:at,:bytes,:note)`,[
      {name:'id',type:'integer',value:i===0?max:String(i)}, {name:'label',type:'text',value:i===0?special:i===1?'':'ordinary'},
      {name:'amount',type:'decimal',value:exact},{name:'at',type:'timestamp',value:'2026-10-15 12:34:56.123456'},
      {name:'bytes',type:'hex',value:'00ff8041'},{name:'note',type:'null',value:''}
    ])
    if(oracle)await run('COMMIT')
    if(mysql)await run("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
    if(engine==='postgres')await run('SET standard_conforming_strings = off')
    const original=await run(`SELECT * FROM ${q(name)} ORDER BY ${q('id')}`)
    const numbers=Array.from({length:401},(_,i)=>`SELECT ${i} AS n${oracle?' FROM dual':''}`).join(' UNION ALL ')
    const sql=`SELECT s.* FROM ${q(name)} s CROSS JOIN (${numbers}) copies ORDER BY s.${q('id')},copies.n`,file=join(directory,'full.sql')
    const before=events.length,job=await transfer(request(file,sql))
    expect(job,job.phase).toMatchObject({status:'completed',rows:1203,session:{transaction:'idle'}})
    expect(events.slice(before).filter(e=>'queryId' in e)).toEqual([])
    const script=await readFile(file,'utf8');expect(script).toContain(`INSERT INTO ${q(target)}`)
    const cached=join(directory,'cached.csv');await driver.exportCsv(original.queryId,0,cached);expect(await readFile(cached,'utf8')).toContain(exact)
    expect((await run(`SELECT COUNT(*) FROM ${q(target)}`)).rows).toEqual([['0']])
    // Lexical boundaries preserve semicolons/newlines inside hostile text.
    let start=0;const inserts:string[]=[]
    for(const token of lexSql(script,engine,mysql,mysql))if(token.kind==='symbol'&&token.text===';'){inserts.push(script.slice(start,token.end));start=token.end}
    expect(inserts).toHaveLength(1203)
    await run(oracle?'SAVEPOINT replay':tds?'BEGIN TRANSACTION':'BEGIN')
    for(let i=0;i<inserts.length;i+=100)await run(inserts.slice(i,i+100).join('\n'))
    expect((await run(`SELECT COUNT(*) FROM ${q(target)}`)).rows).toEqual([['1203']])
    expect((await run(`SELECT DISTINCT * FROM ${q(target)} ORDER BY ${q('id')}`)).rows).toEqual(original.rows)
    await run('ROLLBACK');expect((await run(`SELECT COUNT(*) FROM ${q(target)}`)).rows).toEqual([['0']])
    expect((await transfer(request(file,sql))).phase).toMatch(/already exists/);expect(await readFile(file,'utf8')).toBe(script)
    const duplicate=join(directory,'duplicate.sql')
    expect((await transfer(request(duplicate,`SELECT ${q('id')} AS same,${q('label')} AS same FROM ${q(name)}`))).status).toBe('failed');await expect(stat(duplicate)).rejects.toThrow()
    if(engine==='sqlite') {
      // SQLite cancellation closes its worker, including a format error that
      // aborts streaming. Reconnect explicitly to the same file before more SQL.
      expect(()=>driver.getSession(session.id)).toThrow(/disconnected|connected|session/i)
      session=await driver.connect({...local,sqliteMode:'read-write'})
    }
    const parameterFile=join(directory,'parameter.sql')
    const bound=await transfer({...request(parameterFile,`SELECT * FROM ${q(name)} WHERE ${q('id')}=:id`),parameters:[{name:'id',type:'integer',value:max}]})
    expect(bound.status,bound.phase).toBe('completed');expect(await readFile(parameterFile,'utf8')).toContain(max)
    cancel=true;const cancelled=join(directory,'cancel.sql'), stopped=await transfer(request(cancelled,sql));cancel=false
    expect(['cancelled','unknown'],stopped.phase).toContain(stopped.status);await expect(stat(cancelled)).rejects.toThrow()
    expect(JSON.stringify(driver.listTransferJobs())).not.toContain(special)
  } finally {
    try {await run('ROLLBACK')}catch{}
    for(const table of [target,name])try{await run(`DROP TABLE ${q(table)}`)}catch{}
    await driver.close();await rm(directory,{recursive:true,force:true})
  }
}
