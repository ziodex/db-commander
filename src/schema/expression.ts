import type { DatabaseEngine } from '../shared/contracts'
import { lexSql } from '../shared/sql/lexer'

/** Check that authored SQL remains inside a single parenthesized expression.
 * This does not determine whether the expression is valid or safe for a
 * particular database: it is displayed in full for explicit review.
 */
export function schemaExpression(input: string, engine: DatabaseEngine): string {
  const sql = input.trim()
  if (!sql || input.length > 4000 || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(input)) throw new Error('Enter a single-line SQL expression of at most 4,000 characters without control characters.')
  // MySQL string and identifier quoting depends on the connection SQL mode.
  // Require structural safety under every supported mode rather than assuming it.
  const modes = engine === 'mysql' || engine === 'mariadb'
    ? [[false, false], [false, true], [true, false], [true, true]] as const
    : [[false, false]] as const
  for (const [noBackslashEscapes, ansiQuotes] of modes) {
    const tokens = lexSql(sql, engine, noBackslashEscapes, ansiQuotes)
    const stack: string[] = []
    for (const token of tokens) {
      if (!token.closed || token.kind === 'comment') throw new Error('Expressions cannot contain comments or unfinished strings or identifiers.')
      // PostgreSQL can also treat backslashes in ordinary strings as escapes
      // when standard_conforming_strings is disabled. E strings are unambiguous.
      if (engine === 'postgres' && token.kind === 'string' && /^(?:n)?'/i.test(token.text) && token.text.includes('\\')) throw new Error('Use an explicit E string for backslashes in PostgreSQL expressions.')
      if (token.kind !== 'symbol') continue
      if (token.text === ';') throw new Error('Expressions cannot contain statement separators.')
      if (token.text === '(' || token.text === '[') stack.push(token.text)
      else if (token.text === ')' || token.text === ']') {
        if (stack.pop() !== (token.text === ')' ? '(' : '[')) throw new Error('Expression delimiters are unbalanced.')
      } else if (token.text === ',' && !stack.length) throw new Error('Use one expression, not a list of expressions.')
      if (stack.length > 100) throw new Error('Expression nesting exceeds 100 levels.')
    }
    if (!tokens.length || stack.length) throw new Error('Expression delimiters are unbalanced.')
  }
  return sql
}
