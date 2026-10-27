import { quoteIdentifier } from '../shared/sql/common'
import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import { builderQuerySchema, builderTableKey, type BuilderQuery, type BuilderColumn, type BuilderPreview } from '../shared/query-builder'

/** Compile a bounded SELECT tree; identifiers must resolve in the supplied catalog. */
export function builderSql(input: BuilderQuery, engine: DatabaseEngine, snapshot: SchemaSnapshot): BuilderPreview {
  const query = builderQuerySchema.parse(input)
  if (snapshot.truncated) throw new Error('Schema metadata is incomplete. The builder requires a complete schema snapshot; use the SQL editor for this database.')
  const q = (value: string) => quoteIdentifier(value,engine)
  const sources = query.sources.map(({table}) => {
    const matches = snapshot.objects.filter(o => builderTableKey(o) === builderTableKey(table) && ['table','view','materialized view'].includes(o.kind))
    if (matches.length !== 1 || !matches[0].columns.length) throw new Error(`Table/view ${table.schema}.${table.name} is unavailable or ambiguous. Refresh schema and select it again.`)
    if (table.catalog && engine !== 'duckdb') throw new Error('Catalog qualifiers are supported only for DuckDB in the builder.')
    return matches[0]
  })
  const alias = (index: number) => q(`t${index+1}`)
  function column(ref: BuilderColumn) {
    const matches = sources[ref.source]?.columns.filter(c => c.name === ref.column) ?? []
    if (matches.length !== 1) throw new Error(`Column t${ref.source+1}.${ref.column} is unavailable or ambiguous. Refresh schema and review the selection.`)
    return { sql: `${alias(ref.source)}.${q(ref.column)}`, type: matches[0].type }
  }
  const table = (i: number) => [...(sources[i].catalog ? [q(sources[i].catalog!)] : []),q(sources[i].schema),q(sources[i].name)].join('.') + ` ${alias(i)}`
  if (query.sources[0].join) throw new Error('The first source cannot have a join.')
  const from = [`FROM ${table(0)}`]
  for (let i=1;i<sources.length;i++) {
    const join = query.sources[i].join
    if (!join) throw new Error(`Choose a join and at least one key for t${i+1}.`)
    const seen = new Set<string>()
    const pairs = join.on.map(pair => {
      if (pair.left.source >= i) throw new Error('Join keys must connect the new table to an earlier source.')
      const key = JSON.stringify(pair)
      if (seen.has(key)) throw new Error('Duplicate join key.'); seen.add(key)
      return `${column(pair.left).sql} = ${column({source:i,column:pair.right}).sql}`
    })
    from.push(`${join.type === 'inner' ? 'INNER' : 'LEFT'} JOIN ${table(i)} ON ${pairs.join(' AND ')}`)
  }
  const aliases = new Set<string>()
  const expressions = query.projections.map(p => {
    const limit = engine === 'postgres' ? 63 : ['mysql','mariadb'].includes(engine) ? 64 : 128
    if (new TextEncoder().encode(p.alias).length > limit) throw new Error(`Output aliases are limited to ${limit} UTF-8 bytes for this engine.`)
    if (aliases.has(p.alias.toLowerCase())) throw new Error('Output aliases must be distinct, ignoring case.'); aliases.add(p.alias.toLowerCase())
    if (p.aggregate === 'count-all') { if (p.column) throw new Error('COUNT(*) does not take a column.'); return 'COUNT(*)' }
    if (!p.column) throw new Error('Select a column for each output.')
    const c = column(p.column)
    if (['sum','avg'].includes(p.aggregate) && !/^(?:tinyint|smallint|mediumint|int|integer|bigint|int[248]|hugeint|uhugeint|u(?:tinyint|smallint|integer|bigint)|decimal|numeric|number|real|float|double|binary_float|binary_double|money|smallmoney)\b/i.test(c.type)) throw new Error(`${p.aggregate.toUpperCase()} needs a numeric column; use the editor for explicit casts.`)
    return p.aggregate === 'none' ? c.sql : p.aggregate === 'count-distinct' ? `COUNT(DISTINCT ${c.sql})` : `${p.aggregate.toUpperCase()}(${c.sql})`
  })
  const parameters: string[] = []
  const condition = (sql: string, predicate: BuilderQuery['filters'][number] | BuilderQuery['having'][number]) => {
    if (predicate.operator === 'is-null' || predicate.operator === 'not-null') {
      if (predicate.parameter) throw new Error('NULL predicates do not take parameters.')
      return `${sql} IS ${predicate.operator === 'not-null' ? 'NOT ' : ''}NULL`
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(predicate.parameter)) throw new Error('Give each filter a parameter name using letters, numbers and underscores, starting with a letter or underscore.')
    if (!parameters.includes(predicate.parameter)) parameters.push(predicate.parameter)
    return `${sql} ${{eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>=',like:'LIKE'}[predicate.operator]} :${predicate.parameter}`
  }
  const tds = ['sqlserver','azure-sql'].includes(engine), grouped = query.projections.some(p => p.aggregate !== 'none')
  const lines = [`SELECT ${query.distinct ? 'DISTINCT ' : ''}${tds ? `TOP (${query.limit}) ` : ''}${expressions.map((sql,i) => `${sql} AS ${q(query.projections[i].alias)}`).join(',\n       ')}`, ...from]
  if (query.filters.length) lines.push(`WHERE ${query.filters.map(p => condition(column(p.column).sql,p)).join(query.filterLogic === 'and' ? '\n  AND ' : '\n  OR ')}`)
  if (grouped) {
    const groups = [...new Set(expressions.filter((_,i) => query.projections[i].aggregate === 'none'))]
    if (groups.length) lines.push(`GROUP BY ${groups.join(', ')}`)
  }
  if (query.having.length) lines.push(`HAVING ${query.having.map(p => {
    if (!query.projections[p.projection] || query.projections[p.projection].aggregate === 'none') throw new Error('HAVING must refer to an aggregate output.')
    return condition(expressions[p.projection],p)
  }).join(query.havingLogic === 'and' ? '\n  AND ' : '\n  OR ')}`)
  if (new Set(query.order.map(o => o.projection)).size !== query.order.length) throw new Error('Choose each sort output once.')
  if (query.order.length) lines.push(`ORDER BY ${query.order.map(o => {
    if (!query.projections[o.projection]) throw new Error('Sort output is unavailable.')
    return `${o.projection+1} ${o.direction.toUpperCase()}`
  }).join(', ')}`)
  if (!tds) lines.push(engine === 'oracle' ? `FETCH FIRST ${query.limit} ROWS ONLY` : `LIMIT ${query.limit}`)
  const sql = lines.join('\n') + ';'
  if (sql.length > 100000) throw new Error('Generated SQL exceeds 100,000 characters. Select fewer fields.')
  return { sql, parameters, engine, database:snapshot.database, fetchedAt:snapshot.fetchedAt, warnings:[
    'No query has been executed. Metadata can change after review; verify the SQL before running it.',
    'Filter values are supplied in the query parameter dialog when you run the SQL. LIKE uses native wildcard patterns; NULL comparisons use IS NULL or IS NOT NULL.',
    'Aggregate, comparison, collation and data-type semantics are native to the engine. Some column types need casts or are not sortable/groupable; use the SQL editor for those cases.',
    'The row limit bounds returned rows, not database work. Without a unique ORDER BY the chosen rows/order can vary.',
    ...(grouped ? ['Every non-aggregate output is included in GROUP BY. COUNT(*) counts joined rows, including an unmatched LEFT JOIN row; COUNT(column) ignores NULLs.'] : []),
    'Opening SQL creates a separate session; temporary tables, attachments, uncommitted changes and session settings are not copied.'
  ] }
}
