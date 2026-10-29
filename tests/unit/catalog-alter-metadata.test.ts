import { expect, it } from 'vitest'
import { oracleCatalog } from '../../src/catalog/oracle'
import { sqlServerCatalog } from '../../src/catalog/sqlserver'
import { schemaSql } from '../../src/schema/sql'
import type { CatalogObject } from '../../src/shared/catalog'
import type { SessionInfo } from '../../src/shared/contracts'

const session: SessionInfo = { id: '00000000-0000-4000-8000-000000000001', engine: 'sqlserver', name: 'test', database: 'test', user: 'test', host: '', port: 0, tls: false, transaction: 'idle', version: '' }
it('keeps SQL Server object browsing available when optional alteration metadata is unavailable', async () => {
  const table: CatalogObject = { schema: 'dbo', name: 't', kind: 'table', identity: '12' }
  const adapter = sqlServerCatalog(async sql => {
    if (sql.includes('c.is_masked')) throw new Error('field unavailable on this server')
    if (sql.includes('FROM sys.columns c')) return [['v','int','4','10','0','1','0',null,null,null]]
    return []
  })
  const detail = await adapter.detail(table), columns = detail.sections.find(section => section.title === 'Columns')!
  expect(columns.rows[0][0]).toBe('v'); expect(columns.rows[0][columns.columns.indexOf('Computed')]).toBeNull()
  expect(() => schemaSql({ action: 'alter-column', target: table, column: 'v', alteration: { kind: 'nullability', nullable: false } }, session, { ...detail, object: table, source: 'catalog-connection', fetchedAt: '' })).toThrow(/metadata is incomplete/)
})
it('keeps Oracle browsing available when DEFAULT ON NULL metadata is unavailable', async () => {
  const table: CatalogObject = { schema: 'TEST', name: 't', kind: 'table', identity: '12' }
  const adapter = oracleCatalog(async sql => {
    if (sql.includes('default_on_null')) throw new Error('field unavailable on this server')
    if (sql.includes('FROM user_tab_cols')) return [['v','NUMBER','22','10','0','Y',null,'NO','NO']]
    return []
  })
  const detail = await adapter.detail(table), columns = detail.sections.find(section => section.title === 'Columns')!
  expect(columns.rows[0][0]).toBe('v'); expect(columns.rows[0][columns.columns.indexOf('Default on null')]).toBeNull()
  expect(() => schemaSql({ action: 'alter-column', target: table, column: 'v', alteration: { kind: 'default', default: { kind: 'number', value: '3' } } }, { ...session, engine: 'oracle' }, { ...detail, object: table, source: 'catalog-connection', fetchedAt: '' })).toThrow(/metadata is unavailable/)
})
it('keeps Oracle browsing available when identity metadata is unavailable', async () => {
  const table: CatalogObject = { schema: 'TEST', name: 't', kind: 'table', identity: '12' }
  const adapter = oracleCatalog(async sql => {
    if (sql.includes('user_tab_identity_cols')) throw new Error('view unavailable on this server')
    if (sql.includes('FROM user_tab_cols')) return [['v','NUMBER','22','10','0','N',null,'YES','NO','NO']]
    return []
  })
  const detail = await adapter.detail(table)
  expect(detail.sections.find(section => section.title === 'Columns')?.rows[0][0]).toBe('v')
  expect(detail.sections.some(section => section.title === 'Identity columns')).toBe(false)
  expect(() => schemaSql({ action: 'alter-column', target: table, column: 'v', alteration: { kind: 'identity-drop' } }, { ...session, engine: 'oracle' }, { ...detail, object: table, source: 'catalog-connection', fetchedAt: '' })).toThrow(/identity metadata is incomplete/i)
})
it('refuses Oracle character expression changes if collation metadata is unavailable', async () => {
  const table: CatalogObject = { schema: 'TEST', name: 't', kind: 'table', identity: '12' }
  const adapter = oracleCatalog(async sql => {
    if (sql.includes('char_used')) throw new Error('field unavailable on this server')
    if (sql.includes('evaluation_edition')) return [['v',null,null,null]]
    if (sql.includes('FROM user_tab_cols')) return [['v','VARCHAR2','24',null,null,'Y','TO_CHAR(1)','NO','YES','NO']]
    return []
  })
  const detail = await adapter.detail(table), columns = detail.sections.find(section => section.title === 'Columns')!
  expect(columns.rows[0][columns.columns.indexOf('Collation')]).toBeNull()
  expect(() => schemaSql({ action: 'alter-column', target: table, column: 'v', alteration: { kind: 'generated-expression', expression: 'TO_CHAR(2)' } }, { ...session, engine: 'oracle' }, { ...detail, object: table, source: 'catalog-connection', fetchedAt: '' })).toThrow(/character type or collation metadata is incomplete/)
})
