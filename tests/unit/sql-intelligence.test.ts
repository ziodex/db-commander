import { describe, expect, it } from 'vitest'
import { completeSql } from '../../src/language/completion'
import { diagnoseSql } from '../../src/language/diagnostics'
import { navigateSql, previewSqlRename, routineSignatures } from '../../src/language/navigation'
import type { DatabaseEngine, SchemaSnapshot } from '../../src/shared/contracts'

const engine = 'postgres' as const
const snapshot: SchemaSnapshot = {
  database: 'example', source: 'catalog-connection', fetchedAt: '', truncated: false,
  objects: [
    { schema: 'public', name: 'orders', kind: 'table', columns: [{ name: 'amount', type: 'numeric', nullable: false, ordinal: 1 }] },
    { schema: 'public', name: 'customers', kind: 'table', columns: [{ name: 'customer_id', type: 'integer', nullable: false, ordinal: 1 }] }
  ],
  catalog: { truncated: false, notice: '', objects: [
    { schema: 'public', name: 'orders', kind: 'table', identity: '1' },
    { schema: 'public', name: 'discount', kind: 'function', identity: '2', signature: 'amount numeric, percent numeric' },
    { schema: 'public', name: 'discount', kind: 'function', identity: '3', signature: 'amount numeric' }
  ] }
}
function at(marked: string) {
  return [marked.replace('|', ''), marked.indexOf('|')] as const
}
function names(marked: string, dialect: DatabaseEngine = engine) {
  return completeSql(...at(marked), dialect, snapshot).suggestions.map(suggestion => suggestion.label)
}

