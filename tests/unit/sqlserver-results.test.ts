import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { Frame } from '../../src/driver/sqlserver-transport'

vi.mock('../../src/driver/sqlserver-transport', () => ({ openSqlServer: vi.fn(), sqlServerQuery: vi.fn(), sqlServerBound: vi.fn(), streamSqlServer: vi.fn() }))
import { openSqlServer, sqlServerQuery, streamSqlServer } from '../../src/driver/sqlserver-transport'
import { SqlServerDriver } from '../../src/driver/sqlserver'

afterEach(() => vi.resetAllMocks())
async function execute(engine: 'sqlserver' | 'azure-sql', frames: Frame[]) {
  const connection = Object.assign(new EventEmitter(), { close: vi.fn() })
  vi.mocked(openSqlServer).mockResolvedValue(connection as any)
  vi.mocked(sqlServerQuery).mockImplementation(async (_connection, sql) => sql.startsWith('SELECT @@VERSION') ? [['SQL Server', '41']] : [['0', '0', 'test']])
  vi.mocked(streamSqlServer).mockReturnValue({ cancel() {}, frames: (async function* () { yield* frames })() })
  const events: DatabaseEvent[] = [], driver = new SqlServerDriver(event => { events.push(event) }, engine)
  try {
    const session = await driver.connect({ engine } as ConnectionConfig)
    driver.start({ sessionId: session.id, sql: 'DECLARE @answer int=42; SELECT @answer', maxRows: 100 })
    await driver.wait(session.id)
    expect(events.at(-1)).toMatchObject({ type: 'complete', status: 'completed' })
    return events
  } finally { await driver.close() }
}
for (const engine of ['sqlserver', 'azure-sql'] as const) {
  it(`${engine}: count-only completions cannot hide a SELECT result or create phantom result tabs`, async () => {
    const events = await execute(engine, [
      { kind: 'done', count: 1 },
      { kind: 'fields', columns: [{ name: 'answer', typeId: 56 }] },
      { kind: 'row', row: ['42'] }, { kind: 'done', count: 1 },
      { kind: 'done', count: 2 },
      { kind: 'fields', columns: [{ name: 'empty', typeId: 56 }] }, { kind: 'done', count: 0 }
    ])
    const results = [...new Map(events.flatMap(event => event.type === 'result' ? [[event.result.index, event.result] as const] : [])).values()]
    expect(results.map(result => [result.index, result.columns[0].name, result.rowCount])).toEqual([[0, 'answer', 1], [1, 'empty', 0]])
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : [])).toEqual([['42']])
    expect(events.flatMap(event => event.type === 'notice' ? [event.message] : [])).toEqual(['1 row affected.', '2 rows affected.'])
  })
  it(`${engine}: DML-only batches preserve zero and nonzero row counts as messages`, async () => {
    const events = await execute(engine, [{ kind: 'done', count: 0 }, { kind: 'done', count: 3 }])
    expect(events.filter(event => event.type === 'result')).toHaveLength(0)
    expect(events.flatMap(event => event.type === 'notice' ? [event.message] : [])).toEqual(['0 rows affected.', '3 rows affected.'])
  })
}
