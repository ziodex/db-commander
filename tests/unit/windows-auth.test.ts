import { expect, it } from 'vitest'
import { connectionSchema, profileSchema, type ConnectionConfig } from '../../src/shared/contracts'
import { passwordEligible } from '../../src/shared/credentials'
import { windowsSqlServerConfig } from '../../src/driver/windows-sqlserver'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'
import { routed } from '../../src/connections/transport'

const config: ConnectionConfig = { engine: 'sqlserver', name: 'Windows login', host: 'server.example', port: 1433, database: '', user: '', password: '', authentication: 'windows', tls: 'verify-full' }

it('saves Windows profiles without a database user or password and excludes them from the vault', () => {
  expect(connectionSchema.parse(config)).toEqual(config)
  const { password: _password, ...profile } = config
  expect(profileSchema.parse(profile)).toEqual(profile)
  expect(passwordEligible(profile)).toBe(false)
  expect(connectionSchema.safeParse({ ...config, authentication: 'sql-password' }).success).toBe(false)
  for (const engine of ['postgres', 'azure-sql', 'mysql', 'sqlite'] as const) {
    expect(connectionSchema.safeParse({ ...config, engine }).success).toBe(false)
    expect(profileSchema.safeParse({ ...profile, engine }).success).toBe(false)
  }
})

it('passes only endpoint and TLS settings to Windows and never falls back to SQL passwords', () => {
  const settings = windowsSqlServerConfig({ ...config, user: 'ignored-user', password: 'ignored-password', accessToken: 'ignored-token' }, 'win32')
  expect(settings).toEqual({ Host: config.host, Port: 1433, Database: '', Encrypt: true })
  expect(() => buildSqlServerConfig(config)).toThrow('Windows SQL Server provider')
  expect(() => windowsSqlServerConfig(config, 'linux')).toThrow('requires Windows')
  expect(() => windowsSqlServerConfig({ ...config, engine: 'azure-sql' }, 'win32')).toThrow('only for SQL Server')
  expect(() => windowsSqlServerConfig({ ...config, ca: 'custom-ca' }, 'win32')).toThrow('Windows certificate store')
  expect(() => windowsSqlServerConfig(routed(config, { host: 'localhost', port: 12345 }), 'win32')).toThrow('direct SQL Server connection')
})
