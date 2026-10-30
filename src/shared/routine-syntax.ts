import type { DatabaseEngine } from './database-engines'
import type { Token } from './sql/lexer'

/** Accept only a direct positional routine call, with no additional commands. */
export function isBoundRoutineCall(tokens: Token[], engine: DatabaseEngine) {
  const tds = engine === 'sqlserver' || engine === 'azure-sql', first = tokens[0]?.value.toUpperCase()
  if (!(tds ? first === 'EXEC' || first === 'EXECUTE' : ['postgres','mysql','mariadb','oracle'].includes(engine) && first === 'CALL')) return false
  let i = 1
  const ident = (token: Token | undefined) => Boolean(token && (token.kind === 'identifier' || token.kind === 'word' && !token.value.startsWith('@')))
  if (!ident(tokens[i++])) throw new Error('A bound routine call must name a procedure directly.')
  let parts = 1
  while (tokens[i]?.text === '.') { i++; if (!ident(tokens[i++]) || ++parts > 3) throw new Error('A bound routine name is invalid.') }
  if (!tds && tokens[i++]?.text !== '(') throw new Error('A bound CALL requires parentheses.')
  const parameter = () => {
    if (tokens[i]?.text !== ':' || tokens[i + 1]?.kind !== 'word' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tokens[i + 1].value) || tokens[i].end !== tokens[i + 1].start) return false
    i += 2; return true
  }
  const argument = () => {
    if (parameter()) return
    if (!tds && tokens[i]?.kind === 'word' && tokens[i].value.toUpperCase() === 'NULL') { i++; return }
    if (!tds && tokens[i]?.kind === 'word' && tokens[i].value.toUpperCase() === 'CAST') {
      i++; if (tokens[i++]?.text !== '(' || !parameter() || tokens[i++]?.value.toUpperCase() !== 'AS') throw new Error('A routine CAST must contain one named parameter and a type.')
      let depth = 0, brackets = 0, count = 0
      while (i < tokens.length) {
        const token = tokens[i]
        if (token.text === ')' && depth === 0 && brackets === 0) break
        if (token.kind === 'string' || token.kind === 'comment' || token.kind === 'symbol' && !['.', ',', '(', ')', '[', ']'].includes(token.text) && !/^\d$/.test(token.text)) throw new Error('A routine parameter type is invalid.')
        if (token.text === '(') depth++
        if (token.text === ')' && --depth < 0) throw new Error('A routine parameter type is invalid.')
        if (token.text === '[') brackets++
        if (token.text === ']' && --brackets < 0) throw new Error('A routine parameter type is invalid.')
        count++; i++
      }
      if (!count || depth || brackets || tokens[i++]?.text !== ')') throw new Error('A routine parameter type is incomplete.')
      return
    }
    throw new Error('A bound routine call accepts only named parameters and NULL output placeholders.')
  }
  if (tds && i === tokens.length) return true
  if (!tds && tokens[i]?.text === ')') { i++; if (i !== tokens.length) throw new Error('Run additional statements separately.'); return true }
  argument()
  while (tokens[i]?.text === ',') { i++; argument() }
  if (!tds && tokens[i++]?.text !== ')') throw new Error('The routine argument list is incomplete.')
  if (i !== tokens.length) throw new Error('Run additional statements separately from the routine call.')
  return true
}
