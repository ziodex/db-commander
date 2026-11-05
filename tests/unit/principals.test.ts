import { describe, expect, it, vi } from 'vitest'
import { readSqlServerPrincipals } from '../../src/principals/sqlserver'
import { decodeMysqlPrincipalId, decodeOraclePrincipalId, principalRequestSchema, previewMysqlPrincipalChange, previewOraclePrincipalChange, previewPrincipalChange, previewSqlServerPrincipalChange } from '../../src/shared/principals'

describe('PostgreSQL principal previews', () => {
  it('quotes exact identifiers and defaults a new role to NOLOGIN', () => {
    expect(previewPrincipalChange({ action: 'create', name: 'Mixed "role"; SELECT 1' })).toBe('CREATE ROLE "Mixed ""role""; SELECT 1" NOLOGIN;')
    expect(previewPrincipalChange({ action: 'grant', role: 'Reader', member: 'a"b' })).toBe('GRANT "Reader" TO "a""b";')
    expect(previewPrincipalChange({ action: 'grant-relation', role: 'Reader', relation: { schema: 'Data', name: 'a"b' }, privilege: 'SELECT' })).toBe('GRANT SELECT ON TABLE "Data"."a""b" TO "Reader";')
    expect(previewPrincipalChange({ action: 'revoke', role: 'Reader', member: 'a"b' })).toBe('REVOKE "Reader" FROM "a""b" RESTRICT;')
  })

  it('rejects ambiguous names, truncation, and grants to the same role', () => {
    for (const name of ['  ', 'pg_test', 'PUBLIC', 'none', 'a\0b', 'é'.repeat(32)]) {
      expect(() => previewPrincipalChange({ action: 'create', name })).toThrow()
    }
    expect(() => previewPrincipalChange({ action: 'grant', role: 'Reader', member: 'é'.repeat(32) })).toThrow('63 UTF-8 bytes')
    expect(() => previewPrincipalChange({ action: 'grant', role: 'Reader', member: 'Reader' })).toThrow('two different roles')
  })

  it('accepts only bounded catalog requests', () => {
    const sessionId = '464821a4-23fa-43bb-817e-84c36fb3630f'
    expect(principalRequestSchema.safeParse({ sessionId, mode: 'role', roleId: '42', relation: { schema: 's', name: 't' } }).success).toBe(true)
    expect(principalRequestSchema.safeParse({ sessionId, mode: 'role', roleId: '42; select 1' }).success).toBe(false)
    expect(principalRequestSchema.safeParse({ sessionId, mode: 'roles', search: '', sql: 'DROP ROLE other' }).success).toBe(false)
  })
})

describe('MySQL and MariaDB principal previews', () => {
  it('keeps the user and host separate and uses native identifier quoting', () => {
    const role = { user: 'a`@role', host: '%_host' }, member = { user: 'target', host: 'localhost' }
    expect(previewMysqlPrincipalChange('mysql', { action: 'grant', role, member }))
      .toBe('GRANT `a``@role`@`%_host` TO `target`@`localhost`;')
    expect(previewMysqlPrincipalChange('mariadb', { action: 'revoke', role: { ...role, host: '' }, member }))
      .toBe('REVOKE `a``@role` FROM `target`@`localhost`;')
    expect(() => previewMysqlPrincipalChange('mariadb', { action: 'grant', role, member })).toThrow('Select a MariaDB role')
    expect(decodeMysqlPrincipalId(JSON.stringify([role.user, role.host]))).toEqual(role)
    expect(decodeMysqlPrincipalId('[null,"host"]')).toBeUndefined()
  })
})

describe('SQL Server principal previews', () => {
  it('separates database securables from server memberships and quotes exact names', () => {
    expect(previewSqlServerPrincipalChange('sqlserver', 'server', { action: 'grant', role: 'a]b', member: 'login' }))
      .toBe('ALTER SERVER ROLE [a]]b] ADD MEMBER [login];')
    expect(previewSqlServerPrincipalChange('azure-sql', 'database', { action: 'revoke-relation', role: 'reader', relation: { schema: 'dbo', name: 'a]b' }, privilege: 'SELECT' }))
      .toBe('REVOKE SELECT ON OBJECT::[dbo].[a]]b] FROM [reader];')
    expect(() => previewSqlServerPrincipalChange('azure-sql', 'server', { action: 'create', name: 'role' })).toThrow('predefined server roles')
    expect(() => previewSqlServerPrincipalChange('sqlserver', 'server', { action: 'grant-relation', role: 'reader', relation: { schema: 'dbo', name: 'table' }, privilege: 'SELECT' })).toThrow('database principal')
  })
})

describe('Oracle principal previews', () => {
  it('keeps Oracle identifiers exact and refuses unsupported characters', () => {
    expect(previewOraclePrincipalChange({ action: 'create', name: 'Mixed Case' })).toBe('CREATE ROLE "Mixed Case" NOT IDENTIFIED;')
    expect(previewOraclePrincipalChange({ action: 'revoke-relation', role: 'READER', relation: { schema: 'OWNER', name: 'TAB' }, privilege: 'READ' }))
      .toBe('REVOKE READ ON "OWNER"."TAB" FROM "READER";')
    expect(() => previewOraclePrincipalChange({ action: 'create', name: 'a"b' })).toThrow('without double quotes')
    expect(decodeOraclePrincipalId('["oracle","Mixed Case","role"]')).toEqual({ name: 'Mixed Case', kind: 'role' })
    expect(decodeOraclePrincipalId('["oracle","other","login"]')).toBeUndefined()
  })
})

describe('Azure SQL logical-server metadata', () => {
  it('reads visible login membership without asking for unsupported standalone catalogs', async () => {
    const query = vi.fn(async (sql: string): Promise<(string | null)[][]> => {
      if (sql.startsWith('SELECT DB_NAME()')) return [['master', 'member', '5', null]]
      if (sql.startsWith('SELECT p.principal_id')) return [['7', 'member', 'S', 'SQL_LOGIN', '0', '1']]
      if (sql.startsWith('SELECT TOP')) return [['##MS_LoginManager##', 'member']]
      if (sql.startsWith('WITH granted')) return [['11', '##MS_LoginManager##', '1']]
      throw new Error('Unexpected logical-server catalog read.')
    })
    const detail = await readSqlServerPrincipals(query, {
      mode: 'role', scope: 'server', roleId: '7', sessionId: '464821a4-23fa-43bb-817e-84c36fb3630f'
    })
    expect(detail).toMatchObject({
      database: 'master', role: { name: 'member' },
      direct: { rows: [expect.objectContaining({ role: '##MS_LoginManager##', member: 'member' })] },
      catalog: { enabled: null, grants: { rows: [] }, grantNotice: expect.stringContaining('predefined server roles') }
    })
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain('sys.sql_logins')
    expect(sql).not.toMatch(/sys\.login_token|sys\.server_permissions|SUSER_ID/)
  })
})
