import type { DatabaseEngine, SchemaObject, SchemaSnapshot } from '../shared/contracts'
import { quoteIdentifier } from '../shared/sql/common'
import { lexSql, type Token } from '../shared/sql/lexer'
interface SqlSuggestion { label: string; insertText: string; kind: 'table' | 'column' | 'schema' | 'keyword' | 'function'; detail: string; sortText: string }
export interface CompletionResult { start: number; end: number; suggestions: SqlSuggestion[] }
const keywords = 'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS WITH RECURSIVE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW ALTER DROP GROUP BY ORDER HAVING DISTINCT UNION ALL INTERSECT EXCEPT CASE WHEN THEN ELSE END AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ASC DESC OFFSET FETCH FIRST ROWS ONLY OVER PARTITION BEGIN COMMIT ROLLBACK'.split(' ')
const extras: Record<DatabaseEngine, string[]> = {
  postgres: ['RETURNING', 'LIMIT', 'ILIKE', 'LATERAL', 'CONFLICT', 'MATERIALIZED'], mysql: ['LIMIT', 'SHOW', 'DESCRIBE', 'REPLACE', 'DUPLICATE'], mariadb: ['LIMIT', 'SHOW', 'DESCRIBE', 'REPLACE', 'RETURNING'],
  sqlserver: ['TOP', 'OUTPUT', 'APPLY', 'PIVOT', 'UNPIVOT', 'GO', 'MERGE'], 'azure-sql': ['TOP', 'OUTPUT', 'APPLY', 'PIVOT', 'UNPIVOT', 'GO', 'MERGE'],
  sqlite: ['PRAGMA', 'LIMIT', 'RETURNING', 'ATTACH', 'DETACH', 'CONFLICT'], oracle: ['MERGE', 'DUAL', 'CONNECT', 'START', 'RETURNING', 'MINUS'], duckdb: ['LIMIT', 'QUALIFY', 'EXCLUDE', 'REPLACE', 'PIVOT', 'UNPIVOT', 'RETURNING']
}
const functions: Record<DatabaseEngine, string[]> = {
  postgres: ['NOW', 'DATE_TRUNC', 'JSONB_BUILD_OBJECT', 'GENERATE_SERIES'], mysql: ['NOW', 'DATE_FORMAT', 'JSON_EXTRACT', 'IFNULL'], mariadb: ['NOW', 'DATE_FORMAT', 'JSON_EXTRACT', 'IFNULL'],
  sqlserver: ['GETDATE', 'DATEADD', 'DATEDIFF', 'ISNULL', 'STRING_AGG'], 'azure-sql': ['GETDATE', 'DATEADD', 'DATEDIFF', 'ISNULL', 'STRING_AGG'],
  sqlite: ['DATETIME', 'STRFTIME', 'IFNULL', 'JSON_EXTRACT'], oracle: ['SYSDATE', 'SYSTIMESTAMP', 'TO_CHAR', 'TO_DATE', 'NVL'], duckdb: ['READ_CSV', 'READ_PARQUET', 'DATE_TRUNC', 'UNNEST', 'RANGE']
}
const reserved = new Set([...keywords, ...Object.values(extras).flat()])
const identifier = (token?: Token) => token && (token.kind === 'word' || token.kind === 'identifier')
const equal = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()
function pathAt(tokens: Token[], index: number): { parts: string[]; end: number } {
  const parts: string[] = []
  while (identifier(tokens[index])) {
    parts.push(tokens[index++].value)
    if (tokens[index]?.text !== '.' || !identifier(tokens[index + 1])) break
    index++
  }
  return { parts, end: index }
}
function resolve(parts: string[], objects: SchemaObject[]): SchemaObject | undefined {
  const matches = objects.filter(object => {
    const path = [object.catalog, object.schema, object.name].filter(Boolean) as string[]
    return parts.length <= path.length && parts.every((part, index) => equal(part, path[path.length - parts.length + index]))
  })
  return matches.length === 1 ? matches[0] : undefined
}
function depths(tokens: Token[]) { let depth = 0; return tokens.map(token => { if (token.text === ')') depth--; const value = depth; if (token.text === '(') depth++; return value }) }
interface Reference { alias: string; object: SchemaObject }
function references(tokens: Token[], objects: SchemaObject[]): Reference[] {
  const result: Reference[] = [], levels = depths(tokens)
  let from = false
  for (let i = 0; i < tokens.length; i++) {
    if (levels[i] !== 0) continue
    const word = tokens[i].text.toUpperCase()
    if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'SET', 'VALUES', 'RETURNING'].includes(word)) from = false
    if (!['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(word) && !(from && word === ',')) continue
    from = true
    const path = pathAt(tokens, i + 1), object = resolve(path.parts, objects)
    if (!path.parts.length || !object) continue
    let end = path.end
    if (tokens[end]?.text.toUpperCase() === 'AS') end++
    const alias = identifier(tokens[end]) && !reserved.has(tokens[end].text.toUpperCase()) ? tokens[end].value : object.name
    result.push({ alias, object })
  }
  return result
}
/** Infer explicit CTE names/columns and simple SELECT projections; no speculative SQL execution. */
function ctes(tokens: Token[], objects: SchemaObject[]): SchemaObject[] {
  const result: SchemaObject[] = []
  if (tokens[0]?.text.toUpperCase() !== 'WITH') return result
  let i = tokens[1]?.text.toUpperCase() === 'RECURSIVE' ? 2 : 1
  while (identifier(tokens[i])) {
    const name = tokens[i++].value, declared: string[] = []
    if (tokens[i]?.text === '(') { i++; while (i < tokens.length && tokens[i].text !== ')') { if (identifier(tokens[i])) declared.push(tokens[i].value); i++ }; i++ }
    if (tokens[i++]?.text.toUpperCase() !== 'AS') break
    if (tokens[i]?.text.toUpperCase() === 'NOT') i++
    if (tokens[i]?.text.toUpperCase() === 'MATERIALIZED') i++
    if (tokens[i++]?.text !== '(') break
    const begin = i; let depth = 1
    while (i < tokens.length && depth) { if (tokens[i].text === '(') depth++; if (tokens[i].text === ')') depth--; if (depth) i++ }
    const body = tokens.slice(begin, i), levels = depths(body), refs = references(body, [...objects, ...result])
    const projected: string[] = []; let chunk: Token[] = []
    const finish = () => {
      let as = -1; chunk.forEach((token, index) => { if (token.text.toUpperCase() === 'AS') as = index })
      const last = chunk.at(-1)
      if (as !== -1 && identifier(chunk[as + 1])) projected.push(chunk[as + 1].value)
      else if (chunk.length && chunk.every(token => identifier(token) || token.text === '.')) projected.push(last!.value)
      else if (last?.text === '*') { const selected = chunk.length === 3 ? refs.filter(ref => equal(ref.alias, chunk[0].value)) : refs; selected.forEach(ref => projected.push(...ref.object.columns.map(column => column.name))) }
      chunk = []
    }
    if (body[0]?.text.toUpperCase() === 'SELECT') for (let n = 1; n <= body.length; n++) {
      if (n === body.length || levels[n] === 0 && body[n].text.toUpperCase() === 'FROM') { finish(); break }
      if (levels[n] === 0 && body[n].text === ',') finish(); else chunk.push(body[n])
    }
    result.push({ schema: '', name, kind: 'cte', columns: (declared.length ? declared : projected).map((name, ordinal) => ({ name, ordinal, type: 'CTE column', nullable: true })) })
    i++; if (tokens[i++]?.text !== ',') break
  }
  return result
}
export function completeSql(sql: string, offset: number, engine: DatabaseEngine, snapshot?: SchemaSnapshot | null): CompletionResult {
  const empty = { start: offset, end: offset, suggestions: [] }
  if (sql.length > 200_000 || offset < 0 || offset > sql.length) return empty
  const all = lexSql(sql, engine)
  const inside = all.find(token => token.start < offset && (offset < token.end || offset === token.end && (!token.closed || token.kind === 'comment')))
  if (inside && ['comment', 'string'].includes(inside.kind)) return empty
  const current = all.find(token => identifier(token) && token.start < offset && token.end >= offset)
  const start = current?.start ?? offset, end = current?.end ?? offset
  const prefix = current ? sql.slice(current.start + (current.kind === 'identifier' ? 1 : 0), offset).replace(/["`\]]$/, '') : ''
  const code = all.filter(token => token.kind !== 'comment')
  // Semicolons and T-SQL GO delimit independent completion scopes.
  const separator = (token: Token) => token.text === ';' || ['sqlserver', 'azure-sql'].includes(engine) && /^GO$/i.test(token.text) && /^\s*GO(?:\s+\d+)?\s*$/i.test(sql.slice(sql.lastIndexOf('\n', token.start - 1) + 1, sql.indexOf('\n', token.end) === -1 ? sql.length : sql.indexOf('\n', token.end)))
  let left = 0, right = code.length
  for (let i = 0; i < code.length; i++) if (separator(code[i])) { if (code[i].end <= start) left = i + 1; else if (code[i].start >= offset) { right = i; break } }
  const statement = code.slice(left, right), available = [...(snapshot?.objects ?? [])], local = ctes(statement, available)
  // CTEs shadow real relations with the same unqualified name.
  const objects = [...available.filter(object => !local.some(cte => equal(cte.name, object.name))), ...local]
  let scope = statement
  const stack: number[] = []
  for (let i = 0; i < statement.length; i++) {
    if (statement[i].start >= offset) break
    if (statement[i].text === '(') stack.push(i)
    if (statement[i].text === ')') stack.pop()
  }
  for (const index of stack) if (['SELECT', 'WITH'].includes(statement[index + 1]?.text.toUpperCase())) {
    let depth = 1, last = index + 1
    while (last < statement.length && depth) { if (statement[last].text === '(') depth++; if (statement[last].text === ')') depth--; if (depth) last++ }
    scope = statement.slice(index + 1, last)
  }
  const refs = references(scope, objects), before = scope.filter(token => token.end <= start)
  const qualifier: string[] = []; let position = before.length - 1
  while (before[position]?.text === '.' && identifier(before[position - 1])) { qualifier.unshift(before[position - 1].value); position -= 2 }
  const previous = before[position]?.text.toUpperCase(), tableContext = ['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'].includes(previous ?? '')
  const suggestions: SqlSuggestion[] = [], seen = new Set<string>(), q = (name: string) => quoteIdentifier(name, engine)
  const add = (label: string, insertText: string, kind: SqlSuggestion['kind'], detail: string, rank = '1') => {
    if (suggestions.length >= 200 || !label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return
    const key = `${kind}:${insertText}`; if (seen.has(key)) return; seen.add(key)
    suggestions.push({ label, insertText, kind, detail, sortText: rank + label })
  }
  const columns = (ref: Reference, qualify = false) => ref.object.columns.forEach(column => add(column.name, (qualify ? q(ref.alias) + '.' : '') + q(column.name), 'column', `${ref.alias} · ${column.type}${column.nullable ? ' · nullable' : ''}`, '0'))
  if (qualifier.length) {
    const ref = qualifier.length === 1 ? refs.find(ref => equal(ref.alias, qualifier[0])) : undefined
    const object = resolve(qualifier, objects)
    if (!tableContext && (ref || object)) columns(ref ?? { alias: object!.name, object: object! })
    else for (const item of objects) {
      const namespace = [item.catalog, item.schema].filter(Boolean) as string[]
      if (qualifier.length <= namespace.length && qualifier.every((part, i) => equal(part, namespace[namespace.length - qualifier.length + i]))) add(item.name, q(item.name), 'table', `${namespace.join('.')} · ${item.kind}`)
      if (qualifier.length === 1 && item.catalog && equal(item.catalog, qualifier[0])) add(item.schema, q(item.schema), 'schema', item.catalog)
    }
    return { start, end, suggestions }
  }
  if (!tableContext) for (const ref of refs) columns(ref, refs.length > 1)
  for (const object of objects) {
    const path = [object.catalog, object.schema, object.name].filter(Boolean) as string[]
    add(object.name, path.map(q).join('.'), 'table', `${path.slice(0, -1).join('.')} · ${object.kind}`, tableContext ? '0' : '2')
    if (object.schema) add(object.schema, q(object.schema), 'schema', 'Schema', '2')
    if (object.catalog) add(object.catalog, q(object.catalog), 'schema', 'Catalog', '2')
  }
  if (!tableContext) {
    for (const word of new Set([...keywords, ...extras[engine]])) add(word, word, 'keyword', 'SQL keyword', '3')
    for (const name of ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'LOWER', 'UPPER', 'SUBSTRING', ...functions[engine]]) add(name, name, 'function', 'SQL function', '3')
  }
  return { start, end, suggestions }
}
export function changesSchema(sql: string, engine: DatabaseEngine): boolean {
  return lexSql(sql, engine).some(token => token.kind === 'word' && /^(CREATE|ALTER|DROP|RENAME|ATTACH|DETACH|USE|SET|RESET|DISCARD|COMMIT|ROLLBACK)$/i.test(token.text))
}
