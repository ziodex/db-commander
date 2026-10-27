import { describe, expect, it } from 'vitest'
import { completeSql } from '../../src/language/completion'
import { formatSql } from '../../src/language/format'
import { lexSql } from '../../src/shared/sql/lexer'
import { schemaSnapshot } from '../../src/driver/schema'
import { engineSchema, type DatabaseEngine, type SchemaSnapshot } from '../../src/shared/contracts'
import { DEFAULT_EDITOR_SETTINGS, resolveSqlFormatting } from '../../src/shared/editor-settings'
const schema: SchemaSnapshot = { database: 'db', source: 'catalog-connection', fetchedAt: '', truncated: false, objects: [
  { schema: 'public', name: 'customers', kind: 'table', columns: [{ name: 'id', type: 'integer', nullable: false, ordinal: 1 }, { name: 'Display Name', type: 'text', nullable: true, ordinal: 2 }] },
  { schema: 'public', name: 'orders', kind: 'table', columns: [{ name: 'id', type: 'integer', nullable: false, ordinal: 1 }, { name: 'customer_id', type: 'integer', nullable: true, ordinal: 2 }] }
] }
function suggestions(sql: string, engine: DatabaseEngine = 'postgres', snapshot = schema) {
  const offset = sql.indexOf('|'); return completeSql(sql.replace('|', ''), offset, engine, snapshot).suggestions
}
describe('schema completion', () => {
  it('resolves aliases declared after the cursor and quotes unusual column names', () => {
    expect(suggestions('select c.| from public.customers AS c')).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Display Name', insertText: '"Display Name"', detail: 'c · text · nullable' })]))
    expect(suggestions('select o.cu| from public.orders o')[0].insertText).toBe('"customer_id"')
    expect(suggestions('select "c".| from "public"."customers" "c"')).toHaveLength(2)
  })
  it('completes schema-qualified tables and qualifies ambiguous join columns', () => {
    expect(suggestions('select * from public.cu|')).toEqual([expect.objectContaining({ label: 'customers', insertText: '"customers"' })])
    expect(suggestions('select i| from customers c join orders o on c.id=o.customer_id').filter(item => item.kind === 'column').map(item => item.insertText)).toEqual(['"c"."id"', '"o"."id"'])
  })
  it('keeps statement, subquery, CTE and connection scopes separate', () => {
    expect(suggestions('select c.| from customers c; select o.id from orders o').map(item => item.label)).not.toContain('customer_id')
    expect(suggestions('select * from customers c where exists (select o.| from orders o)').map(item => item.label)).toContain('customer_id')
    expect(suggestions('with x(customer) as (select id from customers) select x.| from x').map(item => item.label)).toEqual(['customer'])
    expect(suggestions('with x as (select c.id as customer, c."Display Name" from customers c) select x.| from x').map(item => item.label)).toEqual(['customer', 'Display Name'])
    expect(suggestions('select c.| from customers c', 'postgres', { ...schema, objects: [] })).toEqual([])
  })
  it('suppresses comments/strings, handles quoted replacement ranges and offers offline dialect words', () => {
    for (const sql of ["select 'c.|' from customers c", '-- FROM customers c |', 'select /* nested /* comment */ | */ 1', 'select $$ c.| $$']) expect(suggestions(sql)).toEqual([])
    const sql = 'select c."Disp" from customers c', result = completeSql(sql, sql.indexOf('Disp') + 4, 'postgres', schema)
    expect(sql.slice(result.start, result.end)).toBe('"Disp"'); expect(result.suggestions[0].insertText).toBe('"Display Name"')
    expect(suggestions('ILI|', 'postgres', { ...schema, objects: [] }).map(item => item.label)).toContain('ILIKE')
    expect(suggestions('TOP|', 'azure-sql', { ...schema, objects: [] }).map(item => item.label)).toContain('TOP')
    expect(suggestions('select q\'[x|]\' from dual', 'oracle')).toEqual([])
  })
  it('quotes identifiers for every engine and bounds metadata/completions', () => {
    for (const engine of engineSchema.options) {
      const insert = suggestions('select c.| from customers c', engine).find(item => item.label === 'Display Name')!.insertText
      expect(insert).toBe(['mysql', 'mariadb'].includes(engine) ? '`Display Name`' : ['sqlserver', 'azure-sql'].includes(engine) ? '[Display Name]' : '"Display Name"')
    }
    const snapshot = schemaSnapshot(Array.from({ length: 10001 }, (_, i) => [null, 'public', 'wide', 'table', `col${i}`, 'int', false, i]), 'db', 'catalog-connection')
    expect(snapshot.truncated).toBe(true); expect(snapshot.objects[0].columns).toHaveLength(10000)
    expect(suggestions('select w.| from wide w', 'postgres', snapshot).length).toBe(200)
  })
})
describe('SQL formatting', () => {
  for (const engine of engineSchema.options) it(`applies indentation and spacing preferences to ${engine} without rewriting tokens or parameters`, () => {
    const sql = `select :value as parameter,'mixed Case  -- ;' as label,(111 + 222 + 333 + 444 + 555) as total${engine === 'oracle' ? ' from dual' : ''};\nselect :value${engine === 'oracle' ? ' from dual' : ''};`
    for (const useTabs of [false, true]) for (const linesBetweenQueries of [0, 3]) {
      const preferences = { expressionWidth: 20, linesBetweenQueries }
      const style = resolveSqlFormatting({ ...DEFAULT_EDITOR_SETTINGS, engineFormatting: {
        [engine]: { tabSize: 4, insertSpaces: !useTabs, formatting: preferences }
      } }, engine)
      const formatted = formatSql(sql, engine, style.tabSize, !style.insertSpaces, style.formatting)
      expect(formatted).toMatch(useTabs ? /\n\t\S/ : /\n {4}\S/)
      expect(formatted).toContain(';' + '\n'.repeat(linesBetweenQueries + 1) + 'select')
      expect(lexSql(formatted, engine).map(token => [token.kind, token.text])).toEqual(lexSql(sql, engine).map(token => [token.kind, token.text]))
      expect(formatSql(formatted, engine, 4, useTabs, preferences)).toBe(formatted)
    }
    const narrow = formatSql(sql, engine, 2, false, { expressionWidth: 20, linesBetweenQueries: 1 })
    const wide = formatSql(sql, engine, 2, false, { expressionWidth: 200, linesBetweenQueries: 1 })
    expect(narrow.split('\n').length).toBeGreaterThan(wide.split('\n').length)
    expect(formatSql(sql.replaceAll('\n', '\r\n'), engine, 4, true, { expressionWidth: 20, linesBetweenQueries: 2 })).not.toMatch(/(?<!\r)\n/)
  })
  it('keeps GO repeat lines intact under custom formatting and refuses unsafe style input', () => {
    const sql = "select 'GO' as label;\nGO 2 -- repeats\nselect 3;"
    for (const engine of ['sqlserver', 'azure-sql'] as const) expect(formatSql(sql, engine, 4, true, { expressionWidth: 20, linesBetweenQueries: 3 })).toContain('\nGO 2 -- repeats\n')
    expect(() => formatSql('select 1', 'postgres', 2, false, { expressionWidth: 20, linesBetweenQueries: 1, params: ['replacement'] } as any)).toThrow()
    expect(() => formatSql('select 1', 'postgres', 2, false, { expressionWidth: 20, linesBetweenQueries: 10_000 })).toThrow()
  })
  for (const engine of engineSchema.options) it(`formats ${engine} without changing literals, comments or identifiers`, () => {
    const quote = ['mysql', 'mariadb'].includes(engine) ? '`name`' : ['sqlserver', 'azure-sql'].includes(engine) ? '[name]' : '"name"'
    const sql = `select ${quote},'a  b; -- c' as label from users where id=1; -- tail\nselect 2${engine === 'oracle' ? ' from dual' : ''};`
    const formatted = formatSql(sql, engine)
    expect(formatted).not.toBe(sql); expect(formatted).toContain('\n'); expect(formatSql(formatted, engine)).toBe(formatted)
    expect(lexSql(formatted, engine).map(token => token.text)).toEqual(lexSql(sql, engine).map(token => token.text))
  })
  it('keeps T-SQL GO repeats and quoted GO text intact', () => {
    const sql = "select 'GO' as label;\nGO 2 -- repeats\nselect 3;"
    const formatted = formatSql(sql, 'sqlserver'); expect(formatted).toContain('\nGO 2 -- repeats\n'); expect(formatted).toContain("'GO'")
  })
  it('preserves PostgreSQL JSON operators and MySQL literals under either backslash mode', () => {
    const sql = "select payload#>>'{a}',data->>'key' from records"
    expect(formatSql(sql, 'postgres')).toContain('#>>')
    for (const engine of ['mysql', 'mariadb'] as const) {
      const sql = String.raw`select 'path\\to\\file' as name, 'two  spaces' as value`
      const formatted = formatSql(sql, engine)
      for (const mode of [false, true]) expect(lexSql(formatted, engine, mode).map(token => token.text)).toEqual(lexSql(sql, engine, mode).map(token => token.text))
    }
  })
  it('leaves unsupported or incomplete scripts to the caller without partial edits', () => {
    for (const [sql, engine] of [["select 'unfinished", 'postgres'], ['DELIMITER $$\nCREATE PROCEDURE x() SELECT 1$$', 'mysql'], ['BEGIN NULL; END;\n/', 'oracle'], ['CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END;', 'sqlite']] as const) expect(() => formatSql(sql, engine)).toThrow()
    expect(() => formatSql('x'.repeat(200001), 'duckdb')).toThrow('200,000')
    const sql = "select 'hello'\n'world'"; try { const result = formatSql(sql, 'postgres'); expect(result).toMatch(/'hello'\s*\n\s*'world'/) } catch (error) { expect((error as Error).message).toMatch(/Formatting would change|Parse error/) }
  })
})
