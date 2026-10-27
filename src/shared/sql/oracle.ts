/** Oracle SQL ends at ';'; PL/SQL units end at a slash on its own line.
 * The last PL/SQL unit may omit the slash. SQL*Plus commands are not executed.
 */
export function splitOracleScript(sql: string, located?: (start: number, end: number) => void, allowParameters = false): string[] {
  const statements: string[] = []
  let start = 0, quote = '', alternative = '', comment = false, line = false
  let words: string[] = [], hasBind = false
  const plsql = () => /^(BEGIN|DECLARE)\b|^CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/.test(words.join(' '))
  const finish = (end: number) => {
    const part = sql.slice(start, end).trim()
    const content = part.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '')
    if (content) {
      if (/^WITH\s+(FUNCTION|PROCEDURE)\b/.test(words.join(' '))) throw new Error('WITH PL/SQL declarations are not supported in scripts yet.')
      if (/^(SET(?!\s+(TRANSACTION|CONSTRAINTS)\b)|SPOOL|PROMPT|ACCEPT|DEFINE|UNDEFINE|VARIABLE|PRINT|EXEC|EXECUTE|CONNECT|DISCONNECT|EXIT|QUIT|WHENEVER|START|HOST|DESCRIBE|DESC|SHOW)\b/.test(words.join(' ')) || content.startsWith('@')) {
        throw new Error('SQL*Plus commands are not supported. Use SQL or a BEGIN … END; PL/SQL block.')
      }
      if (hasBind && !allowParameters) throw new Error('Bind parameters require one SQL statement and values in the Run prompt. Declare PL/SQL variables inside the block.')
      statements.push(part)
      const begin = start + sql.slice(start, end).indexOf(part); located?.(begin, begin + part.length)
    }
    words = []; hasBind = false
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1]
    if (line) { if (c === '\n') line = false; continue }
    if (comment) { if (c === '*' && next === '/') { comment = false; i++ }; continue }
    if (alternative) { if (c === alternative && next === "'") { alternative = ''; i++ }; continue }
    if (quote) { if (c === quote) { if (next === quote) i++; else quote = '' }; continue }
    if (c === '-' && next === '-') { line = true; i++; continue }
    if (c === '/' && next === '*') { comment = true; i++; continue }
    const national = (c === 'n' || c === 'N') && (next === 'q' || next === 'Q') && sql[i + 2] === "'"
    if (national || ((c === 'q' || c === 'Q') && next === "'")) {
      const open = sql[i + (national ? 3 : 2)]
      if (!open || /\s/.test(open)) throw new Error('Invalid Oracle alternative quote.')
      alternative = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open
      i += national ? 3 : 2; continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '/' && /^\s*$/.test(sql.slice(sql.lastIndexOf('\n', i - 1) + 1, i)) && /^\s*(?:--[^\n]*)?$/.test(sql.slice(i + 1, sql.indexOf('\n', i) === -1 ? sql.length : sql.indexOf('\n', i)))) {
      finish(i); start = i + 1; continue
    }
    if (c === ':' && next !== '=') {
      // Trigger correlation names are server-side values, not client binds.
      const trigger = /^CREATE\b.*\bTRIGGER\b/.test(words.join(' '))
      if (!(trigger && /^(NEW|OLD|PARENT)\b/i.test(sql.slice(i + 1)))) hasBind = true
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[\w$#]+/)![0]
      if (words.length < 12) words.push(word.toUpperCase())
      i += word.length - 1; continue
    }
    if (c === ';' && !plsql()) { finish(i); start = i + 1 }
  }
  if (quote || alternative || comment) throw new Error('Unterminated Oracle string, identifier or comment.')
  finish(sql.length)
  return statements
}
