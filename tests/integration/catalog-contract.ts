import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { CatalogObject } from '../../src/shared/catalog'

export async function verifyCatalog(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const engine = config.engine, local = engine === 'sqlite' ? { ...config, sqliteMode: 'memory' as const } : engine === 'duckdb' ? { ...config, duckdbMode: 'memory' as const } : config
  const session = await driver.connect(local), prefix = `cat_${randomUUID().replaceAll('-','').slice(0,8)}`, table = prefix+" odd'", view = prefix+'_view', index = prefix+'_idx', routine = prefix+'_fn', trigger = prefix+'_tr', seq = prefix+'_seq'
  const q = (value: string) => quoteIdentifier(value, engine), drops: string[] = []
  let oracleOther: string | undefined
  async function run(sql: string, target = session.id) {
    const id = driver.start({ sessionId: target, sql, maxRows: 100 }); await driver.wait(target)
    const complete = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete, `${sql}: ${complete?.error}`).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === id ? event.rows : [])
  }
  const detail = (object: CatalogObject) => driver.inspectObject({ sessionId: session.id, object })
  try {
    await run(`CREATE TABLE ${q(table)} (${q('id')} INTEGER NOT NULL,${q('Display Name')} VARCHAR(60) DEFAULT 'catalog default',${q('parent_id')} INTEGER,CONSTRAINT ${q(prefix+'_pk')} PRIMARY KEY (${q('id')}),CONSTRAINT ${q(prefix+'_check')} CHECK (${q('id')} >= 0),CONSTRAINT ${q(prefix+'_fk')} FOREIGN KEY (${q('parent_id')}) REFERENCES ${q(table)} (${q('id')}))`)
    drops.unshift(`DROP TABLE ${q(table)}`)
    await run(`CREATE INDEX ${q(index)} ON ${q(table)} (${q('Display Name')})`)
    await run(`CREATE VIEW ${q(view)} AS SELECT ${q('id')},${q('Display Name')} FROM ${q(table)}`); drops.unshift(`DROP VIEW ${q(view)}`)
    if (engine === 'postgres') {
      await run(`CREATE FUNCTION ${q(routine)}(integer) RETURNS integer LANGUAGE SQL AS 'SELECT $1 + 1'`); drops.unshift(`DROP FUNCTION ${q(routine)}(integer)`)
      await run(`CREATE FUNCTION ${q(routine)}(text) RETURNS text LANGUAGE SQL AS 'SELECT $1'`); drops.unshift(`DROP FUNCTION ${q(routine)}(text)`)
      await run(`CREATE FUNCTION ${q(prefix+'_tf')}() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'`); drops.unshift(`DROP FUNCTION ${q(prefix+'_tf')}() CASCADE`)
      await run(`CREATE TRIGGER ${q(trigger)} BEFORE INSERT ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION ${q(prefix+'_tf')}()`)
    } else if (['mysql','mariadb'].includes(engine)) {
      await run(`CREATE FUNCTION ${q(routine)}(value_arg INT) RETURNS INT DETERMINISTIC RETURN value_arg+1`); drops.unshift(`DROP FUNCTION ${q(routine)}`)
      await run(`CREATE TRIGGER ${q(trigger)} BEFORE INSERT ON ${q(table)} FOR EACH ROW SET NEW.${q('parent_id')} = NULL`)
    } else if (engine === 'oracle') {
      await run(`CREATE FUNCTION ${q(routine)}(value_arg NUMBER) RETURN NUMBER IS BEGIN RETURN value_arg+1; END;\n/`); drops.unshift(`DROP FUNCTION ${q(routine)}`)
      await run(`CREATE TRIGGER ${q(trigger)} BEFORE INSERT ON ${q(table)} FOR EACH ROW BEGIN NULL; END;\n/`)
      await run(`CREATE PACKAGE ${q(prefix+'_pkg')} AS FUNCTION value_arg RETURN NUMBER; END;\n/`); drops.unshift(`DROP PACKAGE ${q(prefix+'_pkg')}`)
      await run(`CREATE PACKAGE BODY ${q(prefix+'_pkg')} AS FUNCTION value_arg RETURN NUMBER IS BEGIN RETURN 1; END; END;\n/`)
      await run(`CREATE TYPE ${q(prefix+'_type')} AS OBJECT (value_arg NUMBER);\n/`); drops.unshift(`DROP TYPE ${q(prefix+'_type')}`)
    } else if (['sqlserver','azure-sql'].includes(engine)) {
      await run(`CREATE FUNCTION dbo.${q(routine)}(@value_arg INT) RETURNS INT AS BEGIN RETURN @value_arg+1; END`); drops.unshift(`DROP FUNCTION dbo.${q(routine)}`)
      await run(`CREATE TRIGGER ${q(trigger)} ON ${q(table)} AFTER INSERT AS BEGIN SET NOCOUNT ON; END`)
    } else if (engine === 'sqlite') await run(`CREATE TRIGGER ${q(trigger)} AFTER INSERT ON ${q(table)} BEGIN SELECT 1; END`)
    else { await run(`CREATE MACRO ${q(routine)}(value_arg) AS value_arg+1`); drops.unshift(`DROP MACRO ${q(routine)}`) }
    if (!['mysql','sqlite'].includes(engine)) { await run(`CREATE SEQUENCE ${q(seq)} START WITH 7 INCREMENT BY 3`); drops.unshift(`DROP SEQUENCE ${q(seq)}`) }
    if (['sqlserver','azure-sql'].includes(engine)) {
      await run(`CREATE FUNCTION dbo.${q(prefix+'_encrypted')}(@v INT) RETURNS INT WITH ENCRYPTION AS BEGIN RETURN @v; END`)
      drops.unshift(`DROP FUNCTION dbo.${q(prefix+'_encrypted')}`)
    }
    if (['postgres','oracle'].includes(engine)) {
      await run(`CREATE MATERIALIZED VIEW ${q(prefix+'_mv')}${engine === 'oracle' ? ` (${q('Key alias')}) BUILD DEFERRED REFRESH COMPLETE ON DEMAND DISABLE QUERY REWRITE` : ''} AS SELECT ${q('id')} FROM ${q(table)}`)
      drops.unshift(`DROP MATERIALIZED VIEW ${q(prefix+'_mv')}`)
    }
    const before = events.length, snapshot = await driver.schema(session.id), objects = snapshot.catalog!.objects
    expect(snapshot.catalog?.notice).not.toContain('unavailable')
    const object = objects.find(object => object.name === table && object.kind === 'table')!
    expect(object).toBeDefined(); expect(events).toHaveLength(before)
    if (engine === 'oracle') {
      expect(objects.every(o => o.schema === config.user.toUpperCase())).toBe(true)
      await expect(detail({ ...object, schema: 'DBCOMMANDER_COMPARE' })).rejects.toThrow(/no longer visible/)
    }
    if (['postgres','oracle'].includes(engine)) {
      const materialized = objects.filter(o => o.name === prefix+'_mv')
      expect(materialized).toHaveLength(1); expect(materialized[0].kind).toBe('materialized view')
      const materializedDetail = await detail(materialized[0])
      expect(materializedDetail.definition.sql, materializedDetail.definition.notice).toContain('MATERIALIZED VIEW')
      if (engine === 'oracle') {
        expect(materializedDetail.definition.source).toBe('generated')
        expect(materializedDetail.definition.notice).toContain('not full native DDL')
        expect(materializedDetail.sections.find(s => s.title === 'Materialized view')?.rows).toEqual([['DEFERRED','COMPLETE','DEMAND','N']])
        expect(materializedDetail.definition.sql).toContain(q('Key alias'))
        const clone = prefix+'_mv_copy', owner = q(config.user.toUpperCase())
        await run(materializedDetail.definition.sql!.replace(`${owner}.${q(prefix+'_mv')}`, `${owner}.${q(clone)}`))
        drops.unshift(`DROP MATERIALIZED VIEW ${q(clone)}`)
        const copied = (await driver.schema(session.id)).catalog!.objects.find(o => o.name === clone)!
        expect((await detail(copied)).sections.find(s => s.title === 'Materialized view')?.rows).toEqual([['DEFERRED','COMPLETE','DEMAND','N']])
        await run(`SELECT ${q('Key alias')} FROM ${q(clone)}`)
      }
    }
    const tableDetail = await detail(object)
    expect(tableDetail.definition.sql).toContain('CREATE TABLE'); expect(tableDetail.definition.sql).toContain("odd'")
    expect(tableDetail.sections.find(s => s.title === 'Columns')?.rows.some(row => row.includes('Display Name'))).toBe(true)
    expect(JSON.stringify(tableDetail.sections)).toContain(engine === 'sqlite' ? 'parent_id' : engine === 'duckdb' ? 'FOREIGN KEY' : prefix+'_fk')
    expect(tableDetail.sections.find(s => s.title === 'Indexes')?.rows.some(row => row.includes(index))).toBe(true)
    if (engine === 'oracle') {
      for (const kind of ['package','type'] as const) {
        const specification = objects.find(o => o.name === prefix+(kind === 'package' ? '_pkg' : '_type') && o.kind === kind)!
        expect(specification).toBeDefined()
        const result = await detail(specification)
        expect(result.definition.sql, result.definition.notice).toMatch(/value_arg/i)
        expect(result.definition.sql).not.toContain('PACKAGE BODY')
      }
    }
    if (['sqlserver','azure-sql'].includes(engine)) {
      const encrypted = objects.find(o => o.name === prefix+'_encrypted')!
      expect((await detail(encrypted)).definition).toMatchObject({ source: 'unavailable', sql: null })
    }
    const v = objects.find(object => object.name === view && object.kind === 'view')!
    expect((await detail(v)).definition.sql?.toUpperCase()).toContain('SELECT')
    const idx = objects.find(object => object.name === index && object.kind === 'index')!
    expect(idx).toMatchObject({ parent: table, schema: object.schema }); expect(idx.catalog).toBe(object.catalog); expect((await detail(idx)).definition.sql).toBeTruthy()
    const foreignKeys = objects.filter(o => o.kind === 'constraint' && o.parent === table && o.constraintType === 'foreign key')
    expect(foreignKeys).toHaveLength(1)
    const foreignKeyDetail = await detail(foreignKeys[0])
    expect(foreignKeyDetail.definition.sql, foreignKeyDetail.definition.notice).toMatch(/REFERENCES/i)
    if (engine === 'sqlite') {
      expect(foreignKeyDetail.sections.find(s => s.title === 'Foreign keys')?.rows).toEqual([['0','0',table,'parent_id','id','NO ACTION','NO ACTION','NONE']])
      await expect(detail({ ...foreignKeys[0], parent: view })).rejects.toThrow(/no longer visible/)
    } else {
      expect(objects.some(o => o.parent === table && o.constraintType === 'primary key')).toBe(true)
      expect(objects.some(o => o.parent === table && o.constraintType === 'check')).toBe(true)
    }
    if (engine !== 'sqlite') {
      const routines = objects.filter(object => object.name === routine)
      expect(routines).toHaveLength(engine === 'postgres' ? 2 : 1)
      if (engine === 'postgres') expect(new Set(routines.map(o => o.signature)).size).toBe(2)
      for (const routine of routines) expect((await detail(routine)).definition.sql).toContain(engine === 'postgres' ? '$1' : 'value_arg')
      const constraint = objects.find(o => o.name === prefix+'_pk' || o.kind === 'constraint' && o.parent === table)!
      expect(constraint).toBeDefined(); expect((await detail(constraint)).sections.length + Number(Boolean((await detail(constraint)).definition.sql))).toBeGreaterThan(0)
    }
    if (engine !== 'duckdb') { const tr = objects.find(o => o.name === trigger && o.kind === 'trigger')!; expect(tr).toMatchObject({ parent: table }); expect((await detail(tr)).definition.sql).toBeTruthy() }
    if (!['mysql','sqlite'].includes(engine)) { const sequence = objects.find(o => o.name === seq && o.kind === 'sequence')!; expect(sequence).toBeDefined(); expect((await detail(sequence)).definition.sql).toBeTruthy() }
    if (engine === 'oracle') {
      oracleOther = (await driver.connect({ ...config, user: 'dbcommander_compare' })).id
      await run(`CREATE TABLE ${q(table)} (${q('id')} INTEGER PRIMARY KEY)`, oracleOther)
      await run(`GRANT SELECT, REFERENCES ON ${q(table)} TO ${q(config.user.toUpperCase())}`, oracleOther)
      await run(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(prefix+'_other_fk')} FOREIGN KEY (${q('id')}) REFERENCES ${q('DBCOMMANDER_COMPARE')}.${q(table)} (${q('id')})`)
      const scoped = await driver.schema(session.id)
      expect(scoped.catalog?.notice).not.toContain('unavailable')
      expect(scoped.catalog?.objects.every(o => o.schema === config.user.toUpperCase())).toBe(true)
      const crossOwner = await detail(object)
      expect(crossOwner.definition.sql, crossOwner.definition.notice).toContain('CREATE TABLE')
      expect(crossOwner.sections.find(s => s.title === 'Foreign keys')?.rows).toContainEqual([prefix+'_other_fk', 'id', 'DBCOMMANDER_COMPARE', table, 'id', 'NO ACTION'])
    }
    if (engine === 'postgres') {
      const restricted = await driver.connect({ ...config, user: 'browser_user', password: 'local-test-only' })
      expect((await driver.schema(restricted.id)).catalog?.objects.some(o => o.name === table)).toBe(false)
      await expect(driver.inspectObject({ sessionId: restricted.id, object })).rejects.toThrow(/no longer visible/)
      await driver.disconnect(restricted.id)
    }
    await expect(detail({ ...object, name: "missing'; DROP TABLE x;--" })).rejects.toThrow(/no longer visible/)
    await run(engine === 'oracle' ? 'SAVEPOINT CATALOG_CHECK' : ['sqlserver','azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    const transaction = driver.getSession(session.id).transaction
    await detail(object); expect(driver.getSession(session.id).transaction).toBe(transaction)
    await run('ROLLBACK')
    if (['sqlite','duckdb'].includes(engine)) {
      await run(`CREATE TEMP TABLE ${q(prefix+'_temp')} (id INT)`)
      const a = await driver.schema(session.id), b = await driver.connect(local)
      expect(a.catalog?.objects.some(o => o.name === prefix+'_temp')).toBe(true)
      expect((await driver.schema(b.id)).catalog?.objects.some(o => o.name === prefix+'_temp')).toBe(false)
      await detail(a.catalog!.objects.find(o => o.name === prefix+'_temp')!); await driver.disconnect(b.id)
    }
    if (engine === 'sqlite') {
      // The same names/rowids in attached schemas must resolve independently;
      // a composite foreign key appears once, with both ordered column pairs.
      const attached = 'catalog copy'
      await run(`ATTACH DATABASE ':memory:' AS ${q(attached)}`)
      await run(`CREATE TABLE ${q(attached)}.${q(table)} (id INTEGER,part INTEGER,parent_id INTEGER,parent_part INTEGER,PRIMARY KEY(id,part),FOREIGN KEY(parent_id,parent_part) REFERENCES ${q(table)}(id,part))`)
      const attachedKeys = (await driver.schema(session.id)).catalog!.objects.filter(o => o.schema === attached && o.parent === table && o.constraintType === 'foreign key')
      expect(attachedKeys).toHaveLength(1)
      const attachedDetail = await detail(attachedKeys[0])
      expect(attachedDetail.sections.find(s => s.title === 'Foreign keys')?.rows.map(row => row.slice(0,5))).toEqual([['0','0',table,'parent_id','id'],['0','1',table,'parent_part','part']])
      expect(attachedDetail.definition.sql).toContain('parent_part')
      expect((await detail(foreignKeys[0])).definition.sql).not.toContain('parent_part')
      await run(`DETACH DATABASE ${q(attached)}`)
      await expect(detail(attachedKeys[0])).rejects.toThrow(/no longer visible/)
    }
    await run(`DROP VIEW ${q(view)}`); drops.splice(drops.indexOf(`DROP VIEW ${q(view)}`),1)
    await expect(detail(v)).rejects.toThrow(/no longer visible/)
    expect((await driver.schema(session.id)).catalog?.objects.some(o => o.name === view)).toBe(false)
  } finally {
    for (const sql of drops) { try { await run(sql) } catch {} }
    if (oracleOther) { try { await run(`DROP TABLE ${q(table)}`, oracleOther) } catch {} }
    await driver.close()
  }
}
