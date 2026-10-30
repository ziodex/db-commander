import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { objectScripts, qualifySourceDeclaration } from '../../src/shared/object-scripts'
import { routineCall } from '../../src/shared/routine-call'

export async function verifyObjectSource(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const engine = config.engine, local = engine === 'sqlite' ? { ...config, sqliteMode: 'memory' as const } : engine === 'duckdb' ? { ...config, duckdbMode: 'memory' as const } : config
  const session = await driver.connect(local), name = 'source_' + randomUUID().replaceAll('-', '').slice(0, 12), q = (value: string) => quoteIdentifier(value, engine)
  const schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? config.user.toUpperCase() : ['sqlite','duckdb'].includes(engine) ? 'main' : session.database
  const qualified = `${q(schema)}.${q(name)}`, select = (n: number) => `SELECT ${n} AS id${engine === 'oracle' ? ' FROM dual' : ''}`
  const create = (n: number) => `CREATE VIEW ${qualified} AS ${select(n)}`
  const replace = (n: number) => `${['sqlserver','azure-sql'].includes(engine) ? 'ALTER VIEW' : 'CREATE OR REPLACE VIEW'} ${qualified} AS ${select(n)}`
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 10 }); await driver.wait(session.id)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  async function current() {
    const snapshot = await driver.schema(session.id), object = snapshot.catalog?.objects.find(object => object.name === name && object.schema === schema && object.kind === 'view')
    expect(object).toBeDefined()
    const detail = await driver.inspectObject({ sessionId: session.id, object: object! })
    expect(detail.definition.sql, detail.definition.notice).toBeTruthy()
    return { object: object!, detail }
  }
  try {
    await run(create(1))
    let { object, detail } = await current()
    const draft = engine === 'sqlite' ? create(2) : replace(2)
    const change = { action: 'edit-source' as const, target: object, baseDefinition: detail.definition.sql!, sql: draft }
    const stale = await driver.prepareSchemaChange({ sessionId: session.id, change })
    if (engine === 'sqlite') { await run(`DROP VIEW ${qualified}`); await run(create(3)) } else await run(replace(3))
    const refused = await driver.applySchemaChange({ sessionId: session.id, planId: stale.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
    expect(refused.status).toBe('failed'); expect(refused.message).toMatch(/changed|visible|available/i)
    expect((await run(`SELECT id FROM ${qualified}`)).map(row => row[0])).toEqual(['3'])
    ;({ object, detail } = await current())
    if (engine === 'sqlite') {
      const invalid = await driver.prepareSchemaChange({ sessionId: session.id, change: { ...change, target: object, baseDefinition: detail.definition.sql!, sql: `CREATE VIEW ${qualified} AS SELECT FROM` } })
      const failed = await driver.applySchemaChange({ sessionId: session.id, planId: invalid.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: true })
      expect(failed.status).toBe('failed'); expect(failed.message).toMatch(/rolled back/)
      expect((await run(`SELECT id FROM ${qualified}`)).map(row => row[0])).toEqual(['3'])
    }
    const review = await driver.prepareSchemaChange({ sessionId: session.id, change: { ...change, target: object, baseDefinition: detail.definition.sql! } })
    expect(review.sql).toContain(draft); expect(review.destructive).toBe(true)
    await expect(driver.applySchemaChange({ sessionId: session.id, planId: review.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: false })).rejects.toThrow(/destructive/)
    const result = await driver.applySchemaChange({ sessionId: session.id, planId: review.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
    expect(result.status, result.message).toBe('completed')
    if (result.session.transaction === 'transaction') await run('COMMIT')
    expect((await run(`SELECT id FROM ${qualified}`)).map(row => row[0])).toEqual(['2'])
  } finally {
    try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK') } catch {}
    try { await run(`DROP VIEW ${qualified}`) } catch {}
    await driver.close()
  }
}

export async function verifyRoutineSource(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const session = await driver.connect(config), engine = session.engine, name = 'source_fn_' + randomUUID().replaceAll('-', '').slice(0, 10), q = (value: string) => quoteIdentifier(value, engine)
  const schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? config.user.toUpperCase() : session.database
  const full = `${q(schema)}.${q(name)}`
  const initial = engine === 'postgres' ? `CREATE FUNCTION ${full}(value_arg integer) RETURNS integer LANGUAGE SQL AS 'SELECT value_arg + 1'`
    : ['mysql','mariadb'].includes(engine) ? `CREATE FUNCTION ${full}(value_arg INT) RETURNS INT DETERMINISTIC RETURN value_arg + 1`
    : engine === 'oracle' ? `CREATE FUNCTION ${full}(value_arg NUMBER) RETURN NUMBER IS BEGIN RETURN value_arg + 1; END;\n/`
    : `CREATE FUNCTION ${full}(@value_arg INT) RETURNS INT AS BEGIN RETURN @value_arg + 1; END`
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 10 }); await driver.wait(session.id)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  try {
    await run(initial)
    const object = (await driver.schema(session.id)).catalog?.objects.find(object => object.name === name && object.schema === schema && object.kind === 'function')
    expect(object).toBeDefined()
    const detail = await driver.inspectObject({ sessionId: session.id, object: object! }), scripts = objectScripts(engine, object!, detail)
    const original = qualifySourceDeclaration(engine, object!, scripts.alter ?? scripts.create ?? '')
    expect(original).toMatch(/\+\s*1/)
    const draft = original.replace(/\+\s*1/, '+ 2')
    const plan = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'edit-source', target: object!, baseDefinition: detail.definition.sql!, sql: draft } })
    const result = await driver.applySchemaChange({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
    const diagnostics = result.status !== 'completed' && engine === 'oracle' ? (await driver.inspectObject({ sessionId: session.id, object: object! })).sections.find(section => section.title === 'Compilation diagnostics')?.rows : undefined
    expect(result.status, `${result.message}\nReviewed SQL: ${plan.sql}\nDiagnostics: ${JSON.stringify(diagnostics)}`).toBe('completed')
    if (result.session.transaction === 'transaction') await run('COMMIT')
    expect((await run(`SELECT ${full}(10)${engine === 'oracle' ? ' FROM dual' : ''}`)).map(row => row[0])).toEqual(['12'])
    const latest = (await driver.schema(session.id)).catalog?.objects.find(item => item.name === name && item.schema === schema && item.kind === 'function')!
    const call = routineCall(engine, await driver.inspectObject({ sessionId: session.id, object: latest }))
    expect(call.sql, call.notice).toBeTruthy(); expect(call.arguments).toHaveLength(1)
    const id = driver.start({ sessionId: session.id, sql: call.sql!, maxRows: 10, parameters: [{ name: 'arg1', type: 'integer', value: '10' }] }); await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete' && event.queryId === id)).toMatchObject({ status: 'completed' })
    expect(events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : []).map(row => row[0])).toEqual(['12'])
    if (['mysql', 'mariadb'].includes(engine)) {
      const refreshed = await driver.inspectObject({ sessionId: session.id, object: latest }), broken = objectScripts(engine, latest, refreshed).create!.replace(/\+\s*2/, '+ )')
      const risky = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'edit-source', target: latest, baseDefinition: refreshed.definition.sql!, sql: broken } })
      const failed = await driver.applySchemaChange({ sessionId: session.id, planId: risky.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
      expect(failed.status).toBe('failed'); expect(failed.message).toMatch(/original object may have been dropped/)
      expect((await driver.schema(session.id)).catalog?.objects.some(item => item.name === name && item.kind === 'function')).toBe(false)
    }
    if (engine === 'oracle') {
      const refreshed = await driver.inspectObject({ sessionId: session.id, object: latest }), broken = objectScripts(engine, latest, refreshed).alter!.replace(/\+\s*2/, '+ missing_identifier')
      const invalid = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'edit-source', target: latest, baseDefinition: refreshed.definition.sql!, sql: broken } })
      const failed = await driver.applySchemaChange({ sessionId: session.id, planId: invalid.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
      expect(failed.status).toBe('failed'); expect(failed.message).toMatch(/committed.*invalid/i)
      const invalidDetail = await driver.inspectObject({ sessionId: session.id, object: latest })
      expect(invalidDetail.sections.find(section => section.title === 'Compilation status')?.rows[0]).toEqual(['INVALID'])
      expect(invalidDetail.sections.find(section => section.title === 'Compilation diagnostics')?.rows.length).toBeGreaterThan(0)
    }
  } finally {
    try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK') } catch {}
    try { await run(`DROP FUNCTION ${full}${engine === 'postgres' ? '(integer)' : ''}`) } catch {}
    await driver.close()
  }
}

