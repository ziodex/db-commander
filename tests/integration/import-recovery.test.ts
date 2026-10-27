import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { TableEditor, runGridOperation, type GridQuery } from '../../src/driver/table-editor'
import type { SessionInfo } from '../../src/shared/contracts'

const hooks = vi.hoisted(() => ({ unchanged: undefined as (() => void | Promise<void>) | undefined, close: undefined as (() => void | Promise<void>) | undefined }))
vi.mock('../../src/transfer/import', async original => {
  const actual = await original<typeof import('../../src/transfer/import')>()
  return { openImport: async (...args: Parameters<typeof actual.openImport>) => {
    const source = await actual.openImport(...args)
    return { ...source, unchanged: async () => { const result = await source.unchanged(); await hooks.unchanged?.(); return result }, close: async () => { await source.close(); await hooks.close?.() } }
  } }
})
afterEach(() => { hooks.unchanged = undefined; hooks.close = undefined })

async function fixture(engine: 'sqlite' | 'duckdb', format: 'csv' | 'json') {
  const directory = await mkdtemp(join(tmpdir(), `import-final-${engine}-`)), path = join(directory, `database.${engine}`), file = join(directory, `data.${format}`)
  let sqlite: DatabaseSync | undefined, instance: DuckDBInstance | undefined, client: DuckDBConnection | undefined, failRollback = false
  const open = async () => { if (engine === 'sqlite') sqlite = new DatabaseSync(path); else { instance = await DuckDBInstance.create(path); client = await instance.connect() } }
  const close = () => { sqlite?.close(); sqlite = undefined; client?.closeSync(); client = undefined; instance?.closeSync(); instance = undefined }
  const query: GridQuery = async (sql, values = []) => {
    if (failRollback && sql === 'ROLLBACK') throw new Error('Fixture rollback unavailable')
    if (sqlite) {
      const statement = sqlite.prepare(sql); statement.setReadBigInts(true); statement.setReturnArrays(true)
      if (statement.columns().length) return { rows: (statement.all(...values) as unknown as unknown[][]).map(row => row.map(value => value === null ? null : String(value))), affected: 0 }
      return { rows: [], affected: Number(statement.run(...values).changes) }
    }
    const result = await client!.runAndReadAll(sql, values.length ? values : undefined)
    return { rows: result.getRows().map(row => row.map(value => value === null ? null : String(value))), affected: result.rowsChanged }
  }
  try {
    await open(); await query('CREATE TABLE target(id INTEGER PRIMARY KEY, label VARCHAR NOT NULL)'); await query("INSERT INTO target VALUES(1,'baseline')")
    const info: SessionInfo = { id: randomUUID(), engine, database: engine === 'duckdb' ? 'database' : 'local', name: 'Import recovery', user: 'local', host: 'local', port: 0, tls: false, transaction: 'idle', autocommit: true, version: '' }
    if (engine === 'duckdb') info.database = (await query('SELECT current_database()')).rows[0][0]!
    const editor = new TableEditor(engine, query)
    const refresh = async () => {
      const active = sqlite ? sqlite.isTransaction : (await query('SELECT system.main.current_transaction_id()')).rows[0][0] === (await query('SELECT system.main.current_transaction_id()')).rows[0][0]
      info.transaction = active ? 'transaction' : 'idle'; info.autocommit = !active
    }
    const invoke = (request: Parameters<typeof runGridOperation>[1], controller?: AbortController) => runGridOperation(editor, request, info, refresh, controller ? { signal: controller.signal, progress() {} } : undefined)
    const source = { sessionId: info.id, table: { schema: 'main', name: 'target' }, file, format }
    const write = (rows = [['2', 'imported Ω']]) => writeFile(file, format === 'json' ? JSON.stringify({ columns: [{ name: 'id' }, { name: 'label' }], rows }) : 'id,label\n' + rows.map(row => row.join(',') + '\n').join(''))
    const preview = async () => {
      const result = await invoke({ ...source, action: 'inspect-import' })
      expect(result.error).toBeUndefined(); expect(result.importPreview).toBeDefined()
      return { ...source, action: 'import' as const, mapping: ['id', 'label'], signature: result.importPreview!.signature, confirmed: true as const }
    }
    await write()
    return { info, query, invoke, preview, write, failRollback: () => { failRollback = true }, async reopen() { close(); await open(); await refresh() }, async dispose() { close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { close(); await rm(directory, { recursive: true, force: true }); throw error }
}

for (const engine of ['sqlite', 'duckdb'] as const) for (const format of ['csv', 'json'] as const) for (const fault of ['cancel-validation', 'cancel-close', 'close-error', 'rollback-and-close-error', 'mapping-and-close-error', 'success'] as const) it(`import recovery ${engine} ${format}: ${fault} preserves transaction outcome and permits explicit retry`, async () => {
  const f = await fixture(engine, format), controller = new AbortController()
  try {
    if (fault === 'rollback-and-close-error') await f.write([['2', 'partial'], ['1', 'duplicate']])
    const request = await f.preview()
    if (fault === 'mapping-and-close-error') request.mapping = ['id', 'id']
    if (fault === 'cancel-validation') hooks.unchanged = () => controller.abort(new Error('Cancelled during final source validation'))
    if (fault === 'cancel-close') hooks.close = () => controller.abort(new Error('Cancelled during source close'))
    if (fault === 'close-error' || fault === 'rollback-and-close-error' || fault === 'mapping-and-close-error') hooks.close = () => { throw new Error('Fixture source close failed') }
    if (fault === 'rollback-and-close-error') f.failRollback()
    const result = await f.invoke(request, controller)
    if (fault === 'success') {
      expect(result).toMatchObject({ imported: 1, session: { transaction: 'transaction' } }); expect(result.error).toBeUndefined()
      await f.query('COMMIT'); await f.reopen()
      expect((await f.query('SELECT id,label FROM target ORDER BY id')).rows).toEqual([['1', 'baseline'], ['2', 'imported Ω']])
      return
    }
    expect(result.imported).toBeUndefined()
    if (fault === 'rollback-and-close-error') {
      expect(result.error).toMatch(/Rollback could not be confirmed.*outcome is unknown/)
      expect(f.info.transaction).toBe(engine === 'sqlite' ? 'transaction' : 'unknown')
      // Leave an unconfirmed transaction for explicit reconnect. DuckDB's
      // aborted transaction also prevents the ordinary state probe from running.
    } else if (fault === 'mapping-and-close-error') {
      expect(result.error).toContain('Choose unique target columns')
      expect(result.error).not.toContain('rolled back')
      expect(f.info.transaction).toBe('idle')
    } else {
      expect(result.error).toContain(fault === 'close-error' ? 'Fixture source close failed' : 'Cancelled during')
      expect(result.error).toContain('entire import was rolled back')
      expect(f.info.transaction).toBe('idle')
    }
    hooks.unchanged = undefined; hooks.close = undefined
    // Closing an unknown-outcome connection is explicit here, never a replay.
    await f.reopen()
    expect((await f.query('SELECT id,label FROM target ORDER BY id')).rows).toEqual([['1', 'baseline']])
    await f.write()
    const retry = await f.invoke(await f.preview(), new AbortController())
    expect(retry).toMatchObject({ imported: 1, session: { transaction: 'transaction' } }); expect(retry.error).toBeUndefined()
    await f.query('COMMIT'); await f.reopen()
    expect((await f.query('SELECT id,label FROM target ORDER BY id')).rows).toEqual([['1', 'baseline'], ['2', 'imported Ω']])
  } finally { await f.dispose() }
})
