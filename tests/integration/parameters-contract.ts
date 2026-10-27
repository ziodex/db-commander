import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig,DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'

export async function verifyParameters(config:ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-parameters-')),events:DatabaseEvent[]=[],engine=config.engine
  const oracle=engine==='oracle',tds=['sqlserver','azure-sql'].includes(engine),embedded=['sqlite','duckdb'].includes(engine)
  const local={...config,...(embedded?{filePath:join(directory,'bindings.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const driver=new DriverRegistry(e=>{events.push(e)},{workerPath:resolve('out/main/sqlite-worker.cjs')})
  let session=await driver.connect(local)
  const q=(s:string)=>quoteIdentifier(s,engine),table=q('bind_'+randomUUID().slice(0,8)),from=oracle?' FROM dual':''
  const p=(name:string,type:QueryParameter['type'],value=''):QueryParameter=>({name,type,value})
  async function run(sql:string,parameters?:QueryParameter[],id=session.id,expected='completed') {
    const queryId=driver.start({sessionId:id,sql,parameters,maxRows:100});await driver.wait(id)
    const execution=events.filter(e=>'queryId' in e&&e.queryId===queryId),complete=execution.find(e=>e.type==='complete') as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete?.status,complete?.error).toBe(expected)
    return {id:queryId,complete,rows:execution.flatMap(e=>e.type==='rows'?e.rows:[]),results:execution.filter(e=>e.type==='result')}
  }
  const text="private-bound-value O'Brien \\ Ω ; DROP TABLE customers; --",hex='00ff8041'
  const integer=oracle?'NUMBER(19)':'BIGINT',binary=engine==='postgres'?'BYTEA':oracle?'RAW(20)':tds?'VARBINARY(20)':'BLOB',string=tds?'NVARCHAR(500)':'VARCHAR(500)'
  try {
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('label')} ${string},${q('n')} ${integer},${q('flag')} INTEGER,${q('missing')} ${integer},${q('bytes')} ${binary})`)
    await run(`INSERT INTO ${table} VALUES(:id,:label,:n,1,:missing,:bytes)`,[p('id','integer','1'),p('label','text',text),p('n','integer','9223372036854775807'),p('missing','null'),p('bytes','hex',hex)])
    if(oracle)await run('COMMIT')
    const sql=`SELECT ${q('label')},${q('n')},${q('missing')},${q('bytes')} FROM ${table} WHERE ${q('id')}=:id OR ${q('id')}=:id; -- :ignored`
    const result=await run(sql,[p('id','integer','1')]);expect(result.rows[0].slice(0,3)).toEqual([text,'9223372036854775807',null]);expect(result.rows[0][3]?.toLowerCase().replace(/^(0x|\\x)/,'')).toBe(hex)
    expect(result.results.every(e=>e.type==='result'&&e.result.statement===sql)).toBe(true)
    const csv=join(directory,'cached.csv');await driver.exportCsv(result.id,0,csv);expect(readFileSync(csv,'utf8')).toContain('9223372036854775807')
    expect((await run(`SELECT :yes,:no,:minimum,':not_a_bind'${from}`,[p('yes','boolean','true'),p('no','boolean','false'),p('minimum','integer','-9223372036854775808')])).rows[0]).toEqual([engine==='postgres'?'t':engine==='duckdb'?'true':'1',engine==='postgres'?'f':engine==='duckdb'?'false':'0','-9223372036854775808',':not_a_bind'])
    if(engine!=='sqlite')expect((await run(`SELECT CAST(:decimal AS DECIMAL(30,8))${from}`,[p('decimal','text','9007199254740993.12345678')])).rows[0][0]).toBe('9007199254740993.12345678')
    for(const bad of [
      {sql:`DELETE FROM ${table} WHERE ${q('id')}=:id;SELECT 1`,parameters:[p('id','integer','1')]},
      {sql:`DELETE FROM ${table} WHERE ${q('id')}=:id`,parameters:undefined},
      {sql:`DELETE FROM ${table} WHERE ${q('id')}=:id`,parameters:[p('wrong','integer','1')]}
    ])expect(()=>driver.start({sessionId:session.id,maxRows:10,...bad})).toThrow()
    if(tds)expect(()=>driver.start({sessionId:session.id,sql:`SELECT :id DELETE FROM ${table}`,parameters:[p('id','integer','1')],maxRows:1})).toThrow(/one statement/)
    expect((await run(`SELECT COUNT(*) FROM ${table}`)).rows).toEqual([['1']])
    const second=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write',recordHistory:false})
    expect(driver.historyContext(second.id).enabled).toBe(false)
    if(!oracle)await run(tds?'BEGIN TRANSACTION':engine==='mysql'||engine==='mariadb'?'START TRANSACTION':'BEGIN')
    const update=await run(`UPDATE ${table} SET ${q('label')}=:label WHERE ${q('id')}=:id`,[p('label','text','pending'),p('id','integer','1')]);expect(update.complete.transaction).toBe('transaction')
    // SQL Server's default lock-based READ COMMITTED waits on uncommitted writes.
    if(!tds)expect((await run(`SELECT ${q('label')} FROM ${table}`,undefined,second.id)).rows).toEqual([[text]])
    await run('ROLLBACK');expect((await run(`SELECT ${q('label')} FROM ${table}`)).rows).toEqual([[text]])
    if(!oracle)await run(tds?'BEGIN TRANSACTION':engine==='mysql'||engine==='mariadb'?'START TRANSACTION':'BEGIN')
    await run(`INSERT INTO ${table} (${q('id')}) VALUES(:id)`,[p('id','integer','1')],session.id,'failed');await run('ROLLBACK')
    expect((await run(`SELECT :value${from}`,[p('value','text','still usable')])).rows).toEqual([['still usable']])
    await driver.disconnect(second.id)
    const locked=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write',environment:'production'})
    expect(()=>driver.start({sessionId:locked.id,sql:`DELETE FROM ${table} WHERE ${q('id')}=:id`,parameters:[p('id','integer','1')],maxRows:1})).toThrow(/protected/i)
    expect(()=>driver.start({sessionId:locked.id,sql:`SELECT :value${from}`,parameters:[p('value','text','safe')],maxRows:1})).toThrow(/protected/i);await driver.disconnect(locked.id)
    if(embedded) {
      await driver.disconnect(session.id)
      const readonly=await driver.connect({...local,sqliteMode:'read-only',duckdbMode:'read-only'})
      await run(`SELECT :value`,[p('value','text','read-only')],readonly.id)
      await run(`DELETE FROM ${table} WHERE ${q('id')}=:id`,[p('id','integer','1')],readonly.id,'failed');await driver.disconnect(readonly.id)
      session=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'})
    }
    if(['mysql','mariadb'].includes(engine)) {
      const typed=await run("SELECT JSON_OBJECT('n',:n),CAST(:date AS DATETIME(6)),ST_GeomFromText('POINT(1 2)')",[p('n','integer','9007199254740993'),p('date','text','2026-10-14 12:34:56.123456')])
      expect(typed.rows[0][0]).toContain('9007199254740993');expect(typed.rows[0][1]).toBe('2026-10-14 12:34:56.123456');expect(typed.rows[0][2]).toMatch(/^0x[0-9a-f]+$/i)
      await run("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
      expect(driver.getSession(session.id).mysqlSqlMode).toEqual({noBackslashEscapes:true,ansiQuotes:true})
      expect((await run(String.raw`SELECT '\', :value`,[p('value','text',text)])).rows).toEqual([['\\',text]])
    }
    if(['mysql','mariadb','postgres','duckdb'].includes(engine)) {
      const slow=engine==='postgres'?'SELECT pg_sleep(:seconds)':engine==='duckdb'?'SELECT SUM(i%:divisor) FROM range(10000000000) r(i)':'SELECT SLEEP(:seconds)'
      driver.start({sessionId:session.id,sql:slow,parameters:[p(engine==='duckdb'?'divisor':'seconds','integer',engine==='duckdb'?'97':'30')],maxRows:1})
      await new Promise(resolve=>setTimeout(resolve,150));await driver.cancel(session.id);await driver.wait(session.id)
      expect(events.filter(e=>e.type==='complete').at(-1)).toMatchObject({status:'cancelled'})
      await run(`SELECT :value${from}`,[p('value','text','after cancellation')])
    }
    await run(`DROP TABLE ${table}`)
  } finally {try{await run('ROLLBACK');await run(`DROP TABLE ${table}`)}catch{}await driver.close();rmSync(directory,{recursive:true,force:true})}
}
