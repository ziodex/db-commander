import { describe, expect, it } from 'vitest'
import { Connection } from 'tedious'
import parser from 'tedious/lib/value-parser'
import { NotEnoughDataError } from 'tedious/lib/token/helpers'
import { splitSqlServerBatches } from '../../src/shared/sql/sqlserver'
import { quoteIdentifier, tablePreviewSql } from '../../src/shared/sql/common'
import { decimalText, enableExactTdsValues, exactTdsValue } from '../../src/driver/sqlserver-values'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'
import { connectionSchema, legacyWorkspaceSchema as workspaceSchema } from '../../src/shared/contracts'

const config = connectionSchema.parse({ engine: 'azure-sql', name: 'Azure', host: 'example.database.windows.net', port: 1433, database: 'app', user: 'user', password: 'secret', tls: 'verify-full' })
function little(value: bigint, length: number) { const bytes = Buffer.alloc(length); for (let i = 0; i < length; i++) { bytes[i] = Number(value & 255n); value >>= 8n }; return bytes }
function decode(name: string, bytes: Buffer, scale?: number) { return exactTdsValue(bytes, 0, { type: { name }, scale }) }

describe('T-SQL batch boundaries and generated SQL', () => {
  it('preserves variable scope, semicolons and procedures within batches', () => {
    expect(splitSqlServerBatches('DECLARE @n int=1; SELECT @n;\nGO\nCREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END;\nGO 2 -- repeat\n')).toEqual(['DECLARE @n int=1; SELECT @n;', 'CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END;', 'CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END;'])
  })
  it('ignores GO inside strings, quoted identifiers, and nested comments', () => {
    const sql = "SELECT 'one\nGO\ntwo', [a]]\nGO\nb], \"c\nGO\nd\";\n/* outer\n/* inner */\nGO\n*/\n-- GO\n"
    expect(splitSqlServerBatches(sql + 'go\r\nSELECT 2')).toEqual([sql.trim(), 'SELECT 2'])
    expect(splitSqlServerBatches('-- comment\n/*empty*/; GO\n')).toHaveLength(1)
    expect(splitSqlServerBatches('-- comment\n/*empty*/;\nGO\n')).toEqual([])
  })
  it('rejects malformed scripts and unbounded/client-side commands', () => {
    for (const sql of ["SELECT 'bad", 'SELECT [bad', '/*bad', 'SELECT 1\nGO 0', 'SELECT 1\nGO -1', 'SELECT 1\nGO 201', ':r secret.sql', '!! echo nope', 'SELECT 1\nGO 200\nSELECT 2']) expect(() => splitSqlServerBatches(sql)).toThrow()
  })
  it('quotes bracket escapes and uses TOP for both engines', () => {
    for (const engine of ['sqlserver', 'azure-sql'] as const) {
      expect(quoteIdentifier('x]y', engine)).toBe('[x]]y]')
      expect(tablePreviewSql('dbo', 'x]y', engine)).toBe('SELECT TOP (1000) *\nFROM [dbo].[x]]y];')
    }
  })
})
describe('SQL Server authentication and credential boundaries', () => {
  it('requires verified Azure TLS and validates token authentication', () => {
    expect(() => buildSqlServerConfig({ ...config, tls: 'disable' })).toThrow('requires verified TLS')
    expect(() => buildSqlServerConfig({ ...config, authentication: 'entra-token' })).toThrow('access token')
    expect(() => buildSqlServerConfig({ ...config, engine: 'sqlserver', authentication: 'entra-token', accessToken: 'token' })).toThrow()
    const options = buildSqlServerConfig(config)
    expect(options.authentication).toEqual({ type: 'default', options: { userName: 'user', password: 'secret' } })
    expect(options.options).toMatchObject({ encrypt: true, trustServerCertificate: false, serverName: config.host, requestTimeout: 0, maxRetriesOnTransientErrors: 0 })
    expect(buildSqlServerConfig({ ...config, authentication: 'entra-token', accessToken: 'token' }).authentication).toEqual({ type: 'azure-active-directory-access-token', options: { token: 'token' } })
  })
  it('rejects passwords and access tokens in saved profiles', () => {
    const { password: _password, ...profile } = config
    expect(workspaceSchema.safeParse({ sql: '', profile }).success).toBe(true)
    expect(workspaceSchema.safeParse({ sql: '', profile: config }).success).toBe(false)
    expect(workspaceSchema.safeParse({ sql: '', profile: { ...profile, accessToken: 'private-token' } }).success).toBe(false)
  })
})
describe('exact TDS values (pinned Tedious compatibility contract)', () => {
  it('retains 38-digit decimals, signs, scale and nullable values', () => {
    const magnitude = 12345678901234567890123456789012345678n
    for (const [sign, prefix] of [[1, ''], [0, '-']] as const) {
      const bytes = Buffer.concat([Buffer.from([17, sign]), little(magnitude, 16)])
      expect(decode('NumericN', bytes, 18)).toEqual({ value: prefix + '12345678901234567890.123456789012345678', offset: 18 })
      for (let length = 0; length < bytes.length; length++) expect(() => decode('NumericN', bytes.subarray(0, length), 18)).toThrow(NotEnoughDataError)
    }
    expect(decimalText(-5n, 4)).toBe('-0.0005')
    expect(decode('DecimalN', Buffer.from([0]), 18)).toEqual({ value: null, offset: 1 })
  })
  it('retains maximum money and negative smallmoney', () => {
    const money = Buffer.alloc(9); money[0] = 8; money.writeInt32LE(2147483647, 1); money.writeUInt32LE(4294967295, 5)
    expect(decode('MoneyN', money)?.value).toBe('922337203685477.5807')
    const small = Buffer.alloc(5); small[0] = 4; small.writeInt32LE(-12345, 1)
    expect(decode('MoneyN', small)?.value).toBe('-1.2345')
  })
  it('retains temporal scale, offsets and date boundaries without a JS Date roundtrip', () => {
    const days = BigInt((Date.parse('2026-10-12T00:00:00Z') - Date.parse('0001-01-01T00:00:00Z')) / 86400000)
    const units = 452961234567n
    expect(decode('Time', Buffer.concat([Buffer.from([5]), little(units, 5)]), 7)?.value).toBe('12:34:56.1234567')
    expect(decode('DateTime2', Buffer.concat([Buffer.from([8]), little(units, 5), little(days, 3)]), 7)?.value).toBe('2026-10-12 12:34:56.1234567')
    const offset = Buffer.alloc(2); offset.writeInt16LE(330)
    expect(decode('DateTimeOffset', Buffer.concat([Buffer.from([10]), little(units - 330n * 60n * 10000000n, 5), little(days, 3), offset]), 7)?.value).toBe('2026-10-12 12:34:56.1234567+05:30')
    offset.writeInt16LE(-60)
    expect(decode('DateTimeOffset', Buffer.concat([Buffer.from([10]), little(0n, 5), little(days, 3), offset]), 7)?.value).toBe('2026-10-11 23:00:00.0000000-01:00')
    expect(decode('Date', Buffer.from([3, 0, 0, 0]))?.value).toBe('0001-01-01')
    expect(decode('Time', Buffer.from([3, 1, 0, 0]), 0)?.value).toBe('00:00:01')
  })
  it('decodes exact SQL_VARIANT decimals and delegates unrelated types', () => {
    const bytes = Buffer.concat([little(21n, 4), Buffer.from([106, 2, 38, 18, 1]), little(12345678901234567890123456789012345678n, 16)])
    expect(decode('Variant', bytes)?.value).toBe('12345678901234567890.123456789012345678')
    expect(decode('Int', Buffer.from([1, 0, 0, 0]))).toBeUndefined()
  })
  it('hooks the real Tedious parser only for Db Commander connections', () => {
    const connection = new Connection(buildSqlServerConfig(config))
    const originalOptions = { ...connection.config.options }
    enableExactTdsValues(connection)
    const bytes = Buffer.concat([Buffer.from([9, 1]), little(12345n, 8)])
    const metadata = { type: { name: 'NumericN' }, scale: 4 } as Parameters<typeof parser.readValue>[2]
    expect(parser.readValue(bytes, 0, metadata, connection.config.options).value).toBe('1.2345')
    expect(parser.readValue(bytes, 0, metadata, originalOptions).value).toBe(1.2345)
    connection.close()
  })
})