export async function verifyTriggerSource(config: ConnectionConfig, disabled = false) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const local = config.engine === 'sqlite' ? { ...config, sqliteMode: 'memory' as const } : config
  const session = await driver.connect(local), engine = session.engine, suffix = randomUUID().replaceAll('-', '').slice(0, 10), table = `source_table_${suffix}`, name = `source_trigger_${suffix}`, fn = `source_trigger_fn_${suffix}`
  const q = (value: string) => quoteIdentifier(value, engine), schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? config.user.toUpperCase() : engine === 'sqlite' ? 'main' : session.database
  const full = (value: string) => `${q(schema)}.${q(value)}`
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 10 }); await driver.wait(session.id)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  try {
    await run(`CREATE TABLE ${full(table)} (id INTEGER)`)
    if (engine === 'postgres') await run(`CREATE FUNCTION ${full(fn)}() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'`)
    const initial = engine === 'postgres' ? `CREATE TRIGGER ${q(name)} BEFORE INSERT ON ${full(table)} FOR EACH ROW EXECUTE FUNCTION ${full(fn)}()`
      : ['mysql','mariadb'].includes(engine) ? `CREATE TRIGGER ${full(name)} BEFORE INSERT ON ${full(table)} FOR EACH ROW SET NEW.id = NEW.id + 1`
      : engine === 'sqlite' ? `CREATE TRIGGER ${full(name)} AFTER INSERT ON ${q(table)} BEGIN SELECT 1; END`
      : engine === 'oracle' ? `CREATE TRIGGER ${full(name)} BEFORE INSERT ON ${full(table)} FOR EACH ROW BEGIN :NEW.id := :NEW.id + 1; END;\n/`
      : `CREATE TRIGGER ${full(name)} ON ${full(table)} AFTER INSERT AS BEGIN SET NOCOUNT ON; END`
    await run(initial)
    if (engine === 'oracle' && disabled) await run(`ALTER TRIGGER ${full(name)} DISABLE`)
    const object = (await driver.schema(session.id)).catalog?.objects.find(object => object.name === name && object.kind === 'trigger')
    expect(object).toBeDefined()
    const detail = await driver.inspectObject({ sessionId: session.id, object: object! }), scripts = objectScripts(engine, object!, detail)
    const original = qualifySourceDeclaration(engine, object!, scripts.alter ?? scripts.create ?? '')
    const marker = engine === 'postgres' ? /BEFORE INSERT/i : engine === 'sqlite' ? /SELECT 1/i : ['sqlserver','azure-sql'].includes(engine) ? /NOCOUNT ON/i : /\+\s*1/
    expect(original).toMatch(marker)
    const draft = original.replace(marker, engine === 'postgres' ? 'BEFORE UPDATE' : engine === 'sqlite' ? 'SELECT 2' : ['sqlserver','azure-sql'].includes(engine) ? 'NOCOUNT OFF' : '+ 2')
    const plan = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'edit-source', target: object!, baseDefinition: detail.definition.sql!, sql: draft } })
    const result = await driver.applySchemaChange({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })
    const diagnostics = result.status !== 'completed' && engine === 'oracle' ? (await driver.inspectObject({ sessionId: session.id, object: object! })).sections.find(section => section.title === 'Compilation diagnostics')?.rows : undefined
    expect(result.status, `${result.message}\nReviewed SQL: ${plan.sql}\nDiagnostics: ${JSON.stringify(diagnostics)}`).toBe('completed')
    if (result.session.transaction === 'transaction') await run('COMMIT')
    const updated = (await driver.schema(session.id)).catalog?.objects.find(item => item.name === name && item.kind === 'trigger')
    expect(updated).toBeDefined()
    const after = await driver.inspectObject({ sessionId: session.id, object: updated! })
    expect(after.definition.sql).toMatch(engine === 'postgres' ? /BEFORE UPDATE/i : engine === 'sqlite' ? /SELECT 2/i : ['sqlserver','azure-sql'].includes(engine) ? /NOCOUNT OFF/i : /\+\s*2/)
    if (engine === 'oracle') expect((await run(`SELECT status FROM user_triggers WHERE trigger_name = '${name}'`))[0]?.[0]).toBe(disabled ? 'DISABLED' : 'ENABLED')
  } finally {
    try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK') } catch {}
    try { await run(`DROP TABLE ${full(table)}`) } catch {}
    if (engine === 'postgres') try { await run(`DROP FUNCTION ${full(fn)}()` ) } catch {}
    await driver.close()
  }
}

