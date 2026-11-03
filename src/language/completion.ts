import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import { quoteIdentifier } from '../shared/sql/common'
import { lexSql } from '../shared/sql/lexer'
import { catalogMatches, localName, queryScopes, type QueryRelation } from './query-scopes'
import { ANALYSIS_LIMIT, folded, identifier, sqlTokens, statementAt, symbol, word, type AnalysisDialect } from './syntax'
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
export function completeSql(sql: string, offset: number, engine: DatabaseEngine, snapshot?: SchemaSnapshot | null, modes?: Omit<AnalysisDialect, 'engine'>): CompletionResult {
  const empty = { start: offset, end: offset, suggestions: [] }
  if (sql.length > ANALYSIS_LIMIT || offset < 0 || offset > sql.length) return empty
  const all = sqlTokens(sql, { engine, ...modes })
  const inside = all.find(token => token.start < offset && (offset < token.end || offset === token.end && (!token.closed || token.kind === 'comment')))
  if (inside && ['comment', 'string'].includes(inside.kind)) return empty
  const current = all.find(token => identifier(token) && token.start < offset && token.end >= offset)
  const start = current?.start ?? offset, end = current?.end ?? offset
  const prefix = current ? sql.slice(current.start + (current.kind === 'identifier' ? 1 : 0), offset).replace(/["`\]]$/, '') : ''
  const statement = statementAt(sql, all.filter(token => token.kind !== 'comment'), start, engine)
  const index = queryScopes(statement, snapshot?.objects ?? [], engine)
  const scope = index.scopeAt(offset)
  const refs = index.visible(scope)
  const objects = [...scope.tables.map(table => table.object), ...snapshot?.objects ?? []]
  const before = statement.filter(token => token.end <= start)
  const qualifier = []
  let position = before.length - 1
  while (symbol(before[position], '.') && identifier(before[position - 1])) {
    qualifier.unshift(before[position - 1])
    position -= 2
  }
  const tableContext = ['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'LATERAL', 'APPLY'].includes(word(before[position]))
  const suggestions: SqlSuggestion[] = [], seen = new Set<string>(), q = (name: string) => quoteIdentifier(name, engine)
  const add = (label: string, insertText: string, kind: SqlSuggestion['kind'], detail: string, rank = '1') => {
    if (suggestions.length >= 200 || !label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return
    const key = `${kind}:${insertText}`; if (seen.has(key)) return; seen.add(key)
    suggestions.push({ label, insertText, kind, detail, sortText: rank + label })
  }
  const columns = (ref: QueryRelation, qualify = false) => {
    const alias = ref.alias ?? ref.name
    const quoted = q(['postgres', 'oracle'].includes(engine) ? localName(alias, engine) : alias.value)
    ref.object?.columns.forEach(column => add(column.name, (qualify ? quoted + '.' : '') + q(column.name), 'column', `${alias.value} · ${column.type}${column.nullable ? ' · nullable' : ''}`, '0'))
  }
  const routines = snapshot?.catalog?.objects.filter(item => ['function', 'procedure', 'macro'].includes(item.kind)) ?? []
  const routine = (item: typeof routines[number], qualified = true) => {
    const path = [item.catalog, item.schema, item.name].filter((value): value is string => Boolean(value))
    add(item.name, (qualified ? path : [item.name]).map(q).join('.'), 'function', `${path.slice(0, -1).join('.')} · ${item.kind}${item.signature === undefined ? '' : ` (${item.signature})`}`, '2')
  }
  if (qualifier.length) {
    const name = qualifier[0]
    const aliases = qualifier.length === 1 ? refs.filter(ref => localName(ref.alias ?? ref.name, engine) === localName(name, engine)) : []
    const matches = catalogMatches(qualifier, objects, engine)
    if (!tableContext && aliases.length) {
      if (aliases.length === 1) columns(aliases[0])
    } else if (!tableContext && matches.length === 1) {
      matches[0].columns.forEach(column => add(column.name, q(column.name), 'column', column.type, '0'))
    } else {
      for (const item of [...objects, ...routines]) {
        const namespace = [item.catalog, item.schema].filter((value): value is string => Boolean(value))
        if (qualifier.length <= namespace.length && qualifier.every((part, i) => folded(part.value) === folded(namespace[namespace.length - qualifier.length + i]))) {
          if ('columns' in item) add(item.name, q(item.name), 'table', `${namespace.join('.')} · ${item.kind}`)
          else if (!tableContext) routine(item, false)
        }
        if (qualifier.length === 1 && item.catalog && folded(item.catalog) === folded(name.value)) add(item.schema, q(item.schema), 'schema', item.catalog)
      }
    }
    return { start, end, suggestions }
  }
  if (!tableContext) {
    for (const ref of refs) columns(ref, refs.length > 1)
    for (const item of routines) routine(item)
  }
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
