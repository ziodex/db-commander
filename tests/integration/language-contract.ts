import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { completeSql } from '../../src/language/completion'
import { formatSql } from '../../src/language/format'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { DEFAULT_EDITOR_SETTINGS, resolveSqlFormatting } from '../../src/shared/editor-settings'
/** Real catalog -> suggestion -> execution, with formatter equivalence on every engine. */
export async function verifyLanguageTools(config: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const local = config.engine === 'sqlite' ? { ...config, sqliteMode: 'memory' as const } : config.engine === 'duckdb' ? { ...config, duckdbMode: 'memory' as const } : config
  const session = await driver.connect(local), suffix = randomUUID().replaceAll('-', '').slice(0, 10), name = `completion_${suffix}`, view = `view_${suffix}`
  const q = (name: string) => quoteIdentifier(name, config.engine)
  async function run(sql: string) {
    const queryId = driver.start({ sessionId: session.id, sql, maxRows: 100 })
    await driver.wait(session.id)
    expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  try {
    await run(formatSql(`create table ${q(name)} (${q('id')} integer not null, ${q('Display Name')} varchar(60))`, config.engine))
    await run(`insert into ${q(name)} values(17,'a''b -- c')`)
    if (config.engine === 'oracle') await run('COMMIT')
    await run(`create view ${q(view)} as select ${q('id')} from ${q(name)}`)
    const count = events.length, schema = await driver.schema(session.id)
    expect(schema.database).toBe(session.database)
    expect(events).toHaveLength(count) // Metadata is not a user execution or history entry.
    const object = schema.objects.find(object => object.name === name)!
    expect(object, config.engine).toBeDefined(); expect(object.columns.map(column => column.name)).toEqual(['id', 'Display Name'])
    expect(object.columns[0]).toMatchObject({ nullable: false }); expect(object.columns[0].type).toBeTruthy()
    expect(schema.objects.find(object => object.name === view)).toMatchObject({ kind: 'view' })
    expect(schema.objects.find(object => object.name === view)?.columns.map(column => column.name)).toEqual(['id'])
    const tableText = `select * from completion_`, table = completeSql(tableText, tableText.length, config.engine, schema).suggestions.find(item => item.label === name)!
    expect(table).toBeDefined()
    const sql = `select p. from ${table.insertText} p`, columns = completeSql(sql, sql.indexOf('p.') + 2, config.engine, schema).suggestions
    const column = columns.find(item => item.label === 'Display Name')!
    expect(column).toBeDefined()
    const query = `select p.${column.insertText},p.${q('id')} from ${table.insertText} p where p.${q('id')}=17`
    expect(await run(query)).toEqual([["a'b -- c", '17']]); expect(await run(formatSql(query, config.engine))).toEqual([["a'b -- c", '17']])
    const cte = `with x as (select ${q('id')} from ${table.insertText}) select x.${q('id')} from x`
    expect(await run(formatSql(cte, config.engine))).toEqual([['17']])
    // Saved style preferences must only affect layout, including in a native transaction.
    for (const useTabs of [false, true]) {
      const preferences = { expressionWidth: useTabs ? 20 : 120, linesBetweenQueries: useTabs ? 3 : 0 }
      const source = `${query};\n${cte};`
      const style = resolveSqlFormatting({ ...DEFAULT_EDITOR_SETTINGS, engineFormatting: {
        [config.engine]: { tabSize: 4, insertSpaces: !useTabs, formatting: preferences }
      } }, config.engine)
      expect(await run(formatSql(source, config.engine, style.tabSize, !style.insertSpaces, style.formatting))).toEqual([["a'b -- c", '17'], ['17']])
    }
    if (config.engine === 'sqlserver' || config.engine === 'azure-sql') expect(await run(formatSql('select 4 as n;\nGO 2\nselect 5 as n;', config.engine))).toEqual([['4'], ['4'], ['5']])
    await run(config.engine === 'oracle' ? 'SAVEPOINT COMPLETION_TEST' : ['sqlserver', 'azure-sql'].includes(config.engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    const transaction = driver.getSession(session.id).transaction
    expect(await run(formatSql(query, config.engine, 8, true, { expressionWidth: 20, linesBetweenQueries: 2 }))).toEqual([["a'b -- c", '17']])
    expect(driver.getSession(session.id).transaction).toBe(transaction)
    await driver.schema(session.id); expect(driver.getSession(session.id).transaction).toBe(transaction)
    await run('ROLLBACK')
    await run(`alter table ${q(name)} add ${q('new_column')} integer`)
    expect((await driver.schema(session.id)).objects.find(object => object.name === name)?.columns.map(column => column.name)).toContain('new_column')
    if (['sqlite', 'duckdb'].includes(config.engine)) {
      await run(`create temp table ${q('private_temp')} (${q('local_column')} int)`)
      const a = await driver.schema(session.id), b = await driver.connect(local)
      expect(a.objects.some(object => object.name === 'private_temp')).toBe(true)
      expect((await driver.schema(b.id)).objects.some(object => object.name === 'private_temp')).toBe(false)
      await driver.disconnect(b.id)
    }
    await run(`drop view ${q(view)}`); await run(`drop table ${q(name)}`)
    expect((await driver.schema(session.id)).objects.some(object => object.name === name || object.name === view)).toBe(false)
  } finally { await driver.close() }
}
