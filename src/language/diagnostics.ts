import { ANALYSIS_LIMIT, parentheses, sqlTokens, symbol, word, type AnalysisDialect, type SourceRange } from './syntax'

export interface SqlDiagnostic extends SourceRange { message: string }

export function diagnoseSql(sql: string, dialect: AnalysisDialect): SqlDiagnostic[] {
  if (sql.length > ANALYSIS_LIMIT) return []
  const tokens = sqlTokens(sql, dialect)
  const result: SqlDiagnostic[] = []
  const add = ({ start, end }: SourceRange, message: string) => {
    if (result.length < 50) result.push({ start, end, message })
  }
  for (const token of tokens) {
    if (token.closed || token.kind === 'comment' && !token.text.startsWith('/*')) continue
    add(token, token.kind === 'comment' ? 'Unclosed block comment.' : token.kind === 'identifier' ? 'Unclosed quoted identifier.' : 'Unclosed SQL string.')
    // An unfinished quote/comment can swallow closing delimiters.
    return result
  }
  const { open, extra } = parentheses(tokens)
  for (const index of open) add(tokens[index], 'Opening parenthesis has no matching close.')
  for (const index of extra) add(tokens[index], 'Closing parenthesis has no matching open.')

  const first = tokens.find(token => token.kind !== 'comment')
  if (word(first) === 'PRAGMA' && dialect.engine !== 'sqlite' && dialect.engine !== 'duckdb') {
    add(first!, 'PRAGMA is a SQLite or DuckDB statement. Check the selected editor dialect.')
  }
  const query = tokens.filter(token => token.kind !== 'comment')
  if (['SELECT', 'WITH'].includes(word(first))) {
    const trailing = symbol(query.at(-1), ';') ? query.at(-2) : query.at(-1)
    const missing = word(trailing)
    if (['FROM', 'JOIN', 'WHERE', 'HAVING', 'ON'].includes(missing) && trailing !== first &&
        !symbol(query[query.indexOf(trailing!) - 1], '.')) {
      add(trailing!, `Complete the ${missing} clause.`)
    }
  }
  return result
}
