import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { WorkspaceStore } from '../../src/storage/store'
import { SnippetExchange } from '../../src/storage/snippet-exchange'
import { readSnippetFile, writeSnippetFile } from '../../src/files/snippet-files'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'

export async function verifySnippetExchange(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-snippet-contract-')), events: DatabaseEvent[] = []
  const source = new WorkspaceStore(join(directory, 'source.sqlite')), target = new WorkspaceStore(join(directory, 'target.sqlite'))
  const exporting = new SnippetExchange(source), importing = new SnippetExchange(target)
  const driver = new DriverRegistry(e => { events.push(e) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  if (['sqlite', 'duckdb'].includes(config.engine)) config = { ...config, filePath: join(directory, 'database.db'), sqliteMode: 'create', duckdbMode: 'create' }
  const q = (s: string) => quoteIdentifier(s, config.engine), table = q('snip_' + randomUUID().slice(0, 8)), tds = ['sqlserver', 'azure-sql'].includes(config.engine)
  let id: string | undefined
  async function run(sql: string, parameters?: QueryParameter[]) {
    const queryId = driver.start({ sessionId: id!, sql, parameters, maxRows: 100 }); await driver.wait(id!)
    const complete = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(complete.status, complete.error).toBe('completed')
    return { queryId, rows: events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : []) }
  }
  try {
    id = (await driver.connect(config)).id
    await run(`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY, ${q('value')} INTEGER)`)
    await run(`INSERT INTO ${table} VALUES(1,10)`); if (config.engine === 'oracle') await run('COMMIT')
    const sql = `-- Reusable Ω lookup\nSELECT :label AS ${q('label')}, :exact AS ${q('exact')}, ${q('value')} FROM ${table} WHERE ${q('id')}=:id`
    const saved = source.saveSnippet({ name: 'Lookup Ω', description: 'Round trip through a portable file', sql, favorite: true, engine: config.engine })
    const dangerous = source.saveSnippet({ name: 'Delete rows', description: 'Store only; never run on import', sql: `DELETE FROM ${table}`, favorite: false, engine: config.engine })
    await run(config.engine === 'oracle' ? 'SAVEPOINT SNIPPET_TEST' : tds ? 'BEGIN TRANSACTION' : 'BEGIN')
    await run(`UPDATE ${table} SET ${q('value')}=11`)
    const retained = await run(`SELECT ${q('value')} FROM ${table}`), before = events.length, session = driver.getSession(id)
    const path = join(directory, 'library.json'); await writeSnippetFile(path, exporting.export([saved.id, dangerous.id]))
    const review = importing.review(await readSnippetFile(path))
    expect(target.snippets()).toHaveLength(0)
    expect(importing.apply({ reviewId: review.reviewId, selected: [0, 1], duplicates: 'skip' })).toEqual({ imported: 2, skipped: 0 })
    expect(events.length).toBe(before); expect(driver.getSession(id)).toEqual(session); expect(session.transaction).toBe('transaction')
    const cached = join(directory, 'retained.csv'); await driver.exportCsv(retained.queryId, 0, cached); expect(readFileSync(cached, 'utf8')).toContain('"11"')
    expect(target.snippets().find(s => s.name === 'Lookup Ω')).toMatchObject({ sql, engine: config.engine, favorite: true })
    expect(target.snippets().some(s => s.id === saved.id)).toBe(false)
    const duplicates = importing.review(await readSnippetFile(path))
    expect(importing.apply({ reviewId: duplicates.reviewId, selected: [0, 1], duplicates: 'skip' })).toEqual({ imported: 0, skipped: 2 })
    expect((await run(`SELECT ${q('value')} FROM ${table}`)).rows).toEqual([['11']]); await run('ROLLBACK')
    const secret = "bound-only O'Brien Ω ; DELETE FROM customers; --"
    const loaded = target.snippets().find(s => s.name === 'Lookup Ω')!
    expect((await run(loaded.sql, [{ name: 'label', type: 'text', value: secret }, { name: 'exact', type: 'integer', value: '9223372036854775807' }, { name: 'id', type: 'integer', value: '1' }])).rows).toEqual([[secret, '9223372036854775807', '10']])
    const roundTrip = new SnippetExchange(target).export([loaded.id]); expect(roundTrip.snippets[0]).toEqual(exporting.export([saved.id]).snippets[0])
    expect(JSON.stringify(roundTrip)).not.toContain(secret); if (config.password) expect(JSON.stringify(roundTrip)).not.toContain(config.password)
    expect(source.history()).toEqual([]); expect(target.history()).toEqual([])
    await run(`DROP TABLE ${table}`)
  } finally {
    if (id) { try { await run('ROLLBACK'); await run(`DROP TABLE ${table}`) } catch {} }
    await driver.close(); source.close(); target.close(); rmSync(directory, { recursive: true, force: true })
  }
}