describe('SQL intelligence', () => {
  it('reports open parentheses and dialect-aware unclosed tokens', () => {
    expect(diagnoseSql("select (1, q'[not (a delimiter)]' from dual", { engine: 'oracle' })).toEqual([
      expect.objectContaining({ start: 7, end: 8, message: 'Opening parenthesis has no matching close.' })
    ])
    expect(diagnoseSql('SELECT 1 /* outer /* inner */', { engine })).toEqual([
      expect.objectContaining({ message: 'Unclosed block comment.' })
    ])
    expect(diagnoseSql('select 1 -- (', { engine })).toEqual([])
    expect(diagnoseSql('PRAGMA table_info(t)', { engine: 'sqlite' })).toEqual([])
    expect(diagnoseSql('PRAGMA table_info(t)', { engine })).toHaveLength(1)
    expect(diagnoseSql('SELECT * FROM -- choose a table', { engine })).toEqual([expect.objectContaining({ message: 'Complete the FROM clause.' })])
    expect(diagnoseSql('SELECT "bad', { engine: 'mysql', ansiQuotes: true })[0].message).toContain('identifier')
    expect(diagnoseSql('SELECT "bad', { engine: 'mysql' })[0].message).toContain('string')
  })

  it('infers derived columns and explicit aliases without guessing unnamed expressions', () => {
    expect(names('SELECT d.| FROM (SELECT o.amount AS subtotal, o.amount * 2 FROM orders o) d')).toEqual(['subtotal'])
    expect(names('SELECT x.| FROM (VALUES (1, 2)) x(first_value, second_value)', 'sqlserver')).toEqual(['first_value', 'second_value'])
    expect(names('WITH x AS (SELECT o.* FROM orders o), y AS (SELECT x.amount AS value FROM x) SELECT y.| FROM y')).toEqual(['value'])
  })

  it('uses nearest visible aliases and respects separate, lateral and set-operation scopes', () => {
    expect(names('SELECT 1 FROM orders o WHERE EXISTS (SELECT o.| FROM customers c)')).toEqual(['amount'])
    expect(names('SELECT 1 FROM orders o WHERE EXISTS (SELECT o.| FROM unknown_table o)')).toEqual([])
    expect(names('SELECT 1 FROM orders o JOIN (SELECT o.|) d ON TRUE')).toEqual([])
    expect(names('SELECT 1 FROM orders o JOIN LATERAL (SELECT o.|) d ON TRUE')).toEqual(['amount'])
    expect(names('SELECT o.amount FROM orders o UNION ALL SELECT o.| FROM customers o')).toEqual(['customer_id'])
    expect(names('SELECT o.amount FROM orders o\nGO 2 -- repeat\nSELECT o.| FROM customers o', 'sqlserver')).toEqual(['customer_id'])
  })

  it('navigates scoped aliases, CTEs and catalog relations by identity', () => {
    const [sql, offset] = at('SELECT o|.amount FROM public.orders AS o WHERE EXISTS (SELECT 1 WHERE o.amount > 2)')
    const result = navigateSql(sql, offset, { engine }, snapshot)
    expect(sql.slice(result.definition!.start, result.definition!.end)).toBe('o')
    expect(result.definition!.start).toBe(sql.indexOf('AS o') + 3)
    expect(result.references.map(({ start, end }) => sql.slice(start, end))).toEqual(['o', 'o'])
    expect(navigateSql(...at('SELECT * FROM public.ord|ers'), { engine }, snapshot).objects).toEqual([snapshot.catalog!.objects[0]])
    expect(navigateSql(...at('SELECT * FROM public.ord|ers a JOIN public.orders b ON a.amount=b.amount'), { engine }, snapshot).references).toHaveLength(2)
    const [cte, cursor] = at('WITH subset AS (SELECT amount FROM orders) SELECT subset.amount FROM sub|set')
    const local = navigateSql(cte, cursor, { engine }, snapshot)
    expect(local.definition?.start).toBe(5)
    expect(local.references).toHaveLength(2)
  })

  it('previews exact changes and refuses shadowing, collisions and unsupported uses', () => {
    const [sql, offset] = at("SELECT o|.amount, 'o.amount' FROM orders o -- o.amount\nWHERE o.amount > 2; SELECT o.amount FROM orders o;")
    const plan = previewSqlRename(sql, offset, 'new "name"', { engine }, snapshot)
    expect(plan.replacement).toBe('"new ""name"""')
    expect(plan.edits.map(({ start, end }) => sql.slice(start, end))).toEqual(['o', 'o', 'o'])
    expect(plan.edits.every(edit => edit.end < sql.indexOf(';'))).toBe(true)
    expect(() => previewSqlRename(...at('SELECT o|.amount, o FROM orders o'), 'next', { engine }, snapshot)).toThrow('another role')
    expect(() => previewSqlRename(...at('SELECT o|.amount FROM orders o WHERE EXISTS (SELECT 1 FROM customers o)'), 'next', { engine }, snapshot)).toThrow('another role')
    expect(() => previewSqlRename(...at('SELECT o|.amount FROM orders o'), 'amount', { engine }, snapshot)).toThrow('already used')
    expect(() => previewSqlRename(...at('SELECT o|.amount, 1::o.custom_type FROM orders o'), 'next', { engine }, snapshot)).toThrow('another role')
    expect(() => previewSqlRename(...at('SELECT o|.amount FROM orders o'), 'ü'.repeat(32), { engine }, snapshot)).toThrow('UTF-8')
  })

  it('shows overloads and counts argument position outside nested calls, strings and comments', () => {
    expect(routineSignatures(...at("SELECT public.discount(coalesce(2, 4), |)"), { engine }, snapshot)).toEqual({
      argument: 1, limited: false,
      signatures: [
        { label: 'public.discount', arguments: 'amount numeric, percent numeric' },
        { label: 'public.discount', arguments: 'amount numeric' }
      ]
    })
    expect(routineSignatures(...at("SELECT public.discount('one, |two')"), { engine }, snapshot)).toBeUndefined()
    expect(routineSignatures(...at('SELECT public.discount(2, /* |test */ 4)'), { engine }, snapshot)).toBeUndefined()
  })
})