export async function verifyMacroSource(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const session = await driver.connect({ ...config, duckdbMode: 'memory' }), name = `source_macro_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 10 }); await driver.wait(session.id)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  try {
    await run(`CREATE MACRO "${name}"(x) AS x + 1`)
    const object = (await driver.schema(session.id)).catalog?.objects.find(object => object.name === name && object.kind === 'macro')!
    expect(object).toBeDefined()
    const detail = await driver.inspectObject({ sessionId: session.id, object }), draft = objectScripts('duckdb', object, detail).alter!
    expect(draft).toMatch(/\+\s*1/)
    const plan = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'edit-source', target: object, baseDefinition: detail.definition.sql!, sql: draft.replace(/\+\s*1/, '+ 2') } })
    expect(plan.warnings.join(' ')).toMatch(/defaults and types/)
    const result = await driver.applySchemaChange({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: true })
    expect(result.status, result.message).toBe('completed'); await run('COMMIT')
    expect((await run(`SELECT "${name}"(10)`)).map(row => row[0])).toEqual(['12'])
    const updated = (await driver.schema(session.id)).catalog?.objects.find(item => item.name === name && item.kind === 'macro')!
    const call = routineCall('duckdb', await driver.inspectObject({ sessionId: session.id, object: updated }))
    expect(call.sql, call.notice).toBeTruthy(); expect(call.arguments).toHaveLength(1)
    const id = driver.start({ sessionId: session.id, sql: call.sql!, maxRows: 10, parameters: [{ name: 'arg1', type: 'integer', value: '10' }] }); await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete' && event.queryId === id)).toMatchObject({ status: 'completed' })
    expect(events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : []).map(row => row[0])).toEqual(['12'])
  } finally { try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK') } catch {}; await driver.close() }
}

export async function verifyProcedureCall(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const session = await driver.connect(config), engine = session.engine, suffix = randomUUID().replaceAll('-', '').slice(0, 10), name = `call_proc_${suffix}`, table = `call_table_${suffix}`
  const q = (value: string) => quoteIdentifier(value, engine), schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? config.user.toUpperCase() : session.database
  const full = (value: string) => `${q(schema)}.${q(value)}`
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 10 }); await driver.wait(session.id)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  try {
    await run(`CREATE TABLE ${full(table)} (id INTEGER)`)
    const ddl = engine === 'postgres' ? `CREATE PROCEDURE ${full(name)}(value_arg integer) LANGUAGE SQL AS 'INSERT INTO ${full(table)} VALUES (value_arg)'`
      : ['mysql','mariadb'].includes(engine) ? `CREATE PROCEDURE ${full(name)}(IN value_arg INT) INSERT INTO ${full(table)} VALUES (value_arg)`
      : engine === 'oracle' ? `CREATE PROCEDURE ${full(name)}(value_arg IN NUMBER) AS BEGIN INSERT INTO ${full(table)} VALUES (value_arg); END;\n/`
      : `CREATE PROCEDURE ${full(name)} @value_arg INT AS INSERT INTO ${full(table)} VALUES (@value_arg)`
    await run(ddl)
    const object = (await driver.schema(session.id)).catalog?.objects.find(item => item.name === name && item.schema === schema && item.kind === 'procedure')!
    expect(object).toBeDefined()
    const call = routineCall(engine, await driver.inspectObject({ sessionId: session.id, object }))
    expect(call.sql, call.notice).toBeTruthy(); expect(call.arguments).toHaveLength(1)
    const id = driver.start({ sessionId: session.id, sql: call.sql!, maxRows: 10, parameters: [{ name: 'arg1', type: 'integer', value: '7331' }] }); await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete' && event.queryId === id)).toMatchObject({ status: 'completed' })
    expect(JSON.stringify(events.filter(event => 'queryId' in event && event.queryId === id))).not.toContain('7331')
    expect((await run(`SELECT id FROM ${full(table)}`)).map(row => row[0])).toEqual(['7331'])
    if (engine === 'postgres') {
      const outName = name + '_out'
      try {
        await run(`CREATE PROCEDURE ${full(outName)}(IN value_arg integer, OUT result integer) LANGUAGE plpgsql AS $$ BEGIN result := value_arg + 1; END $$`)
        const outputObject = (await driver.schema(session.id)).catalog?.objects.find(item => item.name === outName && item.kind === 'procedure')!
        const outputCall = routineCall(engine, await driver.inspectObject({ sessionId: session.id, object: outputObject }))
        expect(outputCall.sql).toContain('NULL'); expect(outputCall.arguments).toHaveLength(1)
        const outputId = driver.start({ sessionId: session.id, sql: outputCall.sql!, maxRows: 10, parameters: [{ name: 'arg1', type: 'integer', value: '5' }] }); await driver.wait(session.id)
        expect(events.find(event => event.type === 'complete' && event.queryId === outputId)).toMatchObject({ status: 'completed' })
        expect(events.flatMap(event => event.type === 'rows' && event.queryId === outputId ? event.rows : []).map(row => row[0])).toEqual(['6'])
      } finally { try { await run(`DROP PROCEDURE ${full(outName)}(integer)`) } catch {} }
    }
  } finally {
    try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK') } catch {}
    try { await run(`DROP PROCEDURE ${full(name)}${engine === 'postgres' ? '(integer)' : ''}`) } catch {}
    try { await run(`DROP TABLE ${full(table)}`) } catch {}
    await driver.close()
  }
}
