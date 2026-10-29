import { describe, expect, it } from 'vitest'
import type { ObjectDetail } from '../../src/shared/catalog'
import { sqliteExplicitNotNullCount } from '../../src/schema/sqlite-column'

const object = { schema: 'main', name: 't', kind: 'table' as const, identity: '1' }
const table = (sql: string): ObjectDetail => ({ object, source: 'catalog-connection', fetchedAt: '', sections: [], definition: { sql, source: 'native' } })
describe('SQLite nullability changes', () => {
  it('counts explicit clauses without treating defaults or expressions as constraints', () => {
    const detail = table(`CREATE TABLE t ("value" TEXT NOT NULL ON CONFLICT FAIL DEFAULT 'not null', [other] INT CHECK (other IS NOT NULL), x TEXT NOT NULL NOT NULL, PRIMARY KEY (other))`)
    expect(sqliteExplicitNotNullCount(detail, 'value')).toBe(1)
    expect(sqliteExplicitNotNullCount(detail, 'other')).toBe(0)
    expect(sqliteExplicitNotNullCount(detail, 'x')).toBe(2)
  })
  it('refuses missing, incomplete or ambiguous definitions', () => {
    const detail = table('CREATE TABLE t ("x" INT, "x" TEXT)')
    expect(() => sqliteExplicitNotNullCount(detail, 'x')).toThrow(/ambiguous/)
    expect(() => sqliteExplicitNotNullCount({ ...detail, definition: { ...detail.definition, truncated: true } }, 'x')).toThrow(/complete native/)
    expect(() => sqliteExplicitNotNullCount(table('CREATE TABLE t AS SELECT 1'), 'x')).toThrow(/cannot be safely parsed/)
  })
})
