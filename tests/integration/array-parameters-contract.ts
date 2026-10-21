import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { arrayParameterTypes, type QueryParameter } from '../../src/shared/parameters'

export async function verifyArrayParameters(config: ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-arrays-')), events:DatabaseEvent[]=[]
  const engine=config.engine, oracle=engine==='oracle', tds=['sqlserver','azure-sql'].includes(engine), native=['postgres','duckdb'].includes(engine)
  if (['sqlite','duckdb'].includes(engine)) config={...config,filePath:join(directory,'values.db'),sqliteMode:'create',duckdbMode:'create'}
  const driver=new DriverRegistry(e=>{events.push(e)}, {workerPath:resolve('out/main/sqlite-worker.cjs')})
  const session=await driver.connect(config), q=(s:string)=>quoteIdentifier(s,engine), table=q('arr_'+randomUUID().slice(0,8)), from=oracle?' FROM dual':''
  const array=(type:QueryParameter['type'],values:unknown[],name='items'):QueryParameter=>({name,type,value:JSON.stringify(values)})
  const ids=(values:unknown[]=['1','3',null]):QueryParameter[]=>[array('integer[]',values)]
  async function run(sql:string,parameters?:QueryParameter[],maxRows=100) {
    const queryId=driver.start({sessionId:session.id,sql,parameters,maxRows}); await driver.wait(session.id)
    const complete=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status,complete.error).toBe('completed')
    return {queryId,rows:events.flatMap(e=>e.type==='rows'&&e.queryId===queryId?e.rows:[])}
  }
  const sql=`SELECT ${q('id')} FROM ${table} WHERE ${q('id')} IN (:items) ORDER BY ${q('id')}`
  const hostile="private array'); DELETE FROM customers; -- Ω ,{}\\\"", secretIds=['81234567','91234567']
  try {
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY, ${q('label')} ${oracle?'VARCHAR2(500)':tds?'NVARCHAR(500)':'VARCHAR(500)'}${native?`, ${q('numbers')} BIGINT[]`:''})`)
    for(const id of ['1','2','3']) await run(`INSERT INTO ${table} (${q('id')},${q('label')}) VALUES (:id,:label)`,[{name:'id',type:'integer',value:id},{name:'label',type:'text',value:hostile}])
    if(oracle)await run('COMMIT')
    expect((await run(sql,ids())).rows).toEqual([['1'],['3']])
    expect((await run(sql,ids(['3','1','3']))).rows).toEqual([['1'],['3']])
    expect((await run(sql,ids([]))).rows).toEqual([])
    expect((await run(sql,ids([null]))).rows).toEqual([])
    expect((await run(sql.replace(' IN ',' NOT IN '),ids(['1',null]))).rows).toEqual([])
    expect((await run(sql.replace(' IN ',' NOT IN '),ids([]))).rows).toEqual([['1'],['2'],['3']])
    // Every empty type remains valid even when there are no scalar binds at all.
    for(const type of arrayParameterTypes) {
      expect((await run(`SELECT 1${from} WHERE NULL IN (:items)`,[array(type,[])])).rows).toEqual([])
      expect((await run(`SELECT 1${from} WHERE NULL NOT IN (:items)`,[array(type,[])])).rows).toEqual([['1']])
    }
    expect((await run(`SELECT ${q('id')} FROM ${table} WHERE ${q('label')} IN (:items) ORDER BY ${q('id')}`,[array('text[]',[hostile,null])])).rows).toEqual([['1'],['2'],['3']])
    const cases:[QueryParameter['type'],string,unknown[],unknown[]][]=[
      ['text',hostile,['different',hostile,null],['different',null]],
      ['integer','9223372036854775807',['-9223372036854775808','9223372036854775807',null],['9223372036854775806',null]],
      ['decimal','9007199254740993.12345678',['0.00000001','9007199254740993.12345678',null],['9007199254740993.12345679',null]],
      ['date','2040-02-29',['2040-02-29',null],['2040-02-28',null]],
      ['timestamp','2040-02-29T12:34:56.123456',['2040-02-29 12:34:56.123456',null],['2040-02-29T12:34:56.123457',null]],
      ['timestamptz','2026-10-25T02:30:00.123456+02:00',['2026-10-24T20:30:00.123456-04:00',null],['2026-10-25T02:30:00.123456+01:00',null]],
      ['boolean','true',[false,true,null],[false,null]], ['hex','00ff8041',['00ff8041',null],['00ff8042',null]]
    ]
    for(const [type,value,matches,misses] of cases) {
      const needle:QueryParameter={name:'needle',type,value}
      const comparison=`SELECT CASE WHEN :needle IN (:items) THEN 1 ELSE 0 END${from}`
      expect((await run(comparison,[needle,array((type+'[]') as QueryParameter['type'],matches)])).rows,type).toEqual([['1']])
      expect((await run(comparison,[needle,array((type+'[]') as QueryParameter['type'],misses)])).rows,type).toEqual([['0']])
      if(native) {
        const unnest=`SELECT COUNT(*) FROM unnest(:items) AS listed(value) WHERE value=:needle`
        expect((await run(unnest,[needle,array((type+'[]') as QueryParameter['type'],matches)])).rows,type).toEqual([['1']])
        expect((await run(unnest,[needle,array((type+'[]') as QueryParameter['type'],[])])).rows,type).toEqual([['0']])
        expect((await run(unnest,[needle,array((type+'[]') as QueryParameter['type'],[null,null])])).rows,type).toEqual([['0']])
      }
    }
    if(native) {
      const values=['9223372036854775807',null,'-9223372036854775808','9223372036854775807']
      await run(`UPDATE ${table} SET ${q('numbers')}=:items WHERE ${q('id')}=1`,ids(values))
      expect((await run(`SELECT unnest(${q('numbers')}) FROM ${table} WHERE ${q('id')}=1`)).rows).toEqual(values.map(v=>[v]))
      expect((await run(`SELECT ${q('id')} FROM ${table} WHERE ${q('id')} = ANY(:items) ORDER BY ${q('id')}`,ids())).rows).toEqual([['1'],['3']])
      await run(`UPDATE ${table} SET ${q('numbers')}=:items WHERE ${q('id')}=1`,ids([]))
      expect((await run(`SELECT unnest(${q('numbers')}) FROM ${table} WHERE ${q('id')}=1`)).rows).toEqual([])
    }
    expect((await run(`SELECT 1${from} WHERE 1 IN (:items) OR 2 IN (:items)`,ids(Array(500).fill('1')))).rows).toEqual([['1']])
    const before=events.length, jobs=driver.listTransferJobs(), invalidFile=join(directory,'invalid.json')
    for(const [invalidSql,parameters] of [
      [sql,[{name:'items',type:'integer[]',value:'[9007199254740993]'}]],
      [sql,ids([['1']])], [sql,ids(Array(1001).fill('1'))], [sql,ids(['1\n'])],
      [sql.replace('IN (:items)','IN (:items,2)'),ids()],
      [sql.replace('IN (:items)','IN (:items) OR 2 IN (:items)'),ids(Array(501).fill('1'))],
      ...(!native?[[`SELECT :items${from}`,ids()]]:[])
    ] as [string,QueryParameter[]][]) {
      expect(()=>driver.start({sessionId:session.id,sql:invalidSql,parameters,maxRows:1})).toThrow()
      expect(()=>driver.explain({sessionId:session.id,sql:invalidSql,parameters,mode:'estimated',executionConfirmed:false})).toThrow()
      expect(()=>driver.startTransfer({action:'export',sessionId:session.id,sql:invalidSql,parameters,format:'json',file:invalidFile,confirmed:true})).toThrow()
    }
    expect(events.length).toBe(before); expect(driver.listTransferJobs()).toEqual(jobs); expect(existsSync(invalidFile)).toBe(false)
    await run(oracle?'SAVEPOINT array_values':tds?'BEGIN TRANSACTION':'BEGIN')
    await run(`UPDATE ${table} SET ${q('label')}=:label WHERE ${q('id')} IN (:items)`,[{name:'label',type:'text',value:'updated'},...ids()])
    await run(`DELETE FROM ${table} WHERE ${q('id')} IN (:items)`,ids(['2']))
    expect((await run(`SELECT COUNT(*) FROM ${table} WHERE ${q('label')}=:label`,[{name:'label',type:'text',value:'updated'}])).rows).toEqual([['2']])
    for(const parameters of [ids(secretIds),ids([])]) {
      const plan=await driver.explain({sessionId:session.id,sql,parameters,mode:'estimated',executionConfirmed:false})
      expect(plan.status,plan.message).toBe('completed'); expect(plan.session.transaction).toBe('transaction')
      for(const v of secretIds)expect(plan.submittedSql.join('')).not.toContain(v)
    }
    await run('ROLLBACK')
    const retained=await run(sql,ids(),1); expect(retained.rows).toEqual([['1']])
    for(const [name,parameters,rows] of [['full',ids(),[['1'],['3']]],['empty',ids([]),[]]] as [string,QueryParameter[],string[][]][]) {
      const file=join(directory,name+'.json'), job=driver.startTransfer({action:'export',sessionId:session.id,sql,parameters,format:'json',file,confirmed:true})
      await driver.waitTransfer(job.id); expect(driver.listTransferJobs().find(j=>j.id===job.id)).toMatchObject({status:'completed',rows:rows.length})
      expect(JSON.parse(readFileSync(file,'utf8')).rows).toEqual(rows)
    }
    const cached=join(directory,'cached.csv'); await driver.exportCsv(retained.queryId,0,cached); expect(readFileSync(cached,'utf8')).toMatch(/1/)
    expect((await run(`SELECT COUNT(*) FROM ${table} WHERE ${q('label')} IN (:items)`,[array('text[]',[hostile])])).rows).toEqual([['3']])
    for(const value of [hostile,...secretIds])expect(JSON.stringify(driver.listTransferJobs())).not.toContain(value)
    await run(`DROP TABLE ${table}`)
  } finally {try{await run('ROLLBACK');await run(`DROP TABLE ${table}`)}catch{} await driver.close();rmSync(directory,{recursive:true,force:true})}
}
