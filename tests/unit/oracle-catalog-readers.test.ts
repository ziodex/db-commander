import { afterEach, expect, it, vi } from 'vitest'
import oracledb from 'oracledb'
import { OracleDriver } from '../../src/driver/oracle'
import { connectionSchema, type Cell } from '../../src/shared/contracts'
import type { CatalogObject } from '../../src/shared/catalog'

// The wire date decoder has separate tests; these fake readers have no TTC wire.
vi.mock('../../src/driver/oracle-values', () => ({ enableExactOracleDates: vi.fn() }))

const object: CatalogObject = { schema: 'SQLCOMMANDER', name: 'sample', kind: 'table', identity: '42' }
const ddl = 'CREATE TABLE "SQLCOMMANDER"."sample" ("id" NUMBER PRIMARY KEY)'
const config = connectionSchema.parse({ engine: 'oracle', name: 'Oracle', host: 'localhost', port: 1521, database: 'FREEPDB1', user: 'SQLCOMMANDER', password: '', tls: 'disable' })
const drivers: OracleDriver[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function reader(read?: (sql: string, values?: Cell[]) => unknown[][] | Promise<unknown[][]>) {
  const client = {
    protocol: 'TCP', serviceName: 'FREEPDB1', oracleServerVersionString: '23', callTimeout: 0,
    execute: vi.fn(async (sql: string, values?: Cell[]) => {
      if (sql.includes('SYS_CONTEXT')) return { rows: [['1:123']] }
      if (sql.startsWith('ALTER SESSION') || sql.includes('DBMS_OUTPUT.ENABLE')) return { rows: [] }
      if (read) return { rows: await read(sql, values) }
      if (sql.includes('FROM user_objects')) return { rows: [[null, object.schema, object.name, object.kind, object.identity, null, null]] }
      if (sql.includes('FROM user_tab_cols')) return { rows: [['id', 'NUMBER', '22', null, null, 'N', null, 'NO', 'NO']] }
      if (sql.includes('DBMS_METADATA.GET_DDL')) return { rows: [[ddl]] }
      return { rows: [] }
    }),
    close: vi.fn(async () => {})
  }
  return client
}
const asConnection = (client: ReturnType<typeof reader>) => client as unknown as oracledb.Connection
async function connected(primary = reader(), secondary = reader()) {
  const console = reader(), getConnection = vi.spyOn(oracledb as unknown as { getConnection(options: oracledb.ConnectionAttributes): Promise<oracledb.Connection> }, 'getConnection')
    .mockResolvedValueOnce(asConnection(console)).mockResolvedValueOnce(asConnection(primary)).mockResolvedValueOnce(asConnection(secondary))
  const driver = new OracleDriver(() => {}); drivers.push(driver)
  const session = await driver.connect(config)
  return { driver, session, console, primary, secondary, getConnection }
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map(driver => driver.close()))
  vi.restoreAllMocks()
})

it('overlaps full native DDL with metadata on isolated readers and drains the bounded LOB before closing', async () => {
  const data = deferred<string>(), lob = { getData: vi.fn(() => data.promise), close: vi.fn(async () => {}) }
  const secondary = reader(sql => sql.includes('DBMS_METADATA.GET_DDL') ? [[lob]] : [])
  const { driver, session, primary, console, getConnection } = await connected(undefined, secondary)
  const inspection = driver.explore(session.id, object)
  await vi.waitFor(() => expect(primary.execute.mock.calls.some(([sql]) => sql.includes('FROM user_triggers'))).toBe(true))
  expect(lob.getData).toHaveBeenCalledWith(1, 1_000_001)
  expect(secondary.execute.mock.calls.find(([sql]) => sql.includes('DBMS_METADATA.GET_DDL'))?.[1]).toEqual(['TABLE', 'sample', 'SQLCOMMANDER'])
  expect(primary.execute.mock.calls.some(([sql]) => sql.includes('DBMS_METADATA'))).toBe(false)
  expect(console.execute.mock.calls.some(([sql]) => sql.includes('user_') || sql.includes('DBMS_METADATA'))).toBe(false)
  expect(primary.close).not.toHaveBeenCalled(); expect(secondary.close).not.toHaveBeenCalled()
  data.resolve(ddl)
  const result = await inspection
  expect(result.detail?.definition).toMatchObject({ source: 'native', sql: ddl, truncated: false })
  expect(result.detail?.sections.find(section => section.title === 'Columns')?.rows[0]).toEqual(['id', 'NUMBER', '22', null, null, 'N', null, 'NO', 'NO'])
  expect(result.detail?.sections.map(section => section.title)).toEqual(['Columns', 'Identity columns', 'Constraints and keys', 'Key columns', 'Foreign keys', 'Indexes', 'Triggers'])
  expect(getConnection).toHaveBeenCalledTimes(3)
  expect(lob.close).toHaveBeenCalledOnce(); expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce()
  expect(console.close).not.toHaveBeenCalled()
  expect(secondary.callTimeout).toBeLessThanOrEqual(10000)
})

