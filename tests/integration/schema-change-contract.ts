import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { schemaColumnSchema, transactionalDdl, supportsCreateSchema, type SchemaChange, type SchemaChangePlan } from '../../src/shared/schema-changes'

export async function verifySchemaChanges(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-ddl-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const engine = config.engine, embedded = ['sqlite','duckdb'].includes(engine), transactional = transactionalDdl(engine)
  const local = embedded ? { ...config, filePath: join(directory,'schema.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : config
  const session = await driver.connect(local), prefix = `ddl_${randomUUID().replaceAll('-','').slice(0,8)}`, name = prefix+" odd'", renamed = prefix+'_renamed', generatedName = prefix+'_generated', identityAddName = prefix+'_identity_added', alwaysName = prefix+'_identity_always', generatedKeyName = prefix+'_generated_key'
  const schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? config.user.toUpperCase() : embedded ? 'main' : session.database
  const location = { schema, ...(engine === 'duckdb' ? { catalog: session.database } : {}) }
  const q = (value: string) => quoteIdentifier(value, engine), full = (name: string) => [...(location.catalog ? [q(location.catalog)] : []),q(schema),q(name)].join('.')
  const column = (name: string, nullable = true) => schemaColumnSchema.parse({ name, type: 'integer', nullable })
  async function run(sql: string, id = session.id) {
    const queryId = driver.start({ sessionId: id, sql, maxRows: 100 }); await driver.wait(id)
    const complete = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return { queryId, rows: events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : []) }
  }
  const prepare = (change: SchemaChange) => driver.prepareSchemaChange({ sessionId: session.id, change })
  const apply = (plan: SchemaChangePlan, overrides = {}) => driver.applySchemaChange({ sessionId: session.id, planId: plan.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true, ...overrides })
  const object = async (name: string, kind = 'table') => {
    const object = (await driver.schema(session.id)).catalog?.objects.find(o => o.name === name && o.kind === kind)
    expect(object, `${kind} ${name} should be visible`).toBeDefined(); return object!
  }
  async function change(change: SchemaChange) {
    const plan = await prepare(change), result = await apply(plan)
    expect(result.status, result.message).toBe('completed')
    expect(result.session.transaction).toBe(transactional ? 'transaction' : 'idle')
    if (transactional) await run('COMMIT')
    return result
  }
  const create: SchemaChange = { action: 'create-table', location, name, columns: [column('id',false), schemaColumnSchema.parse({ name: 'label', type: 'varchar', length: 100, nullable: true, default: { kind: 'text', value: "quote'\\;-- 世界" } }), schemaColumnSchema.parse({ name: 'expression_default', type: 'integer', nullable: true, default: { kind: 'expression', value: '1 + 2' } })] }
  create.columns[0].primaryKey = true
  let other: Awaited<ReturnType<typeof driver.connect>> | undefined
  try {
    const cached = await run(engine === 'oracle' ? 'SELECT 42 FROM dual' : 'SELECT 42')
    const count = events.length, plan = await prepare(create)
    expect(events).toHaveLength(count)
    expect(plan.sql).toContain('CREATE TABLE'); expect(plan.transaction).toBe(transactional ? 'transactional' : 'implicit-commit')
    expect((await driver.schema(session.id)).catalog?.objects.some(o => o.name === name)).toBe(false)
    if (!transactional) await expect(apply(plan, { implicitCommitApproved: false })).rejects.toThrow(/implicit commit/)
    const first = await apply(plan)
    expect(first.status, first.message).toBe('completed'); expect(events).toHaveLength(count)
    await driver.exportCsv(cached.queryId, 0, join(directory,'cached.csv')); expect(readFileSync(join(directory,'cached.csv'),'utf8')).toContain('42')
    await expect(apply(plan)).rejects.toThrow(transactional ? /Commit or roll back/ : /expired/)
    await run('ROLLBACK')
    const visible = (await driver.schema(session.id)).catalog?.objects.some(o => o.name === name)
    expect(visible).toBe(!transactional)
    if (transactional) await change(create)
    other = await driver.connect(embedded ? { ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' } : config)
    expect((await driver.schema(other.id)).catalog?.objects.some(o => o.name === name)).toBe(true)
    const id = { ...column('generated_id', false), primaryKey: true, ...(engine === 'duckdb' ? {} : { generation: { kind: 'identity' as const, mode: ['postgres','oracle'].includes(engine) ? 'by-default' as const : 'auto' as const } }) }
    const storage = ['postgres','mysql','mariadb','sqlserver','azure-sql'].includes(engine) ? 'stored' as const : 'virtual' as const
    const computed = (name: string, amount: number) => schemaColumnSchema.parse({ name, type: 'integer', nullable: true, generation: { kind: 'computed', expression: `${q('quantity')} + ${amount}`, storage } })
    await change({ action: 'create-table', location, name: generatedName, columns: [id, column('quantity'), computed('calculated', 1)] })
    await run(engine === 'duckdb' ? `INSERT INTO ${full(generatedName)} (${q('generated_id')},${q('quantity')}) VALUES (1,2)` : `INSERT INTO ${full(generatedName)} (${q('quantity')}) VALUES (2)`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('generated_id')},${q('quantity')},${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['1','2','3']])
    const gridResult = await driver.editGrid({ action: 'open', sessionId: session.id, table: { ...location, name: generatedName } })
    expect(gridResult.error).toBeUndefined(); expect(gridResult.grid).toBeDefined()
    const grid = gridResult.grid!, generatedIndex = grid.columns.findIndex(c => c.name === 'calculated')
    expect(grid.columns[generatedIndex]?.generated).toBe(true)
    const forbidden = await driver.editGrid({ action: 'apply', sessionId: session.id, snapshotId: grid.id, changes: [{ kind: 'update', row: 0, values: [{ column: generatedIndex, value: '99' }] }] })
    expect(forbidden.error).toMatch(/Generated columns/)
    const extra = computed('calculated_later', 2), generatedTarget = await object(generatedName)
    if (engine === 'duckdb') await expect(prepare({ action: 'add-column', target: generatedTarget, column: extra })).rejects.toThrow(/cannot add/)
    else {
      await change({ action: 'add-column', target: generatedTarget, column: extra })
      expect((await run(`SELECT ${q('calculated_later')} FROM ${full(generatedName)}`)).rows).toEqual([['4']])
    }
    await run(`UPDATE ${full(generatedName)} SET ${q('quantity')}=5`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['6']])
    await change({ action: 'drop-table', target: await object(generatedName) })
    if (['postgres','mysql','sqlserver','azure-sql','oracle'].includes(engine)) {
      const generatedKey = { ...computed('calculated_key', 1), nullable: false, primaryKey: true }
      await change({ action: 'create-table', location, name: generatedKeyName, columns: [column('quantity', false), generatedKey] })
      await run(`INSERT INTO ${full(generatedKeyName)} (${q('quantity')}) VALUES (1)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('calculated_key')} FROM ${full(generatedKeyName)}`)).rows).toEqual([['2']])
      await change({ action: 'drop-table', target: await object(generatedKeyName) })
    }
    if (['postgres','mysql','mariadb','sqlserver','azure-sql','oracle'].includes(engine)) {
      await change({ action: 'create-table', location, name: identityAddName, columns: [column('quantity')] })
      await run(`INSERT INTO ${full(identityAddName)} (${q('quantity')}) VALUES (5)`)
      if (engine === 'oracle') await run('COMMIT')
      const identityColumn = { ...column('generated_id', false), generation: { kind: 'identity' as const, mode: ['postgres','oracle'].includes(engine) ? 'by-default' as const : 'auto' as const, ...(['mysql','mariadb'].includes(engine) ? { unique: true } : {}) } }
      await change({ action: 'add-column', target: await object(identityAddName), column: identityColumn })
      await run(`INSERT INTO ${full(identityAddName)} (${q('quantity')}) VALUES (6)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('quantity')},${q('generated_id')} FROM ${full(identityAddName)} ORDER BY ${q('quantity')}`)).rows).toEqual([['5','1'],['6','2']])
      await change({ action: 'drop-table', target: await object(identityAddName) })
    }
    if (['postgres','oracle'].includes(engine)) {
      const always = { ...column('generated_id', false), primaryKey: true, generation: { kind: 'identity' as const, mode: 'always' as const } }
      await change({ action: 'create-table', location, name: alwaysName, columns: [always, column('quantity')] })
      await run(`INSERT INTO ${full(alwaysName)} (${q('quantity')}) VALUES (7)`)
      if (engine === 'oracle') await run('COMMIT')
      const rejectedId = driver.start({ sessionId: session.id, sql: `INSERT INTO ${full(alwaysName)} (${q('generated_id')},${q('quantity')}) VALUES (42,8)`, maxRows: 100 })
      await driver.wait(session.id)
      expect(events.find(e => e.type === 'complete' && e.queryId === rejectedId)).toMatchObject({ status: 'failed' })
      if (engine === 'oracle') await run('ROLLBACK')
      expect((await run(`SELECT ${q('generated_id')},${q('quantity')} FROM ${full(alwaysName)}`)).rows).toEqual([['1','7']])
      await change({ action: 'drop-table', target: await object(alwaysName) })
    }
    await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (1)`); await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (2)`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('label')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([["quote'\\;-- 世界"]])
    expect((await run(`SELECT ${q('expression_default')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([['3']])
    const expressionColumn = { ...column('added_expression'), default: { kind: 'expression' as const, value: '4 + 5' } }
    if (engine === 'sqlite') await expect(prepare({ action: 'add-column', target: await object(name), column: expressionColumn })).rejects.toThrow(/SQLite cannot add/)
    else {
      await change({ action: 'add-column', target: await object(name), column: expressionColumn })
      const mssql = ['sqlserver','azure-sql'].includes(engine)
      expect((await run(`SELECT ${q('added_expression')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([[mssql ? null : '9']])
      await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (3)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('added_expression')} FROM ${full(name)} WHERE ${q('id')}=3`)).rows).toEqual([['9']])
    }
    await change({ action: 'add-column', target: await object(name), column: { ...column('score',false), default: { kind: 'number', value: '7' } } })
    expect((await run(`SELECT ${q('score')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([['7']])
    await change({ action: 'rename-column', target: await object(name), column: 'score', name: 'points odd' })
    expect((await run(`SELECT ${q('points odd')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([['7']])
    await change({ action: 'create-index', target: await object(name), name: prefix+'_index', columns: ['label'], unique: false })
    const dropIndex = await prepare({ action: 'drop-index', target: await object(prefix+'_index','index') })
    await expect(apply(dropIndex, { destructiveApproved: false })).rejects.toThrow(/destructive/)
    expect((await apply(dropIndex)).status).toBe('completed'); if (transactional) await run('COMMIT')
    const duplicate = await apply(await prepare({ action: 'create-index', target: await object(name), name: prefix+'_unique', columns: ['label'], unique: true }))
    // SQL Server ends this transaction on the duplicate-index error. Preserve
    // the conservative outcome: an idle transaction is not proof that our
    // rollback ran (DDL triggers can also end transactions). Verify the actual
    // catalog below instead of claiming a confirmed rollback or replaying DDL.
    const endedByServer = ['sqlserver','azure-sql'].includes(engine)
    expect(duplicate.status, duplicate.message).toBe(endedByServer ? 'unknown' : 'failed')
    expect(duplicate.session.transaction).toBe('idle')
    if (endedByServer) { expect(duplicate.message).toContain('nothing will be replayed'); expect(duplicate.executedSql).not.toContain('ROLLBACK') }
    expect((await driver.schema(session.id)).catalog?.objects.some(o => o.name === prefix+'_unique')).toBe(false)
    const stale = await prepare({ action: 'add-column', target: await object(name), column: column('not_applied') })
    await run(`ALTER TABLE ${full(name)} ADD ${q('external_change')} INTEGER`, other.id)
    const rejected = await apply(stale)
    expect(rejected.status).toBe('failed'); expect(rejected.message).toMatch(/changed after review/); expect(rejected.executedSql).toBe('')
    await expect(apply(stale)).rejects.toThrow(/expired/)
    const guardedChange: SchemaChange = { action: 'add-column', target: await object(name), column: column('guarded') }, guarded = await prepare(guardedChange)
    await run(engine === 'oracle' ? 'SAVEPOINT DDL_GUARD' : ['sqlserver','azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    await expect(prepare(guardedChange)).rejects.toThrow(/Commit or roll back/)
    await expect(apply(guarded)).rejects.toThrow(/Commit or roll back/)
    await run('ROLLBACK')
    if (['mysql','mariadb'].includes(engine)) {
      await run('SET autocommit=0'); await expect(prepare(guardedChange)).rejects.toThrow(/enable autocommit/); await run('SET autocommit=1')
    }
    if (engine === 'postgres') {
      const cancelledPlan = await prepare({ action: 'add-column', target: await object(name), column: column('cancelled_change') })
      await run(`BEGIN; LOCK TABLE ${full(name)} IN SHARE MODE`, other.id)
      const pending = apply(cancelledPlan)
      try {
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(driver.cancelSchemaChange(session.id).requested).toBe(true)
        const cancelled = await pending
        expect(cancelled.status, cancelled.message).toBe('cancelled'); expect(cancelled.session.transaction).toBe('idle'); expect(cancelled.executedSql).toContain('ALTER TABLE')
      } finally { await run('ROLLBACK', other.id) }
      const restricted = await driver.connect({ ...config, user: 'browser_user', password: 'local-test-only' })
      const denied = await driver.prepareSchemaChange({ sessionId: restricted.id, change: { ...create, name: prefix+'_denied' } })
      const failed = await driver.applySchemaChange({ sessionId: restricted.id, planId: denied.id, confirmed: true, implicitCommitApproved: false, destructiveApproved: false })
      expect(failed.status, failed.message).toBe('failed'); expect(failed.session.transaction).toBe('idle')
      await driver.disconnect(restricted.id)
    }
    await change({ action: 'drop-column', target: await object(name), column: 'points odd' })
    await change({ action: 'rename-table', target: await object(name), name: renamed })
    const remove = await prepare({ action: 'drop-table', target: await object(renamed) })
    await expect(apply(remove, { destructiveApproved: false })).rejects.toThrow(/destructive/)
    expect((await apply(remove)).status).toBe('completed'); if (transactional) await run('COMMIT')
    expect((await driver.schema(session.id)).catalog?.objects.some(o => o.name === renamed)).toBe(false)
    if (supportsCreateSchema(engine)) {
      const ns = { ...location, schema: prefix+'_ns' }
      await change({ action: 'create-schema', location: ns })
      await change({ ...create, location: ns, name: prefix+'_nested' })
      await change({ action: 'drop-table', target: await object(prefix+'_nested') })
      await run(`DROP SCHEMA ${ns.catalog ? q(ns.catalog)+'.' : ''}${q(ns.schema)}`)
    } else await expect(prepare({ action: 'create-schema', location: { ...location, schema: schema } })).rejects.toThrow(/Namespace creation/)
    expect(driver.getSession(other.id).transaction).toBe('idle')
  } finally {
    try { await run('ROLLBACK') } catch {}
    for (const table of [name,renamed,generatedName,identityAddName,alwaysName,generatedKeyName]) { try { await run(`DROP TABLE ${full(table)}`) } catch {} }
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}
