import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'

export async function verifyTypedParameters(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-typed-')), events: DatabaseEvent[] = []
  const engine = config.engine, oracle = engine === 'oracle', sqlite = engine === 'sqlite', mysql = ['mysql','mariadb'].includes(engine), tds = ['sqlserver','azure-sql'].includes(engine)
  if (['sqlite','duckdb'].includes(engine)) config = { ...config, filePath: join(directory,'values.db'), sqliteMode: 'create', duckdbMode: 'create' }
  const driver = new DriverRegistry(e => { events.push(e) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const session = await driver.connect(config), q = (s: string) => quoteIdentifier(s,engine), table = q('typed_' + randomUUID().slice(0,8)), from = oracle ? ' FROM dual' : ''
  const decimal = '9007199254740993.12345678', date = '2040-02-29', timestamp = '2026-03-29T02:30:00.123456'
  const parameters: QueryParameter[] = [{ name: 'amount', type: 'decimal', value: decimal }, { name: 'day', type: 'date', value: date }, { name: 'moment', type: 'timestamp', value: timestamp }]
  const expected = [decimal, oracle ? date + ' 00:00:00' : date, timestamp.replace('T',' ') + (oracle ? '000' : '')]
  const select = `SELECT :amount AS ${q('amount')}, :day AS ${q('day')}, :moment AS ${q('moment')}, :amount AS ${q('again')}${from}`
  async function run(sql: string, values?: QueryParameter[]) {
    const queryId = driver.start({ sessionId: session.id, sql, parameters: values, maxRows: 100 }); await driver.wait(session.id)
    const complete = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status, complete.error).toBe('completed')
    return { queryId, rows: events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : []) }
  }
  try {
    // Calendar fields stay unchanged in a non-UTC session and across a DST gap.
    if (engine === 'postgres') await run("SET TIME ZONE '+05:00'")
    if (mysql) await run("SET time_zone='+05:00'")
    if (oracle) await run("ALTER SESSION SET TIME_ZONE='+05:00'")
    const standalone = await run(select, parameters); expect(standalone.rows).toEqual([[...expected,decimal]])
    for (const value of ['-9007199254740993.12345678','9'.repeat(38),'0.'+'1234567891'.repeat(3)]) {
      const result = await run(`SELECT :n${from}`, [{ name:'n', type:'decimal', value }])
      expect(result.rows[0][0]?.replace(/^(-?)\./,(_,sign)=>sign+'0.')).toBe(value)
    }
    for (const value of ['1000-01-01','9999-12-31']) expect((await run(`SELECT :d${from}`,[{name:'d',type:'date',value}])).rows).toEqual([[oracle?value+' 00:00:00':value]])
    for (const value of ['1000-01-01 00:00:00','9999-12-31 23:59:59.999999','2026-03-29T02:30:00.1']) {
      const result = await run(`SELECT :t${from}`,[{name:'t',type:'timestamp',value}])
      // Native display can omit zeros or add Oracle's three extra zero digits.
      const normalized = (text: string) => text.replace('T',' ').replace(/\.([0-9]*?)0+$/,'.$1').replace(/\.$/,'')
      expect(normalized(result.rows[0][0]!)).toBe(normalized(value))
    }
    const before = events.length, jobs = driver.listTransferJobs()
    for (const bad of [{name:'amount',type:'decimal',value:'1e10'}, {name:'day',type:'date',value:'2040-02-30'}, {name:'moment',type:'timestamp',value:'2026-03-29 02:30:00Z'}] as QueryParameter[]) {
      const values = parameters.map(p => p.name === bad.name ? bad : p)
      expect(() => driver.start({sessionId:session.id,sql:select,parameters:values,maxRows:1})).toThrow()
      expect(() => driver.explain({sessionId:session.id,sql:select,parameters:values,mode:'estimated',executionConfirmed:false})).toThrow()
      expect(() => driver.startTransfer({action:'export',sessionId:session.id,sql:select,parameters:values,format:'json',file:join(directory,'invalid.json'),confirmed:true})).toThrow()
    }
    expect(events.length).toBe(before); expect(driver.listTransferJobs()).toEqual(jobs)
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY, ${q('amount')} ${sqlite?'TEXT':'DECIMAL(30,8)'}, ${q('day')} ${sqlite?'TEXT':'DATE'}, ${q('moment')} ${sqlite?'TEXT':mysql?'DATETIME(6)':tds?'DATETIME2(6)':'TIMESTAMP(6)'})`)
    await run(`INSERT INTO ${table} VALUES(1,:amount,:day,:moment)`,parameters); if (oracle) await run('COMMIT')
    const tableSql = `SELECT ${q('amount')},${q('day')},${q('moment')} FROM ${table} WHERE ${q('amount')}=:amount AND ${q('day')}=:day AND ${q('moment')}=:moment`
    expect((await run(tableSql,parameters)).rows).toEqual([expected])
    await run(oracle?'SAVEPOINT typed_values':tds?'BEGIN TRANSACTION':'BEGIN')
    await run(`UPDATE ${table} SET ${q('amount')}=:amount,${q('day')}=:day,${q('moment')}=:moment`, parameters.map(p => p.name==='amount'?{...p,value:'-123.45678901'}:p))
    expect(driver.getSession(session.id).transaction).toBe('transaction')
    const plan = await driver.explain({sessionId:session.id,sql:tableSql,parameters,mode:'estimated',executionConfirmed:false})
    expect(plan.status,plan.message).toBe('completed'); expect(plan.session.transaction).toBe('transaction')
    for (const value of [decimal,date,timestamp]) expect(plan.submittedSql.join('')).not.toContain(value)
    await run('ROLLBACK'); const retained = await run(tableSql,parameters); expect(retained.rows).toEqual([expected])
    const file=join(directory,'exact.json'), job=driver.startTransfer({action:'export',sessionId:session.id,sql:select,parameters,format:'json',file,confirmed:true})
    await driver.waitTransfer(job.id)
    expect(driver.listTransferJobs().find(j=>j.id===job.id)).toMatchObject({status:'completed',rows:1})
    expect(JSON.parse(readFileSync(file,'utf8')).rows).toEqual([[...expected,decimal]])
    for (const value of [decimal,date,timestamp]) expect(JSON.stringify(driver.listTransferJobs())).not.toContain(value)
    const cached=join(directory,'cached.csv'); await driver.exportCsv(retained.queryId,0,cached); expect(readFileSync(cached,'utf8')).toContain(decimal)
    if (oracle) {
      await run("ALTER SESSION SET NLS_NUMERIC_CHARACTERS=',.'")
      await run("ALTER SESSION SET NLS_DATE_FORMAT='DD/MM/YYYY'")
      await run("ALTER SESSION SET NLS_TIMESTAMP_FORMAT='DD/MM/YYYY HH24:MI:SS'")
      await run("ALTER SESSION SET NLS_CALENDAR='Thai Buddha'")
      const stable = await run(`SELECT TO_CHAR(:amount,'FM9999999999999999D99999999','NLS_NUMERIC_CHARACTERS=''.,'''),TO_CHAR(:day,'YYYY-MM-DD','NLS_CALENDAR=GREGORIAN'),TO_CHAR(:moment,'YYYY-MM-DD HH24:MI:SS.FF6','NLS_CALENDAR=GREGORIAN') FROM dual`,parameters)
      expect(stable.rows).toEqual([[decimal,date,timestamp.replace('T',' ')]])
    }
    await run(`DROP TABLE ${table}`)
  } finally { try { await run('ROLLBACK'); await run(`DROP TABLE ${table}`) } catch {} await driver.close(); rmSync(directory,{recursive:true,force:true}) }
}
