import type { GridTable, SchemaTable, SessionInfo } from '../shared/contracts'
import { lexSql } from '../shared/sql/lexer'

/** Recognize only a complete, explicitly qualified SELECT * from one catalog
 * table. The caller opens a fresh grid; it never replays the result SQL. */
export function editableQueryTable(sql: string, session: SessionInfo, tables: SchemaTable[]): GridTable | undefined {
  const tokens = lexSql(sql, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
  if (tokens.some(token => token.kind === 'comment' || !token.closed)) return
  if (tokens.at(-1)?.text === ';') tokens.pop()
  if (tokens.length !== 6 && !(session.engine === 'duckdb' && tokens.length === 8)) return
  if (tokens[0].kind !== 'word' || tokens[0].text.toUpperCase() !== 'SELECT' || tokens[1].text !== '*' || tokens[2].kind !== 'word' || tokens[2].text.toUpperCase() !== 'FROM') return
  const names = tokens.slice(3).filter((_, index) => index % 2 === 0)
  if (tokens.slice(3).some((token, index) => index % 2 ? token.text !== '.' : !['word', 'identifier'].includes(token.kind))) return
  const fold = (value: string) => session.engine === 'oracle' ? value.toUpperCase() : ['postgres', 'duckdb'].includes(session.engine) ? value.toLowerCase() : value
  const values = names.map(token => token.kind === 'word' ? fold(token.value) : token.value)
  const [catalog, schema, name] = values.length === 3 ? values : [undefined, ...values]
  const matches = tables.filter(table => table.kind === 'table' && table.schema === schema && table.name === name && (catalog === undefined || table.catalog === catalog))
  if (matches.length !== 1) return
  const target = matches[0]
  return { schema: target.schema, name: target.name, ...(target.catalog ? { catalog: target.catalog } : {}) }
}
