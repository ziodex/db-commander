import { gridQuerySchema, type Cell, type GridColumn, type GridQueryOptions, type GridTable } from '../shared/contracts'
import { GridSql } from './grid-sql'

export function browseColumn(d: GridSql, column: GridColumn): GridColumn {
  const textual = /^(?:text|tinytext|mediumtext|longtext|varchar|varchar2|nvarchar|nvarchar2|char|nchar|character)(?:\b|\()/i.test(column.type)
  const filterable = displayable(d, column) && !/^(?:jsonb?|blob|binary|varbinary|bytea)(?:\b|\()/i.test(column.type) && !(d.mssql && /^(text|ntext|rowversion|timestamp)$/i.test(column.type))
  return { ...column, textual, filterable, sortable: filterable }
}

export function displayable(d: GridSql, column: GridColumn) {
  return d.supported(column) || d.engine === 'sqlite' || /^(?:real|float|double|double precision|binary_float|binary_double)(?:\(\d+\))?$/i.test(column.type)
}

/** Only catalog-verified identifiers, fixed operators and bound values reach SQL.
 * Sort native values (never display casts); append every PK column to break ties.
 * Read one extra row to detect a next page without a whole-table COUNT. */
export function browseSelect(d: GridSql, table: GridTable, columns: GridColumn[], input?: GridQueryOptions) {
  const query = gridQuerySchema.parse(input ?? {}), values: Cell[] = []
  const column = (name: string) => {
    const result = columns.find(c => c.name === name)
    if (!result) throw new Error(`Column “${name}” no longer exists. Reopen the table and review the filters.`)
    return browseColumn(d, result)
  }
  const where = query.filters.map(filter => {
    const c = column(filter.column), name = d.q(c.name)
    if (!('value' in filter)) return `${name} IS ${filter.operator === 'not-null' ? 'NOT ' : ''}NULL`
    if (!c.filterable) throw new Error(`Column “${c.name}” cannot be filtered by value in this browser. Use SQL for this type.`)
    if (filter.operator === 'contains' || filter.operator === 'starts-with') {
      if (!c.textual) throw new Error('Contains and starts with filters require a text column.')
      // ESCAPE ! works independently of MySQL NO_BACKSLASH_ESCAPES. SQL Server
      // also treats [ as a pattern operator; the user's input is literal text.
      const literal = filter.value.replace(d.mssql ? /[!%_\[]/g : /[!%_]/g, value => `!${value}`)
      values.push((filter.operator === 'contains' ? '%' : '') + literal + '%')
      return `${name} LIKE ${d.p(values.length)} ESCAPE '!'`
    }
    values.push(filter.value)
    const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }
    // PostgreSQL infers a parameter's type from the column without its typmod.
    // CAST(... AS varchar(n)/numeric(p,s)) would truncate/round filter input.
    return `${name} ${operators[filter.operator]} ${d.engine === 'postgres' ? d.p(values.length) : d.value(c, values.length)}`
  })
  const seen = new Set<string>(), sort = query.sort.map(item => {
    const c = column(item.column)
    if (seen.has(c.name)) throw new Error('Choose each sort column only once.')
    if (!c.sortable) throw new Error(`Column “${c.name}” cannot be sorted in this browser. Use SQL for this type.`)
    seen.add(c.name); return item
  })
  const keys = columns.filter(c => c.primaryKey && browseColumn(d, c).sortable)
  for (const key of keys) if (!seen.has(key.name)) sort.push({ column: key.name, direction: 'asc' })
  if (!sort.length) {
    const fallback = columns.find(c => browseColumn(d, c).sortable)
    if (fallback) sort.push({ column: fallback.name, direction: 'asc' })
  }
  const order = sort.flatMap(item => {
    const name = d.q(item.column), nullable = columns.find(c => c.name === item.column)!.nullable
    return [...(nullable ? [`CASE WHEN ${name} IS NULL THEN 1 ELSE 0 END ASC`] : []), `${name} ${item.direction === 'desc' ? 'DESC' : 'ASC'}`]
  }).join(',') || '1'
  const expressions = columns.map((c, index) => `${displayable(d, c) ? d.expression(c) : `CASE WHEN ${d.q(c.name)} IS NULL THEN NULL ELSE '[Use SQL to inspect this type]' END`} AS ${d.q(`sc_${index}`)}`)
  const limit = query.pageSize + 1
  const paging = d.mssql || d.engine === 'oracle' ? `OFFSET ${query.offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : `LIMIT ${limit} OFFSET ${query.offset}`
  const from = `FROM ${d.table(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`
  return { sql: `SELECT ${expressions.join(',')} ${from} ${paging}`, from, values, query,
    notice: `${keys.length ? 'Primary-key columns break sort ties.' : 'No sortable primary key: rows tied by the sort may move between pages.'} Pages are live reads; concurrent changes can move rows. Filters use the database’s comparison and collation rules. NULLs sort last.` }
}