it('retains serial inspection when the optional reader cannot connect, without reconnecting the console', async () => {
  const { driver, session, primary, console, getConnection } = await connected()
  getConnection.mockReset().mockResolvedValueOnce(asConnection(primary)).mockRejectedValueOnce(new Error('ORA-02391: simultaneous SESSIONS_PER_USER limit exceeded'))
  expect((await driver.explore(session.id, object)).detail?.definition.sql).toBe(ddl)
  const sql = primary.execute.mock.calls.map(([sql]) => sql)
  expect(sql.findIndex(sql => sql.includes('DBMS_METADATA'))).toBeGreaterThan(sql.findIndex(sql => sql.includes('FROM user_triggers')))
  expect(getConnection).toHaveBeenCalledTimes(2)
  expect(primary.close).toHaveBeenCalledOnce(); expect(console.close).not.toHaveBeenCalled()
})

it('closes a partially initialized optional reader before falling back to serial inspection', async () => {
  const secondary = reader()
  secondary.execute.mockRejectedValueOnce(new Error('session initialization failed'))
  const { driver, session, primary, console, getConnection } = await connected(undefined, secondary)
  expect((await driver.explore(session.id, object)).detail?.definition.sql).toBe(ddl)
  expect(getConnection).toHaveBeenCalledTimes(3)
  expect(secondary.close).toHaveBeenCalledOnce(); expect(primary.close).toHaveBeenCalledOnce(); expect(console.close).not.toHaveBeenCalled()
})

it('enforces one inspection deadline across both readers and closes them on expiry', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const primary = reader(sql => {
    if (sql.includes('FROM user_objects')) { clock.mockReturnValue(46001); return [[null, object.schema, object.name, object.kind, object.identity, null, null]] }
    throw new Error('Expired metadata calls must not reach the server')
  })
  const { driver, session, secondary } = await connected(primary)
  await expect(driver.explore(session.id, object)).rejects.toThrow('Oracle metadata inspection timed out')
  expect(primary.execute.mock.calls.some(([sql]) => sql.includes('FROM user_tab_cols'))).toBe(false)
  expect(secondary.execute.mock.calls.some(([sql]) => sql.includes('DBMS_METADATA'))).toBe(false)
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce()
})

it('drains the other query after a section failure and closes both temporary readers', async () => {
  const data = deferred<unknown[][]>(), secondary = reader(sql => sql.includes('DBMS_METADATA') ? data.promise : [])
  const primary = reader(sql => {
    if (sql.includes('FROM user_objects')) return [[null, object.schema, object.name, object.kind, object.identity, null, null]]
    throw new Error('section read failed')
  })
  const { driver, session } = await connected(primary, secondary)
  let settled = false
  const inspection = driver.explore(session.id, object).finally(() => { settled = true })
  await vi.waitFor(() => expect(primary.execute.mock.calls.some(([sql]) => sql.includes('FROM user_tab_cols'))).toBe(true))
  expect(settled).toBe(false); expect(primary.close).not.toHaveBeenCalled(); expect(secondary.close).not.toHaveBeenCalled()
  data.resolve([[ddl]])
  await expect(inspection).rejects.toThrow('section read failed')
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce()
})

it('reports native DDL failure while retaining metadata sections and closing both readers', async () => {
  const secondary = reader(async () => { throw new Error('metadata access denied') })
  const { driver, session, primary } = await connected(undefined, secondary)
  const result = await driver.explore(session.id, object)
  expect(result.detail?.definition).toMatchObject({ source: 'unavailable', notice: 'Definition unavailable: metadata access denied' })
  expect(result.detail?.sections.find(section => section.title === 'Columns')?.rows).toHaveLength(1)
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce()
})

it('rejects forged object scopes before native DDL and closes both readers', async () => {
  const { driver, session, primary, secondary } = await connected()
  await expect(driver.explore(session.id, { ...object, schema: 'OTHER_OWNER' })).rejects.toThrow('no longer visible')
  expect(secondary.execute.mock.calls.some(([sql]) => sql.includes('DBMS_METADATA'))).toBe(false)
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce()
})

it.each(['catalog', 'materialized view', 'constraint'] as const)('uses one metadata reader for %s', async kind => {
  const primary = reader(sql => {
    if (sql.includes('FROM user_objects')) return [[null, object.schema, object.name, kind, object.identity, null, null]]
    if (sql.includes('DBMS_METADATA')) return [[ddl]]
    return []
  })
  const { driver, session, secondary, getConnection } = await connected(primary)
  await driver.explore(session.id, kind === 'catalog' ? undefined : { ...object, kind })
  expect(getConnection).toHaveBeenCalledTimes(2)
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.execute).not.toHaveBeenCalled(); expect(secondary.close).not.toHaveBeenCalled()
})

it('attempts both reader closes even when the first close throws synchronously', async () => {
  const { driver, session, primary, secondary, console } = await connected()
  primary.close.mockImplementation(() => { throw new Error('close failed') })
  await expect(driver.explore(session.id, object)).rejects.toThrow('close failed')
  expect(primary.close).toHaveBeenCalledOnce(); expect(secondary.close).toHaveBeenCalledOnce(); expect(console.close).not.toHaveBeenCalled()
})
