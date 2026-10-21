import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { writeMigrationFile } from '../../src/main/migration-file'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { schemaColumnSchema, transactionalDdl, type SchemaChangePlan } from '../../src/shared/schema-changes'

export async function verifyMigrations(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(),'dbcommander-migrations-')), events: DatabaseEvent[] = [], engine = config.engine
  const embedded = ['sqlite','duckdb'].includes(engine), transactional = transactionalDdl(engine)
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const local = { ...config, ...(embedded ? { filePath: join(directory,'migrations.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const session = await driver.connect(local), name = 'mig_'+randomUUID().slice(0,8)+" odd';--", q = (value: string) => quoteIdentifier(value,engine)
  const schema = engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? session.user.toUpperCase() : embedded ? 'main' : session.database
  const location = { schema, ...(engine === 'duckdb' ? { catalog: session.database } : {}) }, full = [location.catalog,schema,name].filter((s): s is string => !!s).map(q).join('.')
  async function run(sql: string) {
    const id = driver.start({ sessionId: session.id, sql, maxRows: 100 }); await driver.wait(session.id)
    const result = events.find(e => e.type === 'complete' && e.queryId === id) as Extract<DatabaseEvent,{type:'complete'}>
    expect(result?.status, result?.error).toBe('completed'); return id
  }
  const object = async () => (await driver.schema(session.id)).catalog!.objects.find(o => o.name === name && o.kind === 'table')!
  const preview = (plan: SchemaChangePlan, transaction: 'caller'|'transaction' = 'caller', includeDestructive = false) => driver.prepareMigration({ sourceId: plan.migrationSourceId!, name: 'reviewed_schema_change', selected: ['change'], transaction, includeDestructive })
  try {
    const cached = await run(engine === 'oracle' ? 'SELECT 42 FROM dual' : 'SELECT 42'), count = events.length
    const plan = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'create-table', location, name, columns: [schemaColumnSchema.parse({ name: 'id', type: 'integer', nullable: false, primaryKey: true }), schemaColumnSchema.parse({ name: 'label', type: 'varchar', nullable: true, default: { kind: 'text', value: "quote';-- 世界" } })] } })
    const migration = preview(plan, transactional ? 'transaction' : 'caller'), path = join(directory,migration.filename)
    expect(migration.sql).toContain(full); if (config.password) expect(migration.sql).not.toContain(config.password)
    plan.sql = 'DROP DATABASE x;'
    expect(driver.reviewedMigration({ id: migration.id, reviewed: true, destructiveApproved: false }).sql).toBe(migration.sql)
    await writeMigrationFile(path,migration.sql)
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(migration.sha256)
    expect(await object()).toBeUndefined(); expect(driver.getSession(session.id).transaction).toBe('idle'); expect(events).toHaveLength(count)
    await driver.exportCsv(cached,0,join(directory,'retained.csv')); expect(readFileSync(join(directory,'retained.csv'),'utf8')).toContain('42')
    await run(readFileSync(path,'utf8')); expect(await object()).toBeDefined(); expect(driver.getSession(session.id).transaction).toBe('idle')
    await run(`INSERT INTO ${full} (${q('id')}) VALUES (1)`); if (engine === 'oracle') await run('COMMIT')
    const rowsId = await run(`SELECT ${q('label')} FROM ${full}`)
    expect(events.flatMap(e => e.type === 'rows' && e.queryId === rowsId ? e.rows : [])).toEqual([["quote';-- 世界"]])
    const add = await driver.prepareSchemaChange({ sessionId: session.id, change: { action: 'add-column', target: await object(), column: schemaColumnSchema.parse({ name: 'added', type: 'integer', nullable: true }) } })
    const addition = preview(add); expect(addition.sql).not.toMatch(/^BEGIN|^COMMIT/m)
    await run(addition.sql); expect((await driver.schema(session.id)).objects.find(o => o.name === name)?.columns.some(c => c.name === 'added')).toBe(true)
    const protectedSession = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write', environment: 'production' })
    const protectedPlan = await driver.prepareSchemaChange({ sessionId: protectedSession.id, change: { action: 'drop-table', target: await object() } })
    expect(driver.sessionSafety(protectedSession.id)).toMatchObject({ protected: true, unlockedUntil: 0 })
    expect(() => preview(protectedPlan)).toThrow(/destructive/)
    const drop = preview(protectedPlan, transactional ? 'transaction' : 'caller', true)
    expect(() => driver.reviewedMigration({ id: drop.id, reviewed: true, destructiveApproved: false })).toThrow(/Acknowledge/)
    const approved = driver.reviewedMigration({ id: drop.id, reviewed: true, destructiveApproved: true })
    expect(await object()).toBeDefined(); expect(driver.sessionSafety(protectedSession.id).unlockedUntil).toBe(0)
    await driver.disconnect(protectedSession.id)
    expect(() => driver.reviewedMigration({ id: drop.id, reviewed: true, destructiveApproved: true })).toThrow(/closed/)
    await run(approved.sql); expect(await object()).toBeUndefined()
  } finally {
    try { if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK'); if (await object()) await run(`DROP TABLE ${full}`) } catch {}
    await driver.close(); rmSync(directory,{recursive:true,force:true})
  }
}
