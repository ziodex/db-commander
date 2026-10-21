import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { postgresPlan, separatePlanConnection } from '../../src/shared/explain'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'
import { tunneledConfig } from './connection-contract'

export async function verifyExplain(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-plans-')), events: DatabaseEvent[] = []
  if (['sqlite','duckdb'].includes(config.engine)) config = { ...config, filePath: join(directory,'plans.db'), sqliteMode: 'create', duckdbMode: 'create' }
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const name = `plan_${randomUUID().replaceAll('-','').slice(0,10)}`, q = (value: string) => quoteIdentifier(value,config.engine), table = q(name), sequence = q(name + '_sequence')
  const select = `SELECT ${q('id')}, ${q('value')} FROM ${table} WHERE ${q('id')} = 1 ORDER BY ${q('value')}`
  const server = ['sqlserver','azure-sql'].includes(config.engine)
  let id: string | undefined
  async function run(sql: string) {
    const queryId = driver.start({ sessionId: id!, sql, maxRows: 100 }); await driver.wait(id!)
    const completion = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(completion.status, completion.error).toBe('completed')
    return { queryId, rows: events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : []) }
  }
  try {
    id = (await driver.connect(config)).id
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY, ${q('value')} INTEGER)`)
    await run(`INSERT INTO ${table} VALUES(1,10)`); if (config.engine === 'oracle') await run('COMMIT')
    const cached = await run(select), before = events.length
    const plan = await driver.explain({ sessionId: id, sql: select+';', mode: 'estimated', executionConfirmed: false })
    expect(plan.status, plan.message).toBe('completed'); expect(plan.raw.toLowerCase()).toContain(name)
    expect(plan.sql).toBe(select+';')
    expect(plan.source).toBe(separatePlanConnection(config.engine) ? 'separate-connection' : 'session')
    expect(events.length).toBe(before)
    const csv = join(directory, 'retained.csv'); await driver.exportCsv(cached.queryId, 0, csv); expect(readFileSync(csv,'utf8')).toContain('"1","10"')
    if (config.engine === 'postgres') expect(postgresPlan(plan.raw).nodes.length).toBeGreaterThan(0)
    if (server) expect(plan.raw).toContain('ShowPlanXML')
    const parameter = (name: string, type: QueryParameter['type'], value = ''): QueryParameter => ({ name, type, value })
    const boundSelect = `SELECT ${q('id')} FROM ${table} WHERE ${q('id')}=:id OR ${q('id')}=:id`
    const values = [parameter('id', 'integer', '1')]
    const boundPlan = await driver.explain({ sessionId: id, sql: boundSelect, parameters: values, mode: 'estimated', executionConfirmed: false })
    expect(boundPlan.status, boundPlan.message).toBe('completed'); expect(boundPlan.raw.toLowerCase()).toContain(name)
    // Binding is not SQL interpolation, including quotes, Unicode and SQL commands.
    const secret = "plan-private O'Brien Ω ; DELETE FROM customers; --"
    const typed = `SELECT :text AS ${q('label')}, :number AS ${q('large')}, :flag AS ${q('flag')}, :missing AS ${q('missing')}, :bytes AS ${q('bytes')} FROM ${table} WHERE ${q('id')}=:analyze`
    const typedPlan = await driver.explain({ sessionId: id, sql: typed, parameters: [parameter('text', 'text', secret), parameter('number', 'integer', '9223372036854775807'), parameter('flag', 'boolean', 'true'), parameter('missing', 'null'), parameter('bytes', 'hex', '00ff8041'), parameter('analyze', 'integer', '1')], mode: 'estimated', executionConfirmed: false })
    expect(typedPlan.status, typedPlan.message).toBe('completed'); expect(typedPlan.raw.length).toBeGreaterThan(0)
    expect(typedPlan.submittedSql.join('')).not.toContain(secret); expect(typedPlan.sql).toBe(typed)
    expect(events.length).toBe(before)
    const afterPlansCsv = join(directory, 'retained-after-plans.csv')
    await driver.exportCsv(cached.queryId, 0, afterPlansCsv)
    expect(readFileSync(afterPlansCsv, 'utf8')).toBe(readFileSync(csv, 'utf8'))
    expect(readFileSync(afterPlansCsv, 'utf8')).toContain('"1","10"')
    for (const parameters of [undefined, [parameter('wrong', 'integer', '1')], [...values, parameter('unused', 'text', secret)]]) {
      expect(() => driver.explain({ sessionId: id!, sql: boundSelect, parameters, mode: 'estimated', executionConfirmed: false })).toThrow(/parameters/i)
    }
    expect(() => driver.explain({ sessionId: id!, sql: boundSelect + '; DELETE FROM ' + table, parameters: values, mode: 'estimated', executionConfirmed: false })).toThrow(/one statement/)
    const failedBound = await driver.explain({ sessionId: id, sql: 'SELECT :text FROM no_such_parameter_plan_table', parameters: [parameter('text', 'text', secret)], mode: 'estimated', executionConfirmed: false })
    expect(failedBound.status).toBe('failed'); expect(failedBound.raw).toBe(''); expect(failedBound.message).toContain('diagnostics are hidden'); expect(JSON.stringify(failedBound)).not.toContain(secret)
    if (server) {
      // Even SELECT can change server state. A parameterized estimate must not
      // consume a sequence value or quietly fall back to normal execution.
      await run(`CREATE SEQUENCE ${sequence} AS BIGINT START WITH 37 INCREMENT BY 1`)
      expect((await run(`SELECT NEXT VALUE FOR ${sequence}`)).rows).toEqual([['37']])
      const sequencePlan = await driver.explain({ sessionId: id, sql: `SELECT NEXT VALUE FOR ${sequence}, :id FROM ${table}`, parameters: values, mode: 'estimated', executionConfirmed: false })
      expect(sequencePlan.status, sequencePlan.message).toBe('completed'); expect(sequencePlan.raw).toContain('ShowPlanXML')
      expect((await run(`SELECT NEXT VALUE FOR ${sequence}`)).rows).toEqual([['38']])
      await run(`DROP SEQUENCE ${sequence}`)
    }
    if (!server) {
      const update = await driver.explain({ sessionId: id, sql: `UPDATE ${table} SET ${q('value')}=:next WHERE ${q('id')}=:id`, parameters: [...values, parameter('next', 'integer', '20')], mode: 'estimated', executionConfirmed: false })
      expect(update.status, update.message).toBe('completed'); expect((await run(select)).rows[0][1]).toBe('10')
    }
    expect(() => driver.explain({ sessionId: id!, sql: select+'; DELETE FROM '+table, mode: 'estimated', executionConfirmed: false })).toThrow(/one statement/)
    const invalid = await driver.explain({ sessionId: id, sql: 'SELECT * FROM no_such_plan_table_948561', mode: 'estimated', executionConfirmed: false })
    expect(invalid.status).toBe('failed'); expect(invalid.raw).toBe(''); expect((await run(select)).rows[0][1]).toBe('10')
    await run(config.engine === 'oracle' ? 'SAVEPOINT PLAN_TEST' : server ? 'BEGIN TRANSACTION' : 'BEGIN')
    await run(`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    const inTransaction = await driver.explain({ sessionId: id, sql: boundSelect, parameters: values, mode: 'estimated', executionConfirmed: false })
    expect(inTransaction.status, inTransaction.message).toBe('completed'); expect(inTransaction.session.transaction).toBe('transaction')
    expect((await run(select)).rows[0][1]).toBe('11'); await run('ROLLBACK'); expect((await run(select)).rows[0][1]).toBe('10')
    if (config.engine === 'postgres') {
      expect(() => driver.explain({ sessionId: id!, sql: boundSelect, parameters: values, mode: 'analyze', executionConfirmed: false })).toThrow(/Confirm/)
      await run('BEGIN')
      const actual = await driver.explain({ sessionId: id, sql: `UPDATE ${table} SET ${q('value')}=:next WHERE ${q('id')}=:id`, parameters: [...values, parameter('next', 'integer', '12')], mode: 'analyze', executionConfirmed: true })
      expect(actual.status,actual.message).toBe('completed'); expect(postgresPlan(actual.raw).executionTime).toBeTypeOf('number')
      expect((await run(select)).rows[0][1]).toBe('12'); await run('ROLLBACK')
      await run('BEGIN')
      const failedTransaction = await driver.explain({ sessionId: id, sql: 'SELECT * FROM missing_in_plan_transaction', mode: 'estimated', executionConfirmed: false })
      expect(failedTransaction.status).toBe('failed'); expect(failedTransaction.session.transaction).toBe('failed')
      await run('ROLLBACK')
      await run(`CREATE TEMP TABLE plan_temp AS SELECT 1 AS id`)
      expect((await driver.explain({ sessionId: id, sql: 'SELECT * FROM plan_temp', mode: 'estimated', executionConfirmed: false })).status).toBe('completed')
      const pending = driver.explain({ sessionId: id, sql: 'SELECT pg_sleep(:seconds)', parameters: [parameter('seconds', 'integer', '20')], mode: 'analyze', executionConfirmed: true })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(() => driver.start({ sessionId: id!, sql: 'SELECT 1', maxRows: 1 })).toThrow(/operation/)
      expect(driver.cancelExplain(id).requested).toBe(true)
      expect((await pending).status).toBe('cancelled'); expect((await run(select)).rows[0][1]).toBe('10')
    } else expect(() => driver.explain({ sessionId: id!, sql: select, mode: 'analyze', executionConfirmed: true })).toThrow(/only for PostgreSQL/)
    const guarded = await driver.connect({ ...config, environment: 'production', sqliteMode: 'read-write', duckdbMode: 'read-write' })
    expect(() => driver.explain({ sessionId: guarded.id, sql: boundSelect, parameters: values, mode: 'estimated', executionConfirmed: false })).toThrow(/locked/)
    await driver.disconnect(guarded.id)
    if (!['sqlite','duckdb'].includes(config.engine)) {
      const ssh = await driver.connect(tunneledConfig(config))
      const tunneled = await driver.explain({ sessionId: ssh.id, sql: boundSelect, parameters: values, mode: 'estimated', executionConfirmed: false })
      expect(tunneled.status,tunneled.message).toBe('completed'); expect(tunneled.raw.toLowerCase()).toContain(name); await driver.disconnect(ssh.id)
    }
    if (['mysql', 'mariadb'].includes(config.engine)) {
      await run("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
      const modes = await driver.explain({ sessionId: id, sql: String.raw`SELECT '\', :label FROM ` + table, parameters: [parameter('label', 'text', secret)], mode: 'estimated', executionConfirmed: false })
      expect(modes.status, modes.message).toBe('completed')
    }
    await run(`DROP TABLE ${table}`)
  } finally {
    if (id && server) { try { await run(`DROP SEQUENCE IF EXISTS ${sequence}`) } catch {} }
    if (id) { try { await run('ROLLBACK'); await run(`DROP TABLE ${table}`) } catch {} }
    await driver.close(); rmSync(directory,{recursive:true,force:true})
  }
}
