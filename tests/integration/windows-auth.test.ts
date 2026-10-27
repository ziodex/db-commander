import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { WindowsSqlServerConnection } from '../../src/driver/windows-sqlserver'
import { sqlServerBound, sqlServerQuery, streamSqlServer } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'

// Opt in only on a Windows machine whose current account has a SQL Server login.
// Every mutation below is confined to this connection's private temporary table.
const enabled = process.platform === 'win32' && process.env.SQLCOMMANDER_WINDOWS_AUTH_TEST === '1'
const config: ConnectionConfig = { engine: 'sqlserver', name: 'Windows authentication test', host: process.env.SQLCOMMANDER_WINDOWS_AUTH_HOST ?? 'localhost', port: Number(process.env.SQLCOMMANDER_WINDOWS_AUTH_PORT ?? 1433), database: 'master', user: '', password: '', authentication: 'windows', tls: 'disable' }
describe.skipIf(!enabled)('native Windows SQL Server provider', () => {
  let connection: WindowsSqlServerConnection
  beforeEach(async () => { connection = new WindowsSqlServerConnection(config, resolve('out/main')); await connection.connect() })
  afterEach(() => connection?.close())

  it('authenticates with the current account and preserves exact values and native parameters', async () => {
    expect(connection.user).toMatch(/\\/)
    const rows = await sqlServerQuery(connection, "SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id=@@SPID")
    expect(['NTLM', 'KERBEROS']).toContain(rows[0][0])
    const stream = streamSqlServer(connection, "SELECT CONVERT(decimal(38,18),@sc_p1),CONVERT(varbinary(max),@sc_p2),CONVERT(bigint,'9223372036854775807'),CONVERT(datetimeoffset(7),'2026-10-27T12:34:56.1234567+05:30'),N'日本語 😀',CAST(NULL AS int),CAST(1 AS bit); SELECT 42 AS second_result;", ['12345678901234567890.123456789012345678', Buffer.from([0, 255, 16])])
    const frames = []
    for await (const frame of stream.frames) frames.push(frame)
    expect(frames.filter(frame => frame.kind === 'fields')).toHaveLength(2)
    expect(frames.filter(frame => frame.kind === 'error')).toEqual([])
    expect(frames.filter(frame => frame.kind === 'row').map(frame => frame.row)).toEqual([
      ['12345678901234567890.123456789012345678', '0x00ff10', '9223372036854775807', '2026-10-27 12:34:56.1234567+05:30', '日本語 😀', null, '1'], ['42']
    ])
  })

  it('keeps transaction state, bound DML row counts, notices and database changes on one connection', async () => {
    const databases: string[] = []; connection.on('databaseChange', database => databases.push(database))
    await sqlServerBound(connection, 'CREATE TABLE #dbcommander_windows_auth(id int PRIMARY KEY, label nvarchar(100)); BEGIN TRANSACTION')
    expect((await sqlServerBound(connection, 'INSERT INTO #dbcommander_windows_auth VALUES(1,@p1)', ['Bound 日本語'])).affected).toBe(1)
    expect((await sqlServerBound(connection, 'SELECT label FROM #dbcommander_windows_auth WHERE id=@p1', ['1'])).rows).toEqual([['Bound 日本語']])
    expect(await sqlServerQuery(connection, 'SELECT @@TRANCOUNT')).toEqual([['1']])
    await sqlServerBound(connection, 'ROLLBACK')
    expect(await sqlServerQuery(connection, 'SELECT COUNT(*) FROM #dbcommander_windows_auth')).toEqual([['0']])
    await sqlServerBound(connection, 'USE tempdb')
    expect(databases.at(-1)).toBe('tempdb')
  })

  it('allows reuse after SQL errors and acknowledged cancellation', async () => {
    await expect(sqlServerQuery(connection, "THROW 50000, 'Expected authentication test error', 1")).rejects.toMatchObject({ code: 'EREQUEST' })
    expect(await sqlServerQuery(connection, 'SELECT 42')).toEqual([['42']])
    const stream = streamSqlServer(connection, "RAISERROR('cancel-ready',10,1) WITH NOWAIT; WAITFOR DELAY '00:00:10'; SELECT 99;")
    const errors: string[] = []
    for await (const frame of stream.frames) {
      if (frame.kind === 'notice' && frame.message.includes('cancel-ready')) stream.cancel()
      if (frame.kind === 'error') errors.push((frame.error as Error & { code: string }).code)
    }
    expect(errors).toEqual(['ECANCEL'])
    expect(await sqlServerQuery(connection, 'SELECT 43')).toEqual([['43']])
  })
})
