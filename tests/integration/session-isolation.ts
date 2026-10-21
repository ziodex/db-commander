import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DriverRegistry } from '../../src/driver/registry'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'

/** Called by every real-engine suite, including both MySQL-family transports. */
export async function verifySessionIsolation(config: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-sessions-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const local = config.engine === 'sqlite' ? { ...config, sqliteMode: 'memory' as const } : config.engine === 'duckdb' ? { ...config, duckdbMode: 'memory' as const } : config
  const select = (n: number) => `SELECT ${n} AS owner${config.engine === 'oracle' ? ' FROM dual' : ''}`
  try {
    const a = await driver.connect(local), b = await driver.connect(local)
    expect(a.id).not.toBe(b.id)
    async function run(id: string, sql: string) {
      const queryId = randomUUID()
      expect(driver.start({ sessionId: id, queryId, sql, maxRows: 10 })).toBe(queryId)
      await driver.wait(id)
      const complete = events.find(event => event.type === 'complete' && event.queryId === queryId)
      expect(complete).toMatchObject({ status: 'completed' }); return queryId
    }
    const begin = config.engine === 'oracle' ? 'SAVEPOINT SQLCOMMANDER_TABS' : config.engine === 'sqlserver' ? 'BEGIN TRANSACTION' : 'BEGIN'
    await run(a.id, begin)
    expect(driver.getSession(a.id).transaction).toBe('transaction'); expect(driver.getSession(b.id).transaction).toBe('idle')
    const qa = randomUUID(), qb = randomUUID()
    driver.start({ sessionId: a.id, queryId: qa, sql: select(111), maxRows: 1 })
    driver.start({ sessionId: b.id, queryId: qb, sql: select(222), maxRows: 1 })
    await Promise.all([driver.wait(a.id), driver.wait(b.id)])
    expect(events.flatMap(event => event.type === 'rows' && event.queryId === qa ? event.rows : [])).toEqual([['111']])
    expect(events.flatMap(event => event.type === 'rows' && event.queryId === qb ? event.rows : [])).toEqual([['222']])
    for (const [id, value] of [[qa, '111'], [qb, '222']]) {
      const file = join(directory, `${id}.csv`); await driver.exportCsv(id, 0, file)
      expect(readFileSync(file, 'utf8')).toContain(`"${value}"\r\n`)
    }
    const next = await run(b.id, select(333))
    await expect(driver.exportCsv(qa, 0, join(directory, 'a.csv'))).resolves.toBeUndefined()
    expect(() => driver.exportCsv(qb, 0, join(directory, 'old.csv'))).toThrow('no longer available')
    expect(driver.getSession(a.id).transaction).toBe('transaction')
    await run(a.id, 'ROLLBACK'); await driver.disconnect(a.id)
    await expect(driver.exportCsv(next, 0, join(directory, 'b.csv'))).resolves.toBeUndefined()
    await driver.disconnect(b.id)
    expect(() => driver.exportCsv(next, 0, join(directory, 'closed.csv'))).toThrow('no longer available')
  } finally { await driver.close(); rmSync(directory, { recursive: true, force: true }) }
}
