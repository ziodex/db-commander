import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent, GridChange, GridSnapshot } from '../../src/shared/contracts'

/** Runs the same real write, rollback, conflict and binding contract on every
 * connector. SQLite and DuckDB execute inside the Node 24 Docker fixtures. */
export async function verifyEditableGrid(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-grid-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const embedded = ['sqlite', 'duckdb'].includes(config.engine)
  const local = { ...config, ...(embedded ? { filePath: join(directory, 'grid.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const a = await driver.connect(local), b = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
  const q = (name: string) => quoteIdentifier(name, config.engine), name = `grid '${randomUUID().slice(0, 8)}`, label = "Label ' value"
  let table: GridSnapshot['table']
  async function run(sql: string, id = a.id) {
    const queryId = driver.start({ sessionId: id, sql, maxRows: 100 })
    await driver.wait(id)
    const completed = events.find(event => event.type === 'complete' && event.queryId === queryId)
    expect(completed, sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  async function open(id = a.id) {
    const response = await driver.editGrid({ action: 'open', sessionId: id, table })
    expect(response.error).toBeUndefined(); expect(response.grid).toBeDefined()
    return response.grid!
  }
  const apply = (grid: GridSnapshot, changes: GridChange[], id = a.id) => driver.editGrid({ action: 'apply', sessionId: id, snapshotId: grid.id, changes })
  try {
    const textType = ['sqlserver', 'azure-sql'].includes(config.engine) ? 'NVARCHAR' : 'VARCHAR'
    const generated = ['sqlserver', 'azure-sql'].includes(config.engine) ? `${q('calculated')} AS (${q('id')}+10)` : config.engine === 'oracle' ? `${q('calculated')} NUMBER GENERATED ALWAYS AS (${q('id')}+10) VIRTUAL` : `${q('calculated')} INTEGER GENERATED ALWAYS AS (${q('id')}+10)${config.engine === 'duckdb' ? '' : ' STORED'}`
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER NOT NULL,${q('tenant')} INTEGER NOT NULL,${q(label)} ${textType}(120) NOT NULL,${q('note')} ${textType}(60) DEFAULT 'default note',${q('amount')} DECIMAL(30,8),${generated},PRIMARY KEY(${q('id')},${q('tenant')}))`)
    await run(`INSERT INTO ${q(name)} (${q('id')},${q('tenant')},${q(label)},${q('note')},${q('amount')}) VALUES(1,7,'Original',NULL,9.25)`)
    await run(`INSERT INTO ${q(name)} (${q('id')},${q('tenant')},${q(label)}) VALUES(2,7,'Delete me')`)
    if (config.engine === 'oracle') await run('COMMIT')
    const object = (await driver.schema(a.id)).objects.find(object => object.name === name)!
    table = { schema: object.schema, name: object.name, ...(object.catalog ? { catalog: object.catalog } : {}) }
    let grid = await open()
    expect(grid.columns.filter(column => column.primaryKey).map(column => column.name)).toEqual(['id', 'tenant'])
    expect(grid.columns[5].generated).toBe(true)
    expect(grid.rows[0].slice(0, 4)).toEqual(['1', '7', 'Original', null])
    // Host-retained originals survive a caller trying to replace the UI values.
    grid.rows[0][2] = 'tampered original'
    const literal = "O'Brien \\ ; DELETE FROM anything; -- Ω"
    const mixed: GridChange[] = [
      { kind: 'update', row: 0, values: [{ column: 2, value: literal }] },
      { kind: 'delete', row: 1 },
      { kind: 'insert', values: [{ column: 0, value: '3' }, { column: 1, value: '7' }, { column: 2, value: 'Inserted' }] }
    ]
    let response = await apply(grid, mixed)
    expect(response.error).toBeUndefined(); expect(response).toMatchObject({ applied: 3, session: { transaction: 'transaction' } })
    expect(driver.getSession(b.id).transaction).toBe('idle')
    await expect(driver.disconnect(a.id)).rejects.toThrow(/transaction/)
    expect((await driver.editGrid({ action: 'open', sessionId: a.id, table })).error).toMatch(/transaction/)
    await run('ROLLBACK')
    grid = await open(); expect(grid.rows.map(row => row[2])).toEqual(['Original', 'Delete me'])
    response = await apply(grid, mixed); expect(response.error).toBeUndefined()
    await run('COMMIT')
    grid = await open(); expect(grid.rows.map(row => row[2])).toEqual([literal, 'Inserted'])
    expect(grid.rows[1][3]).toBe('default note'); expect(grid.rows[1][5]).toBe('13')
    // NULL and empty text are distinct except Oracle's native empty-string rule.
    response = await apply(grid, [{ kind: 'update', row: 0, values: [{ column: 3, value: '' }] }])
    expect(response.error).toBeUndefined(); await run('COMMIT'); grid = await open()
    expect(grid.rows[0][3]).toBe(config.engine === 'oracle' ? null : '')
    // A second session commits a case-only change (important on CI collations).
    await run(`UPDATE ${q(name)} SET ${q(label)}='inserted' WHERE ${q('id')}=3`, b.id)
    if (config.engine === 'oracle') await run('COMMIT', b.id)
    response = await apply(grid, [ { kind: 'update', row: 0, values: [{ column: 2, value: 'must roll back' }] }, { kind: 'delete', row: 1 } ])
    expect(response.error).toMatch(/Concurrency conflict/); expect(response.session.transaction).toBe('idle')
    expect((await open()).rows.map(row => row[2])).toEqual([literal, 'inserted'])
    expect((await apply(grid, mixed)).error).toMatch(/expired/)
    // Constraint failure after a successful update must roll back the update.
    grid = await open()
    response = await apply(grid, [{ kind: 'update', row: 0, values: [{ column: 2, value: 'must roll back' }] }, { kind: 'insert', values: [{ column: 0, value: '1' }, { column: 1, value: '7' }, { column: 2, value: 'duplicate' }] }])
    expect(response.error).toBeTruthy(); expect(response.session.transaction).toBe('idle')
    grid = await open(); expect(grid.rows[0][2]).toBe(literal)
    expect((await apply(grid, [{ kind: 'update', row: 0, values: [{ column: 0, value: '99' }] }])).error).toMatch(/primary keys/)
    expect((await apply(grid, [{ kind: 'insert', values: [{ column: 5, value: '5' }] }])).error).toMatch(/Generated/)
    expect((await apply(grid, [{ kind: 'delete', row: 0 }, { kind: 'delete', row: 0 }])).error).toMatch(/duplicate/)
    expect((await apply(grid, [{ kind: 'delete', row: 199 }])).error).toMatch(/Invalid/)
    expect((await apply(grid, [{ kind: 'delete', row: 0 }], b.id)).error).toMatch(/expired/)
    // A manual console execution invalidates an earlier editable preview.
    await run(`SELECT ${q('id')} FROM ${q(name)}`)
    expect((await apply(grid, [{ kind: 'delete', row: 0 }])).error).toMatch(/expired/)
    // External DDL is detected even without a change to fetched values.
    grid = await open()
    await run(`ALTER TABLE ${q(name)} ADD ${q('added')} INTEGER`, b.id)
    expect((await apply(grid, [{ kind: 'delete', row: 0 }])).error).toMatch(/definition changed/)
    const noKey = name + '_nokey', view = name + '_view'
    await run(`CREATE TABLE ${q(noKey)} (${q('value')} INTEGER)`)
    expect((await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: noKey } })).error).toMatch(/primary key/)
    await run(`CREATE VIEW ${q(view)} AS SELECT * FROM ${q(name)}`)
    expect((await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: view } })).error).toMatch(/base table/)
    await run(`DROP VIEW ${q(view)}`); await run(`DROP TABLE ${q(noKey)}`)
    if (['mysql', 'mariadb'].includes(config.engine)) {
      await run("SET sql_mode='NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES'")
      grid = await open()
      response = await apply(grid, [{ kind: 'update', row: 0, values: [{ column: 2, value: literal + "'" }] }])
      expect(response.error).toBeUndefined(); await run('COMMIT')
      expect((await open()).rows[0][2]).toBe(literal + "'")
      const nontransactional = name + '_myisam'
      await run(`CREATE TABLE ${q(nontransactional)} (id INT PRIMARY KEY) ENGINE=MyISAM`)
      expect((await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: nontransactional } })).error).toMatch(/InnoDB/)
      await run(`DROP TABLE ${q(nontransactional)}`)
      const shadowed = name + '_shadowed'
      await run(`CREATE TABLE ${q(shadowed)} (id INT PRIMARY KEY, value INT) ENGINE=InnoDB`)
      await run(`CREATE TEMPORARY TABLE ${q(shadowed)} (id INT PRIMARY KEY, value INT) ENGINE=MyISAM`)
      expect((await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: shadowed } })).error).toMatch(/temporary/)
      await run(`DROP TEMPORARY TABLE ${q(shadowed)}`); await run(`DROP TABLE ${q(shadowed)}`)
    }
    // Unchanged values still address exactly one row (including MySQL's
    // found-rows behavior), and an external delete is an explicit conflict.
    grid = await open()
    response = await apply(grid, [{ kind: 'update', row: 0, values: [{ column: 2, value: grid.rows[0][2] }] }])
    expect(response.error).toBeUndefined(); await run('ROLLBACK')
    grid = await open(); await run(`DELETE FROM ${q(name)} WHERE ${q('id')}=3`, b.id)
    if (config.engine === 'oracle') await run('COMMIT', b.id)
    expect((await apply(grid, [{ kind: 'delete', row: 1 }])).error).toMatch(/Concurrency conflict/)
    const exactName = name + '_exact', integer = config.engine === 'oracle' ? 'NUMBER(19)' : 'BIGINT'
    await run(`CREATE TABLE ${q(exactName)} (${q('id')} ${integer} NOT NULL PRIMARY KEY,${q('value')} ${config.engine === 'sqlite' ? 'TEXT' : 'DECIMAL(30,8)'})`)
    let exact = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: exactName } })
    expect(exact.error).toBeUndefined()
    response = await apply(exact.grid!, [{ kind: 'insert', values: [{ column: 0, value: '9223372036854775807' }, { column: 1, value: '9007199254740993.12345678' }] }])
    expect(response.error).toBeUndefined(); await run('COMMIT')
    exact = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: exactName } })
    expect(exact.grid?.rows[0]).toEqual(['9223372036854775807', '9007199254740993.12345678'])
    response = await apply(exact.grid!, [{ kind: 'delete', row: 0 }]); expect(response.error).toBeUndefined(); await run('COMMIT')
    await run(`DROP TABLE ${q(exactName)}`)
    if (['postgres', 'duckdb', 'mysql', 'mariadb'].includes(config.engine)) {
      const jsonName = name + '_json'
      await run(`CREATE TABLE ${q(jsonName)} (id INTEGER PRIMARY KEY,value JSON)`)
      const jsonGrid = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: jsonName } })
      expect(jsonGrid.error).toBeUndefined()
      response = await apply(jsonGrid.grid!, [{ kind: 'insert', values: [{ column: 0, value: '1' }, { column: 1, value: '{"exact":9223372036854775807,"text":"Ω"}' }] }])
      expect(response.error).toBeUndefined(); await run('COMMIT')
      const jsonRead = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: jsonName } })
      expect(jsonRead.grid?.rows[0][1]).toContain('9223372036854775807'); expect(jsonRead.grid?.rows[0][1]).toContain('Ω')
      await run(`DROP TABLE ${q(jsonName)}`)
    }
    if (config.engine === 'oracle') {
      const temporalName = name + '_dates'
      await run(`CREATE TABLE ${q(temporalName)} (id INTEGER PRIMARY KEY, d DATE, t TIMESTAMP(9) WITH TIME ZONE)`)
      await run(`INSERT INTO ${q(temporalName)} VALUES(1,TO_DATE('0001-01-01 BC','YYYY-MM-DD BC'),TO_TIMESTAMP_TZ('2024-07-01 10:20:30.123456789 America/New_York','YYYY-MM-DD HH24:MI:SS.FF9 TZR'))`)
      await run('COMMIT')
      let dates = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: temporalName } })
      expect(dates.error).toBeUndefined(); expect(dates.grid?.rows[0][1]).toMatch(/^-0001/)
      expect(dates.grid?.rows[0][2]?.toLowerCase()).toContain('123456789 america/new_york edt')
      const original = dates.grid!.rows[0]
      response = await apply(dates.grid!, [{ kind: 'update', row: 0, values: [{ column: 1, value: original[1] }, { column: 2, value: original[2] }] }])
      expect(response.error).toBeUndefined(); await run('COMMIT')
      dates = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: temporalName } })
      expect(dates.grid?.rows[0]).toEqual(original)
      await run(`UPDATE ${q(temporalName)} SET d=TO_DATE('0001-01-01 AD','YYYY-MM-DD AD')`, b.id); await run('COMMIT', b.id)
      expect((await apply(dates.grid!, [{ kind: 'delete', row: 0 }])).error).toMatch(/Concurrency conflict/)
      await run(`DROP TABLE ${q(temporalName)}`)
    }
    if (config.engine === 'sqlite') {
      const storage = name + '_storage'
      await run(`CREATE TABLE ${q(storage)} (id INTEGER PRIMARY KEY,value NUMERIC); INSERT INTO ${q(storage)} VALUES(1,1.0000000000000002)`)
      const before = await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: storage } })
      await run(`UPDATE ${q(storage)} SET value=1.0000000000000004`, b.id)
      expect((await apply(before.grid!, [{ kind: 'delete', row: 0 }])).error).toMatch(/Concurrency conflict/)
      await run(`UPDATE ${q(storage)} SET value=X'0102'`, b.id)
      expect((await driver.editGrid({ action: 'open', sessionId: a.id, table: { ...table, name: storage } })).error).toMatch(/binary storage/)
      await run(`DROP TABLE ${q(storage)}`)
    }
    if (embedded) {
      await driver.disconnect(a.id); await driver.disconnect(b.id)
      const ro = await driver.connect({ ...local, sqliteMode: 'read-only', duckdbMode: 'read-only' })
      expect((await driver.editGrid({ action: 'open', sessionId: ro.id, table })).error).toMatch(/read-only/)
      await driver.disconnect(ro.id)
    } else await run(`DROP TABLE ${q(name)}`)
  } finally { await driver.close(); rmSync(directory, { recursive: true, force: true }) }
}
