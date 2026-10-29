import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { schemaColumnSchema, transactionalDdl, supportsCreateSchema, type SchemaChange, type SchemaChangePlan } from '../../src/shared/schema-changes'
import { nativeTypes } from '../../src/shared/schema-native-types'

export async function verifySchemaChanges(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-ddl-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const engine = config.engine, embedded = ['sqlite','duckdb'].includes(engine), transactional = transactionalDdl(engine)
  const local = embedded ? { ...config, filePath: join(directory,'schema.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : config
  const session = await driver.connect(local), prefix = `ddl_${randomUUID().replaceAll('-','').slice(0,8)}`, name = prefix+" odd'", renamed = prefix+'_renamed', generatedName = prefix+'_generated', identityAddName = prefix+'_identity_added', alwaysName = prefix+'_identity_always', generatedKeyName = prefix+'_generated_key', methodTable = prefix+'_method_types', nativeTable = prefix+'_native', namedType = prefix+'_enum', constrainedTable = prefix+'_constraints', cascadeTable = prefix+'_cascade', compositeParent = prefix+'_composite_parent', compositeChild = prefix+'_composite_child', alterTable = prefix+'_alter', conversionTable = prefix+'_conversion'
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
    const nativeName = engine === 'postgres' || engine === 'duckdb' ? 'UUID' : engine === 'mysql' || engine === 'mariadb' ? 'VARBINARY' : engine === 'sqlite' ? 'BLOB' : engine === 'oracle' ? 'RAW' : 'UNIQUEIDENTIFIER'
    const payload = schemaColumnSchema.parse({ name: 'native_payload', type: 'text', nullable: true, nativeType: { kind: 'builtin', name: nativeName, ...(['mysql','mariadb','oracle'].includes(engine) ? { length: 16 } : {}) } })
    const amount = schemaColumnSchema.parse({ name: 'native_amount', type: 'decimal', nullable: true, nativeType: engine === 'sqlite' ? { kind: 'builtin', name: 'NUMERIC' } : { kind: 'builtin', name: engine === 'postgres' ? 'NUMERIC' : engine === 'oracle' ? 'NUMBER' : 'DECIMAL', precision: 12, scale: 2 } })
    const clockName = engine === 'postgres' || engine === 'oracle' ? 'TIMESTAMP WITH TIME ZONE' : engine === 'mysql' || engine === 'mariadb' ? 'DATETIME' : engine === 'sqlite' ? 'TEXT' : engine === 'duckdb' ? 'TIMESTAMPTZ' : 'DATETIMEOFFSET'
    const clock = schemaColumnSchema.parse({ name: 'native_clock', type: 'timestamp', nullable: true, nativeType: { kind: 'builtin', name: clockName, ...(['postgres','oracle','mysql','mariadb','sqlserver','azure-sql'].includes(engine) ? { fractional: 3 } : {}) } })
    const nativeIdentityName = engine === 'oracle' ? 'NUMBER' : engine === 'mysql' || engine === 'mariadb' ? 'BIGINT' : engine === 'sqlserver' || engine === 'azure-sql' ? 'INT' : engine === 'postgres' ? 'BIGINT' : 'INTEGER'
    const nativeId = schemaColumnSchema.parse({ name: 'native_id', type: 'integer', nullable: false, primaryKey: true, nativeType: { kind: 'builtin', name: nativeIdentityName, ...(engine === 'oracle' ? { precision: 18, scale: 0 } : {}) }, ...(engine === 'duckdb' ? {} : { generation: { kind: 'identity', mode: ['postgres','oracle'].includes(engine) ? 'by-default' : 'auto' } }) })
    const array = ['postgres','duckdb'].includes(engine) ? [schemaColumnSchema.parse({ name: 'native_array', type: 'integer', nullable: true, nativeType: { kind: 'builtin', name: 'INTEGER', array: true } })] : []
    await change({ action: 'create-table', location, name: nativeTable, columns: [nativeId, payload, amount, clock, ...array] })
    const value = engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite' ? "X'00112233445566778899AABBCCDDEEFF'" : engine === 'oracle' ? "HEXTORAW('00112233445566778899AABBCCDDEEFF')" : "'00112233-4455-6677-8899-aabbccddeeff'"
    const insertColumns = [...(engine === 'duckdb' ? ['native_id'] : []), 'native_payload', 'native_amount', 'native_clock', ...(array.length ? ['native_array'] : [])]
    const values = [...(engine === 'duckdb' ? ['1'] : []), value, '12.34', 'CURRENT_TIMESTAMP', ...(array.length ? ['ARRAY[1,2]'] : [])]
    await run(`INSERT INTO ${full(nativeTable)} (${insertColumns.map(q).join(',')}) VALUES (${values.join(',')})`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('native_id')} FROM ${full(nativeTable)} WHERE ${q('native_payload')} IS NOT NULL AND ${q('native_amount')}=12.34 AND ${q('native_clock')} IS NOT NULL`)).rows).toEqual([['1']])
    await change({ action: 'drop-table', target: await object(nativeTable) })
    const allNative = nativeTypes[engine].map((option, i) => schemaColumnSchema.parse({ name: `native_${i}`, type: 'text', nullable: true, nativeType: { kind: 'builtin', name: option.name, ...(option.modifier === 'length' ? { length: 16 } : option.modifier === 'numeric' ? { precision: 10, scale: 2 } : option.modifier === 'temporal' ? { fractional: 3 } : {}) } }))
    if (['postgres','oracle'].includes(engine)) {
      const name = engine === 'oracle' ? 'NUMBER' : 'NUMERIC'
      allNative.push(schemaColumnSchema.parse({ name: 'small_fraction', type: 'decimal', nullable: true, nativeType: { kind: 'builtin', name, precision: 3, scale: 5 } }))
      allNative.push(schemaColumnSchema.parse({ name: 'rounded_hundreds', type: 'decimal', nullable: true, nativeType: { kind: 'builtin', name, precision: 3, scale: -2 } }))
    }
    await change({ action: 'create-table', location, name: nativeTable, columns: allNative })
    await run(`SELECT ${allNative.map(value => q(value.name)).join(',')} FROM ${full(nativeTable)}`)
    if (['postgres','oracle'].includes(engine)) {
      await run(`INSERT INTO ${full(nativeTable)} (${q('small_fraction')},${q('rounded_hundreds')}) VALUES (0.00123,140)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('rounded_hundreds')} FROM ${full(nativeTable)} WHERE ${q('small_fraction')}=0.00123`)).rows).toEqual([['100']])
    }
    await change({ action: 'drop-table', target: await object(nativeTable) })
    if (['postgres','duckdb'].includes(engine)) {
      await run(`CREATE TYPE ${full(namedType)} AS ENUM ('first', 'second')`)
      const named = schemaColumnSchema.parse({ name: 'state', type: 'text', nullable: true, nativeType: { kind: 'named', schema, name: namedType, ...(engine === 'duckdb' ? { catalog: session.database } : {}) } })
      const namedArray = schemaColumnSchema.parse({ ...named, name: 'state_history', nativeType: { ...named.nativeType, array: true } })
      await change({ action: 'create-table', location, name: nativeTable, columns: [column('id'), named, namedArray] })
      await run(`INSERT INTO ${full(nativeTable)} (${q('id')},${q('state')},${q('state_history')}) VALUES (1,'first',CAST(ARRAY['first','second'] AS ${full(namedType)}[]))`)
      expect((await run(`SELECT ${q('state')},array_length(${q('state_history')},1) FROM ${full(nativeTable)}`)).rows).toEqual([['first','2']])
      await change({ action: 'drop-table', target: await object(nativeTable) })
      await run(`DROP TYPE ${full(namedType)}`)
    }
    if (['sqlserver','azure-sql','oracle'].includes(engine)) {
      await run(engine === 'oracle' ? `CREATE TYPE ${full(namedType)} AS OBJECT (value NUMBER)` : `CREATE TYPE ${full(namedType)} FROM INT NULL`)
      const named = schemaColumnSchema.parse({ name: 'typed_value', type: 'text', nullable: true, nativeType: { kind: 'named', schema, name: namedType } })
      await change({ action: 'create-table', location, name: nativeTable, columns: [column('id'), named] })
      if (engine !== 'oracle') {
        await run(`INSERT INTO ${full(nativeTable)} (${q('id')},${q('typed_value')}) VALUES (1,42)`)
        expect((await run(`SELECT ${q('typed_value')} FROM ${full(nativeTable)}`)).rows).toEqual([['42']])
      }
      await change({ action: 'drop-table', target: await object(nativeTable) })
      await run(`DROP TYPE ${full(namedType)}`)
    }
    const alterValue = schemaColumnSchema.parse({ name: 'value', type: 'varchar', length: 20, nullable: true, default: { kind: 'text', value: 'alpha' } })
    await change({ action: 'create-table', location, name: alterTable, columns: [{ ...column('id', false), primaryKey: true }, alterValue] })
    await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (1)`)
    if (engine === 'oracle') await run('COMMIT')
    const alter = async (alteration: Extract<SchemaChange,{ action: 'alter-column' }>['alteration']) => change({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration })
    if (engine === 'sqlite') {
      await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration: { kind: 'default', default: { kind: 'text', value: 'bravo' } } })).rejects.toThrow(/separate table migration/)
      const sqliteVersion = /^(\d+)\.(\d+)/.exec(session.version), supportsAlterNull = Number(sqliteVersion?.[1] ?? 0) > 3 || Number(sqliteVersion?.[1] ?? 0) === 3 && Number(sqliteVersion?.[2] ?? 0) >= 53
      const requireValue: SchemaChange = { action: 'alter-column', target: await object(alterTable), column: 'value', alteration: { kind: 'nullability', nullable: false } }
      if (supportsAlterNull) {
        await change(requireValue)
        const denied = driver.start({ sessionId: session.id, sql: `INSERT INTO ${full(alterTable)} (${q('id')},${q('value')}) VALUES (2,NULL)`, maxRows: 100 }); await driver.wait(session.id)
        expect(events.find(event => event.type === 'complete' && event.queryId === denied)).toMatchObject({ status: 'failed' })
        await alter({ kind: 'nullability', nullable: true })
        await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('value')}) VALUES (2,NULL)`)
      } else await expect(prepare(requireValue)).rejects.toThrow(/separate table migration/)
    } else {
      await alter({ kind: 'default', default: { kind: 'text', value: 'bravo' } })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (2)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['alpha'],['bravo']])
      await alter({ kind: 'default', default: { kind: 'expression', value: "upper('mixed')" } })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (4)`)
      expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} WHERE ${q('id')}=4`)).rows).toEqual([['MIXED']])
      await run(`DELETE FROM ${full(alterTable)} WHERE ${q('id')}=4`)
      if (engine === 'oracle') await run('COMMIT')
      await alter({ kind: 'default', default: { kind: 'none' } })
      if (engine === 'mysql') {
        const omitted = driver.start({ sessionId: session.id, sql: `INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (3)`, maxRows: 100 }); await driver.wait(session.id)
        expect(events.find(event => event.type === 'complete' && event.queryId === omitted)).toMatchObject({ status: 'failed' })
        await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('value')}) VALUES (3,NULL)`)
      } else await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (3)`)
      if (engine === 'oracle') await run('COMMIT')
      expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} WHERE ${q('id')}=3`)).rows).toEqual([[null]])
      await alter({ kind: 'default', default: { kind: 'text', value: 'charlie' } })
      {
        const notNull = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration: { kind: 'nullability', nullable: false } })
        const failed = await apply(notNull); expect(['failed','unknown']).toContain(failed.status)
        expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} WHERE ${q('id')}=3`)).rows).toEqual([[null]])
        await run(`UPDATE ${full(alterTable)} SET ${q('value')}='charlie' WHERE ${q('id')}=3`)
        if (engine === 'oracle') await run('COMMIT')
        await alter({ kind: 'nullability', nullable: false })
        const nullable = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration: { kind: 'nullability', nullable: true } })
        expect(nullable.destructive).toBe(true); await expect(apply(nullable, { destructiveApproved: false })).rejects.toThrow(/destructive/)
        expect((await apply(nullable)).status).toBe('completed'); if (transactional) await run('COMMIT')
        const type = { type: 'varchar' as const, length: 40, precision: 18, scale: 2 }
        const typePlan = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration: { kind: 'type', type, ...(['postgres','duckdb'].includes(engine) ? { using: `upper(${q('value')})` } : {}) } })
        expect(typePlan.destructive).toBe(true); await expect(apply(typePlan, { destructiveApproved: false })).rejects.toThrow(/destructive/)
        const converted = await apply(typePlan); expect(converted.status, converted.message).toBe('completed'); if (transactional) await run('COMMIT')
        expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} WHERE ${q('id')}=1`)).rows).toEqual([[['postgres','duckdb'].includes(engine) ? 'ALPHA' : 'alpha']])
        if (['postgres','duckdb'].includes(engine)) {
          await alter({ kind: 'default', default: { kind: 'none' } })
          await run(`UPDATE ${full(alterTable)} SET ${q('value')}=CAST(${q('id')} AS VARCHAR)`)
          const conversion: Extract<SchemaChange,{ action: 'alter-column' }>['alteration'] = { kind: 'type', type: { type: 'integer', length: 255, precision: 18, scale: 2 }, using: `CAST(${q('value')} AS INTEGER)` }
          if (engine === 'duckdb') {
            const oldRows = await apply(await prepare({ action: 'alter-column', target: await object(alterTable), column: 'value', alteration: conversion }))
            expect(['failed','completed']).toContain(oldRows.status)
            if (oldRows.status === 'failed') expect(oldRows.message).toMatch(/rolled back/); else await run('COMMIT')
            expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['1'],['2'],['3']])
            await change({ action: 'create-table', location, name: conversionTable, columns: [schemaColumnSchema.parse({ name: 'value', type: 'varchar', nullable: true })] })
            await run(`INSERT INTO ${full(conversionTable)} (${q('value')}) VALUES ('1'),('2')`)
            await change({ action: 'alter-column', target: await object(conversionTable), column: 'value', alteration: conversion })
            expect((await run(`SELECT ${q('value')} FROM ${full(conversionTable)} ORDER BY ${q('value')}`)).rows).toEqual([['1'],['2']])
            await change({ action: 'drop-table', target: await object(conversionTable) })
          } else {
            await alter(conversion)
            expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['1'],['2'],['3']])
          }
        }
      }
    }
    await change({ action: 'drop-table', target: await object(alterTable) })
    if (['mysql','mariadb'].includes(engine)) {
      const odd = 'odd`name'
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INT PRIMARY KEY, ${q(odd)} VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'alpha' COMMENT 'a,b; note', ${q('stamp')} TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ${q('generated')} INT GENERATED ALWAYS AS (${q('id')} + 1) VIRTUAL COMMENT 'generated kept', ${q('gen_text')} VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (concat('x',${q('id')})) STORED COMMENT 'text kept')`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (1)`)
      await change({ action: 'alter-column', target: await object(alterTable), column: odd, alteration: { kind: 'nullability', nullable: false } })
      await change({ action: 'alter-column', target: await object(alterTable), column: odd, alteration: { kind: 'type', type: { type: 'varchar', length: 40, precision: 18, scale: 2 } } })
      await change({ action: 'alter-column', target: await object(alterTable), column: odd, alteration: { kind: 'nullability', nullable: true } })
      await change({ action: 'alter-column', target: await object(alterTable), column: 'stamp', alteration: { kind: 'type', type: { type: 'timestamp', nativeType: { kind: 'builtin', name: 'DATETIME', fractional: 3 }, length: 255, precision: 18, scale: 2 } } })
      const ddl = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!
      expect(ddl.toLowerCase()).toContain('collate utf8mb4_bin'); expect(ddl).toContain('a,b; note'); expect(ddl.toLowerCase()).toContain('on update current_timestamp(3)')
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (2)`)
      expect((await run(`SELECT ${q(odd)} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['alpha'],['alpha']])
      await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'generated', alteration: { kind: 'default', default: { kind: 'number', value: '5' } } })).rejects.toThrow(/Generated columns/)
      const virtualPlan = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'generated', alteration: { kind: 'generated-expression', expression: `${q('id')} + 2` } })
      expect(virtualPlan.destructive).toBe(true); expect(virtualPlan.sql).toMatch(/generated kept/); expect(virtualPlan.warnings.join(' ')).toMatch(/virtual values/i)
      await expect(apply(virtualPlan, { destructiveApproved: false })).rejects.toThrow(/destructive/)
      const virtualResult = await apply(virtualPlan); expect(virtualResult.status, virtualResult.message).toBe('completed')
      expect((await run(`SELECT ${q('generated')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['3'],['4']])
      const afterGenerated = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!
      expect(afterGenerated).toMatch(/generated kept/); expect(afterGenerated).toMatch(/VIRTUAL/i)
      await change({ action: 'alter-column', target: await object(alterTable), column: 'gen_text', alteration: { kind: 'generated-expression', expression: `concat('y',${q('id')})` } })
      const textDefinition = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!.split('\n').find(line => line.includes('`gen_text`'))!
      expect(textDefinition.toLowerCase()).toContain('collate utf8mb4_bin'); expect(textDefinition).toContain('text kept'); expect(textDefinition).toMatch(/STORED|PERSISTENT/i)
      expect((await run(`SELECT ${q('gen_text')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['y1'],['y2']])
      await run(`ALTER TABLE ${full(alterTable)} ADD ${q('no_default')} INT NOT NULL DEFAULT 8`)
      await change({ action: 'alter-column', target: await object(alterTable), column: 'no_default', alteration: { kind: 'default', default: { kind: 'none' } } })
      const beforeNull = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!
      const beforeLine = beforeNull.split('\n').find(line => line.includes('`no_default`'))!
      const absentDefault = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'no_default', alteration: { kind: 'nullability', nullable: true } })
      expect(absentDefault.warnings.join(' ')).toContain(engine === 'mysql' ? 'second implicitly committed statement' : 'default metadata will change')
      const noDefaultResult = await apply(absentDefault); expect(noDefaultResult.status, noDefaultResult.message).toBe('completed')
      const afterNull = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!
      const afterLine = afterNull.split('\n').find(line => line.includes('`no_default`'))!
      expect(beforeLine).not.toMatch(/\bDEFAULT\b/i)
      if (engine === 'mysql') expect(afterLine, 'MySQL must restore the absent default').not.toMatch(/\bDEFAULT\b/i)
      else expect(afterLine).toMatch(/DEFAULT NULL/i)
      await change({ action: 'alter-column', target: await object(alterTable), column: 'no_default', alteration: { kind: 'type', type: { type: 'bigint', length: 255, precision: 18, scale: 2 } } })
      const afterType = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!.split('\n').find(line => line.includes('`no_default`'))!
      if (engine === 'mysql') expect(afterType, 'MySQL type change must restore the absent default').not.toMatch(/\bDEFAULT\b/i)
      else expect(afterType).toMatch(/DEFAULT NULL/i)
      await run(`ALTER TABLE ${full(alterTable)} ADD ${q('mode_sensitive')} VARCHAR(10) COMMENT 'a\\\\b'`)
      await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'mode_sensitive', alteration: { kind: 'type', type: { type: 'varchar', length: 20, precision: 18, scale: 2 } } })).rejects.toThrow(/SQL mode/)
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    if (['postgres','sqlite','duckdb','mysql','oracle'].includes(engine)) {
      const expressionIndex = prefix+'_expression', expression = `lower(${q('label')})`
      const expressionOnly: SchemaChange = { action: 'create-index', target: await object(name), name: expressionIndex, columns: [], expressions: [{ expression, after: null, descending: false }], unique: false }
      const expressionPlan = await prepare(expressionOnly)
      expect(expressionPlan.sql).toContain(`(${expression})`); expect(expressionPlan.warnings.join(' ')).toMatch(/determinism/)
      const expressionResult = await apply(expressionPlan); expect(expressionResult.status, expressionResult.message).toBe('completed'); if (transactional) await run('COMMIT')
      const indexSql = engine === 'postgres' ? `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='${expressionIndex}'`
        : engine === 'sqlite' ? `SELECT sql FROM sqlite_master WHERE type='index' AND name='${expressionIndex}'`
        : engine === 'duckdb' ? `SELECT sql FROM duckdb_indexes() WHERE index_name='${expressionIndex}'`
        : engine === 'mysql' ? `SELECT EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${name.replaceAll("'", "''")}' AND INDEX_NAME='${expressionIndex}'`
        : `SELECT column_expression FROM user_ind_expressions WHERE index_name='${expressionIndex}'`
      expect((await run(indexSql)).rows[0][0]).toMatch(/lower/i)
      await change({ action: 'drop-index', target: await object(expressionIndex, 'index') })
      const mixed = prefix+'_mixed_expression'
      const mixedPlan = await prepare({ ...expressionOnly, name: mixed, columns: ['id','label'], expressions: [{ expression: `${q('id')} + 1`, after: null, descending: false }, { expression, after: 'id', descending: engine !== 'duckdb' }] })
      expect(mixedPlan.sql).toContain(`(${q('id')} + 1), ${q('id')}, (${expression})${engine === 'duckdb' ? '' : ' DESC'}, ${q('label')}`)
      const mixedResult = await apply(mixedPlan); expect(mixedResult.status, mixedResult.message).toBe('completed'); if (transactional) await run('COMMIT')
      if (engine !== 'duckdb') {
        const orderSql = engine === 'postgres' ? `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='${mixed}'`
          : engine === 'sqlite' ? `SELECT sql FROM sqlite_master WHERE type='index' AND name='${mixed}'`
          : engine === 'mysql' ? `SELECT COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${name.replaceAll("'", "''")}' AND INDEX_NAME='${mixed}' AND SEQ_IN_INDEX=3`
          : `SELECT descend FROM user_ind_columns WHERE index_name='${mixed}' AND column_position=3`
        expect((await run(orderSql)).rows[0][0]).toMatch(engine === 'mysql' ? /^D$/ : /DESC/i)
      }
      await change({ action: 'drop-index', target: await object(mixed, 'index') })
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INTEGER, ${q('value')} ${engine === 'oracle' ? 'VARCHAR2(40)' : 'VARCHAR(40)'})`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('value')}) VALUES (1,'Alice')`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('value')}) VALUES (2,'alice')`); if (engine === 'oracle') await run('COMMIT')
      const uniqueExpression = await prepare({ ...expressionOnly, target: await object(alterTable), name: prefix+'_unique_expression', expressions: [{ expression: `lower(${q('value')})`, after: null, descending: false }], unique: true })
      const rejectedExpression = await apply(uniqueExpression)
      expect(['failed','unknown']).toContain(rejectedExpression.status); expect(rejectedExpression.message).toMatch(/unique|duplicate/i)
      expect((await run(`SELECT ${q('value')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['Alice'],['alice']])
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    if (['postgres','sqlserver','azure-sql'].includes(engine)) {
      const isPg = engine === 'postgres', collation = isPg ? `${q('pg_catalog')}.${q('C')}` : 'Latin1_General_100_BIN2'
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INTEGER PRIMARY KEY, ${q('collated')} ${isPg ? 'VARCHAR(20)' : 'NVARCHAR(20)'} COLLATE ${collation} DEFAULT 'original'${isPg ? '' : `, ${q('blocked_type')} INT DEFAULT 7`})`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (1)`)
      if (!isPg) {
        const blocked = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'blocked_type', alteration: { kind: 'type', type: { type: 'bigint', length: 255, precision: 18, scale: 2 } } })
        expect(blocked.warnings.join(' ')).toMatch(/default constraint/)
        const rejected = await apply(blocked)
        expect(['failed','unknown']).toContain(rejected.status); expect(rejected.message).toMatch(/dependent|dependenc/i)
        const inspected = (await driver.inspectObject({ sessionId: session.id, object: await object(alterTable) })).sections.find(section => section.title === 'Columns')!
        const unchanged = inspected.rows.find(row => row[inspected.columns.indexOf('Name')] === 'blocked_type')!
        expect(unchanged[inspected.columns.indexOf('Type')]?.toLowerCase()).toBe('int')
        expect(unchanged[inspected.columns.indexOf('Default constraint')]).toBeTruthy()
        expect((await run(`SELECT ${q('blocked_type')} FROM ${full(alterTable)} WHERE ${q('id')}=1`)).rows).toEqual([['7']])
      }
      await change({ action: 'alter-column', target: await object(alterTable), column: 'collated', alteration: { kind: 'nullability', nullable: false } })
      await change({ action: 'alter-column', target: await object(alterTable), column: 'collated', alteration: { kind: 'type', type: { type: 'varchar', length: 40, precision: 18, scale: 2 } } })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (2)`)
      expect((await run(`SELECT ${q('collated')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['original'],['original']])
      const actual = (await driver.inspectObject({ sessionId: session.id, object: await object(alterTable) })).sections.find(section => section.title === 'Columns')!
      const row = actual.rows.find(row => row[actual.columns.indexOf('Name')] === 'collated')!
      expect(row[actual.columns.indexOf('Collation')]).toBe(isPg ? 'C' : 'Latin1_General_100_BIN2')
      if (!isPg) {
        await run(`ALTER TABLE ${full(alterTable)} ADD ${q('sparse_value')} INT SPARSE NULL, ${q('computed_value')} AS (${q('id')} + 1)`)
        await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'sparse_value', alteration: { kind: 'nullability', nullable: false } })).rejects.toThrow(/sparse/)
        await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'computed_value', alteration: { kind: 'default', default: { kind: 'number', value: '1' } } })).rejects.toThrow(/Generated columns/)
      }
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    if (engine === 'oracle') {
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INTEGER PRIMARY KEY, ${q('special_default')} INTEGER DEFAULT ON NULL 5)`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('special_default')}) VALUES (1,NULL)`); await run('COMMIT')
      await change({ action: 'alter-column', target: await object(alterTable), column: 'special_default', alteration: { kind: 'default', default: { kind: 'number', value: '9' } } })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('special_default')}) VALUES (2,NULL)`); await run('COMMIT')
      expect((await run(`SELECT ${q('special_default')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['5'],['9']])
      await expect(prepare({ action: 'alter-column', target: await object(alterTable), column: 'special_default', alteration: { kind: 'default', default: { kind: 'none' } } })).rejects.toThrow(/DEFAULT ON NULL/)
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    const id = { ...column('generated_id', false), primaryKey: true, ...(engine === 'duckdb' ? {} : { generation: { kind: 'identity' as const, mode: ['postgres','oracle'].includes(engine) ? 'by-default' as const : 'auto' as const } }) }
    const storage = ['postgres','mysql','mariadb','sqlserver','azure-sql'].includes(engine) ? 'stored' as const : 'virtual' as const
    const computed = (name: string, amount: number) => schemaColumnSchema.parse({ name, type: 'integer', nullable: true, generation: { kind: 'computed', expression: `${q('quantity')} + ${amount}`, storage } })
    await change({ action: 'create-table', location, name: generatedName, columns: [id, column('quantity'), computed('calculated', 1)] })
    await run(engine === 'duckdb' ? `INSERT INTO ${full(generatedName)} (${q('generated_id')},${q('quantity')}) VALUES (1,2)` : `INSERT INTO ${full(generatedName)} (${q('quantity')}) VALUES (2)`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('generated_id')},${q('quantity')},${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['1','2','3']])
    const generatedAlter: SchemaChange = { action: 'alter-column', target: await object(generatedName), column: 'calculated', alteration: { kind: 'default', default: { kind: 'number', value: '5' } } }
    if (engine === 'duckdb') {
      const denied = await apply(await prepare(generatedAlter)); expect(denied.status).toBe('failed')
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['3']])
    } else await expect(prepare(generatedAlter)).rejects.toThrow(engine === 'sqlite' ? /separate table migration/ : /Generated columns/)
    if (engine !== 'duckdb') {
      const identityAlter: SchemaChange = { ...generatedAlter, column: 'generated_id' }
      await expect(prepare(identityAlter)).rejects.toThrow(engine === 'sqlite' ? /separate table migration/ : /Identity columns/)
    }
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
    if (engine === 'postgres') {
      const generated = async (alteration: Extract<SchemaChange,{ action: 'alter-column' }>['alteration']) => change({ action: 'alter-column', target: await object(generatedName), column: 'calculated', alteration })
      await generated({ kind: 'generated-expression', expression: `${q('quantity')} + 10` })
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['15']])
      await generated({ kind: 'generated-drop' })
      await run(`UPDATE ${full(generatedName)} SET ${q('quantity')}=7`)
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['15']])
    }
    if (['mysql','mariadb'].includes(engine)) {
      await change({ action: 'alter-column', target: await object(generatedName), column: 'calculated', alteration: { kind: 'generated-expression', expression: `${q('quantity')} + 10` } })
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['15']])
    }
    if (engine === 'oracle') {
      const inspected = async () => {
        const columns = (await driver.inspectObject({ sessionId: session.id, object: await object(generatedName) })).sections.find(section => section.title === 'Columns')!
        const row = columns.rows.find(row => row[columns.columns.indexOf('Name')] === 'calculated')!
        return ['Type','Length','Precision','Scale','Nullable','Virtual'].map(key => row[columns.columns.indexOf(key)])
      }
      const before = await inspected()
      await change({ action: 'alter-column', target: await object(generatedName), column: 'calculated', alteration: { kind: 'generated-expression', expression: `${q('quantity')} + 10` } })
      expect(await inspected()).toEqual(before)
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([['15']])
      const incompatible = await prepare({ action: 'alter-column', target: await object(generatedName), column: 'calculated', alteration: { kind: 'generated-expression', expression: `TO_CHAR(${q('quantity')})` } })
      const changedType = await apply(incompatible)
      if (changedType.status !== 'completed') expect(['failed','unknown']).toContain(changedType.status)
      expect(await inspected(), 'Changing only the expression must preserve the native column type').toEqual(before)
      expect((await run(`SELECT ${q('calculated')} FROM ${full(generatedName)}`)).rows).toEqual([[changedType.status === 'completed' ? '5' : '15']])
    }
    await change({ action: 'drop-table', target: await object(generatedName) })
    if (['mysql','mariadb'].includes(engine)) {
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INT NOT NULL COMMENT 'identity kept', ${q('quantity')} INT, PRIMARY KEY (${q('id')}))`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (0,7),(42,8)`)
      const addIdentity = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-add', mode: 'auto' } })
      expect(addIdentity.destructive).toBe(true); expect(addIdentity.warnings.join(' ')).toMatch(/existing zero values/); expect(addIdentity.sql).toMatch(/identity kept/)
      await expect(apply(addIdentity, { destructiveApproved: false })).rejects.toThrow(/destructive/)
      const added = await apply(addIdentity); expect(added.status, added.message).toBe('completed')
      const transformed = (await run(`SELECT ${q('id')},${q('quantity')} FROM ${full(alterTable)} ORDER BY ${q('quantity')}`)).rows
      expect(transformed).toEqual([['1','7'],['42','8']])
      await run(`INSERT INTO ${full(alterTable)} (${q('quantity')}) VALUES (9)`)
      expect((await run(`SELECT ${q('id')} FROM ${full(alterTable)} WHERE ${q('quantity')}=9`)).rows).toEqual([['43']])
      await change({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-drop' } })
      const afterDrop = (await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]!
      expect(afterDrop).not.toMatch(/AUTO_INCREMENT/i); expect(afterDrop).toContain('identity kept')
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (99,10)`)
      expect((await run(`SELECT ${q('id')},${q('quantity')} FROM ${full(alterTable)} ORDER BY ${q('quantity')}`)).rows).toEqual([['1','7'],['42','8'],['43','9'],['99','10']])
      await change({ action: 'drop-table', target: await object(alterTable) })
      await run('SET @s1_previous_sql_mode = @@SESSION.sql_mode')
      try {
        await run("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_AUTO_VALUE_ON_ZERO')")
        await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INT NOT NULL PRIMARY KEY, ${q('quantity')} INT)`)
        await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (0,7),(42,8)`)
        await change({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-add', mode: 'auto' } })
        expect((await run(`SELECT ${q('id')},${q('quantity')} FROM ${full(alterTable)} ORDER BY ${q('quantity')}`)).rows).toEqual([['0','7'],['42','8']])
        await change({ action: 'drop-table', target: await object(alterTable) })
      } finally { await run('SET SESSION sql_mode = @s1_previous_sql_mode') }
      if (engine === 'mysql') {
        await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ${q('parent')} INT, CONSTRAINT ${q(prefix+'_self_fk')} FOREIGN KEY (${q('parent')}) REFERENCES ${full(alterTable)} (${q('id')}))`)
        const blockedIdentity = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-drop' } })
        expect(blockedIdentity.warnings.join(' ')).toMatch(/foreign-key dependency/)
        const rejected = await apply(blockedIdentity); expect(rejected.status).toBe('failed'); expect(rejected.message).toMatch(/foreign key/i)
        expect((await run(`SHOW CREATE TABLE ${full(alterTable)}`)).rows[0][1]).toMatch(/AUTO_INCREMENT/i)
        await change({ action: 'drop-table', target: await object(alterTable) })
      }
    }
    if (engine === 'postgres') {
      await change({ action: 'create-table', location, name: alterTable, columns: [{ ...column('id', false), primaryKey: true }] })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (42)`)
      const identity = async (alteration: Extract<SchemaChange,{ action: 'alter-column' }>['alteration']) => change({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration })
      const add = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-add', mode: 'by-default' } })
      expect(add.destructive).toBe(true); expect(add.warnings.join(' ')).toMatch(/independently of existing values/)
      await expect(apply(add, { destructiveApproved: false })).rejects.toThrow(/destructive/)
      expect((await apply(add)).status).toBe('completed'); await run('COMMIT')
      await run(`INSERT INTO ${full(alterTable)} DEFAULT VALUES`)
      expect((await run(`SELECT ${q('id')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['1'],['42']])
      await identity({ kind: 'identity-mode', mode: 'always' })
      const rejected = driver.start({ sessionId: session.id, sql: `INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (99)`, maxRows: 100 }); await driver.wait(session.id)
      expect(events.find(event => event.type === 'complete' && event.queryId === rejected)).toMatchObject({ status: 'failed' })
      await identity({ kind: 'identity-drop' })
      await run(`INSERT INTO ${full(alterTable)} (${q('id')}) VALUES (99)`)
      expect((await run(`SELECT ${q('id')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['1'],['42'],['99']])
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
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
    if (engine === 'oracle') {
      const oracleIdentity = { ...column('id', false), generation: { kind: 'identity' as const, mode: 'by-default' as const } }
      await change({ action: 'create-table', location, name: alterTable, columns: [oracleIdentity, column('quantity')] })
      await run(`INSERT INTO ${full(alterTable)} (${q('quantity')}) VALUES (5)`); await run('COMMIT')
      const modePlan = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-mode', mode: 'always' } })
      expect(modePlan.destructive).toBe(true); expect(modePlan.warnings.join(' ')).toMatch(/ON NULL/)
      expect((await apply(modePlan)).status).toBe('completed')
      const rejected = driver.start({ sessionId: session.id, sql: `INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (99,6)`, maxRows: 100 }); await driver.wait(session.id)
      expect(events.find(event => event.type === 'complete' && event.queryId === rejected)).toMatchObject({ status: 'failed' }); await run('ROLLBACK')
      const drop = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-drop' } })
      expect(drop.destructive).toBe(true); expect(drop.warnings.join(' ')).toMatch(/NOT NULL/)
      expect((await apply(drop)).status).toBe('completed')
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (NULL,6)`); await run('COMMIT')
      expect((await run(`SELECT ${q('id')},${q('quantity')} FROM ${full(alterTable)} ORDER BY ${q('quantity')}`)).rows).toEqual([['1','5'],[null,'6']])
      await change({ action: 'drop-table', target: await object(alterTable) })
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} NUMBER GENERATED BY DEFAULT ON NULL AS IDENTITY, ${q('quantity')} INTEGER)`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('quantity')}) VALUES (NULL,5)`); await run('COMMIT')
      const onNull = await prepare({ action: 'alter-column', target: await object(alterTable), column: 'id', alteration: { kind: 'identity-mode', mode: 'by-default' } })
      expect(onNull.warnings.join(' ')).toMatch(/ON NULL/); expect((await apply(onNull)).status).toBe('completed')
      const identityDetails = await driver.inspectObject({ sessionId: session.id, object: await object(alterTable) })
      const identityInfo = identityDetails.sections.find(section => section.title === 'Identity columns')!
      expect(identityInfo.rows[0][identityInfo.columns.indexOf('Generation')]).toBe('BY DEFAULT')
      const identityColumn = identityDetails.sections.find(section => section.title === 'Columns')!
      expect(identityColumn.rows[0][identityColumn.columns.indexOf('Default on null')]).toBe('NO')
      expect((await run(`SELECT ${q('id')} FROM ${full(alterTable)} WHERE ${q('quantity')}=5`)).rows).toEqual([['1']])
      await change({ action: 'drop-table', target: await object(alterTable) })
      await run(`CREATE TABLE ${full(alterTable)} (${q('quantity')} NUMBER, ${q('precise')} NUMBER(8,2) GENERATED ALWAYS AS (${q('quantity')} * 1.25) VIRTUAL, ${q('event_date')} DATE GENERATED ALWAYS AS (DATE '2020-01-01' + ${q('quantity')}) VIRTUAL, ${q('event_time')} TIMESTAMP(6) GENERATED ALWAYS AS (CAST(DATE '2020-01-01' + ${q('quantity')} AS TIMESTAMP)) VIRTUAL, ${q('zoned_time')} TIMESTAMP(6) WITH TIME ZONE GENERATED ALWAYS AS (FROM_TZ(CAST(DATE '2020-01-01' + ${q('quantity')} AS TIMESTAMP), 'UTC')) VIRTUAL, ${q('local_time')} TIMESTAMP(6) WITH LOCAL TIME ZONE GENERATED ALWAYS AS (CAST(FROM_TZ(CAST(DATE '2020-01-01' + ${q('quantity')} AS TIMESTAMP), 'UTC') AS TIMESTAMP WITH LOCAL TIME ZONE)) VIRTUAL, ${q('float_value')} BINARY_FLOAT GENERATED ALWAYS AS (CAST(${q('quantity')} AS BINARY_FLOAT)) VIRTUAL, ${q('double_value')} BINARY_DOUBLE GENERATED ALWAYS AS (CAST(${q('quantity')} AS BINARY_DOUBLE)) VIRTUAL, ${q('raw_value')} RAW(8) GENERATED ALWAYS AS (HEXTORAW(CASE WHEN ${q('quantity')} > 0 THEN 'FA' ELSE 'FB' END)) VIRTUAL, ${q('v_char')} VARCHAR2(64 CHAR) GENERATED ALWAYS AS (TO_CHAR(${q('quantity')} + 1)) VIRTUAL, ${q('v_byte')} VARCHAR2(64 BYTE) GENERATED ALWAYS AS (TO_CHAR(${q('quantity')} + 2)) VIRTUAL, ${q('fixed_char')} CHAR(64 CHAR) GENERATED ALWAYS AS (TO_CHAR(${q('quantity')} + 3)) VIRTUAL, ${q('national')} NVARCHAR2(64) GENERATED ALWAYS AS (TO_CHAR(${q('quantity')} + 4)) VIRTUAL, ${q('fixed_national')} NCHAR(64) GENERATED ALWAYS AS (TO_CHAR(${q('quantity')} + 5)) VIRTUAL)`)
      await run(`INSERT INTO ${full(alterTable)} (${q('quantity')}) VALUES (1)`); await run('COMMIT')
      const cases = [
        ['precise', `${q('quantity')} * 2.25`],
        ['event_date', `DATE '2020-01-01' + ${q('quantity')} + 1`],
        ['event_time', `CAST(DATE '2020-01-01' + ${q('quantity')} + 1 AS TIMESTAMP)`],
        ['zoned_time', `FROM_TZ(CAST(DATE '2020-01-01' + ${q('quantity')} + 1 AS TIMESTAMP), 'UTC')`],
        ['local_time', `CAST(FROM_TZ(CAST(DATE '2020-01-01' + ${q('quantity')} + 1 AS TIMESTAMP), 'UTC') AS TIMESTAMP WITH LOCAL TIME ZONE)`],
        ['float_value', `CAST(${q('quantity')} + 1 AS BINARY_FLOAT)`],
        ['double_value', `CAST(${q('quantity')} + 1 AS BINARY_DOUBLE)`],
        ['raw_value', `HEXTORAW(CASE WHEN ${q('quantity')} > 0 THEN 'FC' ELSE 'FD' END)`],
        ...['v_char','v_byte','fixed_char','national','fixed_national'].map((name, index) => [name, `TO_CHAR(${q('quantity')} + ${index + 11})`])
      ]
      for (const [columnName, expression] of cases) {
        const inspect = async () => {
          const columns = (await driver.inspectObject({ sessionId: session.id, object: await object(alterTable) })).sections.find(section => section.title === 'Columns')!
          const row = columns.rows.find(row => row[columns.columns.indexOf('Name')] === columnName)!
          return ['Type','Length','Precision','Scale','Nullable','Virtual','Char semantics','Char length','Collation'].map(key => row[columns.columns.indexOf(key)])
        }
        const before = await inspect()
        await change({ action: 'alter-column', target: await object(alterTable), column: columnName, alteration: { kind: 'generated-expression', expression } })
        expect(await inspect(), columnName).toEqual(before)
      }
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (1)`); await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (2)`)
    if (engine === 'oracle') await run('COMMIT')
    expect((await run(`SELECT ${q('label')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([["quote'\\;-- 世界"]])
    expect((await run(`SELECT ${q('expression_default')} FROM ${full(name)} WHERE ${q('id')}=1`)).rows).toEqual([['3']])
    const parent = await object(name)
    const fk = { kind: 'foreign' as const, name: prefix+'_fk', columns: ['parent_id'], reference: { kind: 'table' as const, table: parent }, referencedColumns: ['id'], onDelete: 'no-action' as const, onUpdate: 'no-action' as const }
    const check = { kind: 'check' as const, name: prefix+'_check', expression: `${q('quantity')} >= 0` }
    const uniqueConstraint = { kind: 'unique' as const, name: prefix+'_uniq', columns: ['serial'] }
    const constraintsCreate: SchemaChange = { action: 'create-table', location, name: constrainedTable, columns: [{ ...column('id', false), primaryKey: true }, column('parent_id'), column('quantity'), column('serial')], constraints: [fk, check, uniqueConstraint] }
    const staleCreate = await prepare({ ...constraintsCreate, name: prefix+'_stale_child' })
    await run(`ALTER TABLE ${full(name)} ADD ${q('create_ref_external')} INTEGER`, other.id)
    const staleCreateResult = await apply(staleCreate)
    expect(staleCreateResult.status).toBe('failed'); expect(staleCreateResult.message).toMatch(/referenced table changed/); expect(staleCreateResult.executedSql).toBe('')
    await change(constraintsCreate)
    await run(`INSERT INTO ${full(constrainedTable)} (${q('id')},${q('parent_id')},${q('quantity')},${q('serial')}) VALUES (1,1,2,10)`)
    if (engine === 'oracle') await run('COMMIT')
    async function reject(sql: string) {
      const queryId = driver.start({ sessionId: session.id, sql, maxRows: 100 }); await driver.wait(session.id)
      expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'failed' })
    }
    await reject(`INSERT INTO ${full(constrainedTable)} (${q('id')},${q('parent_id')},${q('quantity')},${q('serial')}) VALUES (2,999,2,11)`)
    await reject(`INSERT INTO ${full(constrainedTable)} (${q('id')},${q('parent_id')},${q('quantity')},${q('serial')}) VALUES (2,1,-1,11)`)
    await reject(`INSERT INTO ${full(constrainedTable)} (${q('id')},${q('parent_id')},${q('quantity')},${q('serial')}) VALUES (2,1,2,10)`)
    expect((await run(`SELECT ${q('id')} FROM ${full(constrainedTable)}`)).rows).toEqual([['1']])
    const child = await object(constrainedTable)
    if (['sqlite','duckdb'].includes(engine)) {
      await expect(prepare({ action: 'add-constraint', target: child, constraint: check })).rejects.toThrow(/separate table migration/)
      await expect(prepare({ action: 'drop-constraint', target: child, name: check.name, kind: 'check' })).rejects.toThrow(/separate table migration/)
    } else {
      for (const kind of ['check','unique','foreign'] as const) {
        const item = kind === 'check' ? check : kind === 'unique' ? uniqueConstraint : fk
        const drop = await prepare({ action: 'drop-constraint', target: await object(constrainedTable), name: item.name, kind })
        await expect(apply(drop, { destructiveApproved: false })).rejects.toThrow(/destructive/)
        expect((await apply(drop)).status).toBe('completed'); if (transactional) await run('COMMIT')
        await change({ action: 'add-constraint', target: await object(constrainedTable), constraint: item })
      }
      const replacement = await prepare({ action: 'replace-constraint', target: await object(constrainedTable), name: check.name, kind: 'check', constraint: { ...check, expression: `${q('quantity')} >= 1` } })
      expect(replacement.destructive).toBe(true)
      if (engine === 'oracle') expect(replacement.warnings.join(' ')).toContain('old constraint is gone')
      await expect(apply(replacement, { destructiveApproved: false })).rejects.toThrow(/destructive/)
      const replaced = await apply(replacement); expect(replaced.status, replaced.message).toBe('completed'); if (transactional) await run('COMMIT')
      await reject(`UPDATE ${full(constrainedTable)} SET ${q('quantity')}=0 WHERE ${q('id')}=1`)
      expect((await run(`SELECT ${q('quantity')} FROM ${full(constrainedTable)}`)).rows).toEqual([['2']])
      const impossible = await prepare({ action: 'replace-constraint', target: await object(constrainedTable), name: check.name, kind: 'check', constraint: { ...check, expression: `${q('quantity')} < 0` } })
      const failedReplacement = await apply(impossible)
      expect(['failed','unknown']).toContain(failedReplacement.status)
      const constraintExists = () => driver.schema(session.id).then(snapshot => snapshot.catalog?.objects.some(object => object.kind === 'constraint' && object.parent === constrainedTable && object.name === check.name))
      if (engine === 'oracle') {
        expect(failedReplacement.executedSql).toContain('DROP CONSTRAINT'); expect(failedReplacement.message).toContain('DDL can commit implicitly')
        expect(await constraintExists()).toBe(false)
        await change({ action: 'add-constraint', target: await object(constrainedTable), constraint: { ...check, expression: `${q('quantity')} >= 1` } })
      } else expect(await constraintExists()).toBe(true)
      await reject(`UPDATE ${full(constrainedTable)} SET ${q('quantity')}=0 WHERE ${q('id')}=1`)
      const staleForeign = await prepare({ action: 'add-constraint', target: await object(constrainedTable), constraint: { ...fk, name: prefix+'_fk_stale' } })
      await run(`ALTER TABLE ${full(name)} ADD ${q('ref_external')} INTEGER`, other.id)
      const staleForeignResult = await apply(staleForeign)
      expect(staleForeignResult.status).toBe('failed'); expect(staleForeignResult.message).toMatch(/referenced table changed/); expect(staleForeignResult.executedSql).toBe('')
    }
    await change({ action: 'drop-table', target: await object(constrainedTable) })
    await change({ action: 'create-table', location, name: compositeParent, columns: [{ ...column('a', false), primaryKey: true }, { ...column('b', false), primaryKey: true }] })
    await run(`INSERT INTO ${full(compositeParent)} (${q('a')},${q('b')}) VALUES (1,2)`)
    if (engine === 'oracle') await run('COMMIT')
    const composite = { kind: 'foreign' as const, name: prefix+'_composite_fk', columns: ['x','y'], reference: { kind: 'table' as const, table: await object(compositeParent) }, referencedColumns: ['a','b'], onDelete: 'no-action' as const, onUpdate: 'no-action' as const }
    await change({ action: 'create-table', location, name: compositeChild, columns: [column('x'), column('y')], constraints: [composite] })
    await run(`INSERT INTO ${full(compositeChild)} (${q('x')},${q('y')}) VALUES (1,2)`)
    await reject(`INSERT INTO ${full(compositeChild)} (${q('x')},${q('y')}) VALUES (2,1)`)
    expect((await run(`SELECT ${q('x')},${q('y')} FROM ${full(compositeChild)}`)).rows).toEqual([['1','2']])
    if (engine === 'oracle') await run('COMMIT')
    await change({ action: 'drop-table', target: await object(compositeChild) })
    await change({ action: 'drop-table', target: await object(compositeParent) })
    const cascade = { ...fk, name: prefix+'_cascade_fk', onDelete: 'cascade' as const, onUpdate: engine === 'oracle' ? 'no-action' as const : 'cascade' as const }
    const cascadeCreate: SchemaChange = { action: 'create-table', location, name: cascadeTable, columns: [{ ...column('id', false), primaryKey: true }, column('parent_id')], constraints: [cascade] }
    if (engine === 'duckdb') await expect(prepare(cascadeCreate)).rejects.toThrow(/NO ACTION/)
    else {
      const cascadePlan = await prepare(cascadeCreate); expect(cascadePlan.destructive).toBe(true)
      await expect(apply(cascadePlan, { destructiveApproved: false })).rejects.toThrow(/destructive/)
      const created = await apply(cascadePlan); expect(created.status, created.message).toBe('completed'); if (transactional) await run('COMMIT')
      await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (400)`)
      await run(`INSERT INTO ${full(cascadeTable)} (${q('id')},${q('parent_id')}) VALUES (1,400)`)
      await run(`DELETE FROM ${full(name)} WHERE ${q('id')}=400`)
      expect((await run(`SELECT ${q('id')} FROM ${full(cascadeTable)}`)).rows).toEqual([])
      if (engine !== 'oracle') {
        await run(`INSERT INTO ${full(name)} (${q('id')}) VALUES (401)`)
        await run(`INSERT INTO ${full(cascadeTable)} (${q('id')},${q('parent_id')}) VALUES (2,401)`)
        await run(`UPDATE ${full(name)} SET ${q('id')}=402 WHERE ${q('id')}=401`)
        expect((await run(`SELECT ${q('parent_id')} FROM ${full(cascadeTable)}`)).rows).toEqual([['402']])
        await run(`DELETE FROM ${full(name)} WHERE ${q('id')}=402`)
      }
      if (engine === 'oracle') await run('COMMIT')
      await change({ action: 'drop-table', target: await object(cascadeTable) })
    }
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
    if (engine === 'postgres') {
      for (const method of ['hash','brin'] as const) {
        const methodIndex = prefix+'_'+method
        await change({ action: 'create-index', target: await object(name), name: methodIndex, columns: ['id'], unique: false, method })
        await change({ action: 'drop-index', target: await object(methodIndex, 'index') })
      }
      await run(`CREATE TABLE ${full(methodTable)} (${q('geo')} point, ${q('terms')} tsvector, ${q('id')} integer)`)
      for (const [method, key] of [['gist','geo'], ['gin','terms']] as const) {
        const methodIndex = prefix+'_'+method
        await change({ action: 'create-index', target: await object(methodTable), name: methodIndex, columns: [key], unique: false, method, ...(method === 'gist' ? { include: ['id'] } : {}) })
        await change({ action: 'drop-index', target: await object(methodIndex, 'index') })
      }
      await change({ action: 'drop-table', target: await object(methodTable) })
    }
    const optionsIndex = prefix+'_options'
    if (['mysql','mariadb'].includes(engine)) {
      await run(`CREATE TABLE ${full(alterTable)} (${q('id')} INT NOT NULL PRIMARY KEY, ${q('body')} TEXT NOT NULL)`)
      await run(`INSERT INTO ${full(alterTable)} (${q('id')},${q('body')}) VALUES (1,'alpha-one'),(2,'alpha-two')`)
      const prefixIndex: SchemaChange = { action: 'create-index', target: await object(alterTable), name: prefix+'_str_prefix', columns: ['body','id'], prefixes: [{ column: 'body', length: 5 }], unique: false }
      const uniquePrefix = await prepare({ ...prefixIndex, name: prefix+'_unique_prefix', columns: ['body'], unique: true })
      expect(uniquePrefix.warnings.join(' ')).toMatch(/compare only the specified prefixes/)
      const rejected = await apply(uniquePrefix); expect(rejected.status).toBe('failed'); expect(rejected.message).toMatch(/duplicate/i)
      expect((await run(`SELECT ${q('body')} FROM ${full(alterTable)} ORDER BY ${q('id')}`)).rows).toEqual([['alpha-one'],['alpha-two']])
      const plan = await prepare(prefixIndex); expect(plan.sql).toContain(`${q('body')}(5), ${q('id')}`)
      expect((await apply(plan)).status).toBe('completed')
      const compoundUnique = await prepare({ ...prefixIndex, name: prefix+'_compound_prefix', unique: true })
      expect((await apply(compoundUnique)).status).toBe('completed')
      const indexes = (await driver.inspectObject({ sessionId: session.id, object: await object(alterTable) })).sections.find(section => section.title === 'Indexes')!
      const key = indexes.rows.find(row => row[indexes.columns.indexOf('Name')] === prefix+'_str_prefix' && row[indexes.columns.indexOf('Column')] === 'body')!
      expect(key[indexes.columns.indexOf('Prefix length')]).toBe('5')
      const uniqueKey = indexes.rows.find(row => row[indexes.columns.indexOf('Name')] === prefix+'_compound_prefix' && row[indexes.columns.indexOf('Column')] === 'body')!
      expect(uniqueKey[indexes.columns.indexOf('Unique')]).toBe('1'); expect(uniqueKey[indexes.columns.indexOf('Prefix length')]).toBe('5')
      await change({ action: 'drop-table', target: await object(alterTable) })
    }
    const partial = ['postgres','sqlite','sqlserver','azure-sql'].includes(engine)
    const included = ['postgres','sqlserver','azure-sql'].includes(engine)
    const optionsPlan = await prepare({ action: 'create-index', target: await object(name), name: optionsIndex, columns: ['label'], unique: false, ...(engine === 'duckdb' ? {} : { descending: ['label'] }), ...(included ? { include: ['id'] } : {}), ...(partial ? { predicate: `${q('id')} > 0` } : {}), ...(engine === 'postgres' ? { method: 'btree' as const } : {}) })
    if (engine !== 'duckdb') expect(optionsPlan.sql).toContain(' DESC')
    else expect(optionsPlan.sql).not.toContain(' DESC')
    if (partial) expect(optionsPlan.sql).toContain(' WHERE ')
    if (included) expect(optionsPlan.sql).toContain(' INCLUDE ')
    const optionsResult = await apply(optionsPlan)
    expect(optionsResult.status, optionsResult.message).toBe('completed'); if (transactional) await run('COMMIT')
    expect(await object(optionsIndex, 'index')).toBeDefined()
    if (['mysql','mariadb'].includes(engine)) {
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
      const order = await run(`SELECT COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=${literal(schema)} AND TABLE_NAME=${literal(name)} AND INDEX_NAME=${literal(optionsIndex)} AND COLUMN_NAME='label'`)
      expect(order.rows).toEqual([['D']])
    }
    await change({ action: 'drop-index', target: await object(optionsIndex, 'index') })
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
    for (const table of [conversionTable,alterTable,compositeChild,compositeParent,cascadeTable,constrainedTable,name,renamed,generatedName,identityAddName,alwaysName,generatedKeyName,methodTable,nativeTable]) { try { await run(`DROP TABLE ${full(table)}`) } catch {} }
    if (['postgres','duckdb','sqlserver','azure-sql','oracle'].includes(engine)) { try { await run(`DROP TYPE ${full(namedType)}`) } catch {} }
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}
