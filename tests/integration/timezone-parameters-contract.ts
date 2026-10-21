import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'

export async function verifyTimezoneParameters(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(),'dbcommander-timezone-')), events: DatabaseEvent[] = []
  const engine = config.engine, oracle = engine === 'oracle', sqlite = engine === 'sqlite', mysql = ['mysql','mariadb'].includes(engine), tds = ['sqlserver','azure-sql'].includes(engine)
  if (['sqlite','duckdb'].includes(engine)) config = { ...config, filePath: join(directory,'values.db'), sqliteMode: 'create', duckdbMode: 'create' }
  const driver = new DriverRegistry(e => { events.push(e) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const session = await driver.connect(config), q = (s: string) => quoteIdentifier(s,engine), table = q('tz_' + randomUUID().slice(0,8)), from = oracle ? ' FROM dual' : ''
  const value = '2026-10-25T02:30:00.123456+02:00', expected = '2026-10-25T00:30:00.123456'
  const params = (v = value): QueryParameter[] => [{ name:'moment', type:'timestamptz', value:v }]
  // Display UTC explicitly on engines where the session's timezone affects output.
  const utc = (expression: string) => engine === 'postgres' ? `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')` : oracle ? `TO_CHAR(SYS_EXTRACT_UTC(${expression}),'YYYY-MM-DD"T"HH24:MI:SS.FF6','NLS_CALENDAR=GREGORIAN')` : expression
  const normalize = (text: string | null) => text?.replace(' ','T').replace(/ ?[+-]\d{2}(?::\d{2})?$/,'').replace(/(\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/,(_,time,fraction = '') => time + '.' + fraction.padEnd(6,'0'))
  const select = `SELECT ${utc(':moment')} AS ${q('moment')}, ${utc(':moment')} AS ${q('again')}${from}`
  async function run(sql: string, parameters?: QueryParameter[]) {
    const queryId = driver.start({ sessionId:session.id, sql, parameters, maxRows:100 }); await driver.wait(session.id)
    const complete = events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status,complete.error).toBe('completed')
    return { queryId, rows:events.flatMap(e=>e.type==='rows'&&e.queryId===queryId?e.rows:[]) }
  }
  try {
    if (engine === 'postgres') await run("SET TIME ZONE INTERVAL '+05:30' HOUR TO MINUTE")
    if (mysql) await run("SET time_zone='+05:30'")
    if (oracle) { await run("ALTER SESSION SET TIME_ZONE='+05:30'"); await run("ALTER SESSION SET NLS_CALENDAR='Thai Buddha'"); await run("ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT='DD/MM/YYYY HH24:MI:SS TZH:TZM'") }
    if (tds) await run('SET DATEFORMAT dmy')
    const standalone = await run(select,params()); expect(standalone.rows[0].map(normalize)).toEqual([expected,expected])
    for (const [input,output] of [
      ['2026-10-24T20:30:00.123456-04:00',expected],['2026-10-25T00:30:00.123456Z',expected],
      ['2026-10-25T02:30:00.123456+01:00','2026-10-25T01:30:00.123456'],
      ['2026-01-01T00:15:00.000001+05:45','2025-12-31T18:30:00.000001'],
      ['2040-03-01T00:00:00.999999+14:00','2040-02-29T10:00:00.999999'],
      ['2026-12-31T23:59:59.1-14:00','2027-01-01T13:59:59.100000'],
      ['1000-01-01T14:00:00+14:00','1000-01-01T00:00:00.000000'],['9999-12-31T09:59:59.999999-14:00','9999-12-31T23:59:59.999999']
    ]) expect((await run(select,params(input))).rows[0].map(normalize),input).toEqual([output,output])
    const before = events.length, jobs = driver.listTransferJobs(), invalidFile = join(directory,'invalid.json')
    for (const value of ['2026-10-25T02:30:00','2026-10-25T02:30:00-00:00','1000-01-01T00:00:00+01:00','2026-10-25T02:30:00.1234567Z']) {
      const parameters = params(value)
      expect(()=>driver.start({sessionId:session.id,sql:select,parameters,maxRows:1})).toThrow(/Timestamp with timezone/)
      expect(()=>driver.explain({sessionId:session.id,sql:select,parameters,mode:'estimated',executionConfirmed:false})).toThrow(/Timestamp with timezone/)
      expect(()=>driver.startTransfer({action:'export',sessionId:session.id,sql:select,parameters,format:'json',file:invalidFile,confirmed:true})).toThrow(/Timestamp with timezone/)
    }
    expect(events.length).toBe(before); expect(driver.listTransferJobs()).toEqual(jobs); expect(existsSync(invalidFile)).toBe(false)
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY, ${q('moment')} ${sqlite?'TEXT':mysql?'DATETIME(6)':tds?'DATETIMEOFFSET(6)':engine==='duckdb'?'TIMESTAMPTZ':'TIMESTAMP(6) WITH TIME ZONE'})`)
    await run(`INSERT INTO ${table} VALUES (1,:moment)`,params()); if (oracle) await run('COMMIT')
    const tableSql = `SELECT ${utc(q('moment'))} FROM ${table} WHERE ${q('moment')}=:moment`
    // Different offsets, identical instant. A one-microsecond difference and a DST fold must not match.
    expect((await run(tableSql,params('2026-10-24T20:30:00.123456-04:00'))).rows[0].map(normalize)).toEqual([expected])
    for (const different of ['2026-10-25T02:30:00.123457+02:00','2026-10-25T02:30:00.123456+01:00']) expect((await run(tableSql,params(different))).rows).toEqual([])
    await run(oracle?'SAVEPOINT timezone_values':tds?'BEGIN TRANSACTION':'BEGIN')
    await run(`UPDATE ${table} SET ${q('moment')}=:moment`,params('2026-10-25T02:30:00.123456+01:00'))
    expect((await run(tableSql,params())).rows).toEqual([])
    const plan = await driver.explain({sessionId:session.id,sql:tableSql,parameters:params(),mode:'estimated',executionConfirmed:false})
    expect(plan.status,plan.message).toBe('completed'); expect(plan.session.transaction).toBe('transaction')
    for (const v of [value,expected]) expect(plan.submittedSql.join('')).not.toContain(v)
    await run('ROLLBACK'); const retained = await run(tableSql,params()); expect(retained.rows[0].map(normalize)).toEqual([expected])
    const file = join(directory,'timezone.json'), job = driver.startTransfer({action:'export',sessionId:session.id,sql:select,parameters:params(),format:'json',file,confirmed:true})
    await driver.waitTransfer(job.id); expect(driver.listTransferJobs().find(j=>j.id===job.id)).toMatchObject({status:'completed',rows:1})
    expect(JSON.parse(readFileSync(file,'utf8')).rows[0].map(normalize)).toEqual([expected,expected])
    for (const v of [value,expected]) expect(JSON.stringify(driver.listTransferJobs())).not.toContain(v)
    const cached = join(directory,'cached.csv'); await driver.exportCsv(retained.queryId,0,cached); expect(readFileSync(cached,'utf8')).toContain('00:30:00.123456')
    if (mysql) {
      // UTC DATETIME is deliberate: TIMESTAMP storage converts using the session zone.
      await run(`ALTER TABLE ${table} ADD ${q('stored')} TIMESTAMP(6) NULL`)
      await run(`UPDATE ${table} SET ${q('stored')}=:moment`,params())
      await run("SET time_zone='+00:00'")
      expect((await run(`SELECT ${q('moment')},${q('stored')} FROM ${table}`)).rows[0].map(normalize)).toEqual([expected,'2026-10-24T19:00:00.123456'])
      await run(`UPDATE ${table} SET ${q('stored')}=:moment`,params())
      expect((await run(`SELECT ${q('stored')} FROM ${table}`)).rows[0].map(normalize)).toEqual([expected])
    }
    await run(`DROP TABLE ${table}`)
  } finally { try { await run('ROLLBACK'); await run(`DROP TABLE ${table}`) } catch {} await driver.close(); rmSync(directory,{recursive:true,force:true}) }
}
