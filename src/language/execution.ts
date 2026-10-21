import type { DatabaseEngine, SessionInfo } from '../shared/contracts'
import type { FailureSource } from '../shared/execution'
import { splitPostgresScript } from '../shared/sql/common'
import { splitMysqlScript } from '../shared/sql/mysql'
import { splitOracleScript } from '../shared/sql/oracle'
import { splitSqlServerBatches } from '../shared/sql/sqlserver'
import { lexSql } from '../shared/sql/lexer'

interface SqlUnit { start: number; end: number; sql: string; delimiter?: string }
type Mode = SessionInfo['mysqlSqlMode']
/** Uses the same network-driver boundaries as script execution. SQLite trigger
 * bodies need BEGIN/END and CASE tracking; the native engine still validates SQL. */
export function executionUnits(sql: string, engine: DatabaseEngine, mode?: Mode): SqlUnit[] {
  const units: SqlUnit[] = []
  const add = (start: number, end: number, delimiter?: string) => units.push({ start, end, sql: sql.slice(start, end), delimiter })
  if (engine === 'mysql' || engine === 'mariadb') splitMysqlScript(sql, mode, add)
  else if (engine === 'oracle') splitOracleScript(sql, add, true)
  else if (engine === 'sqlserver' || engine === 'azure-sql') splitSqlServerBatches(sql, add)
  else if (engine !== 'sqlite') splitPostgresScript(sql, add)
  else {
    const tokens = lexSql(sql, engine)
    if (tokens.some(token => !token.closed && (token.kind !== 'comment' || token.text.startsWith('/*')))) throw new Error('Finish the SQL string, identifier or comment before running the current statement.')
    let start = 0, body = 0, cases = 0, words: string[] = [], hasSql = false
    const finish = (end: number) => {
      const text = sql.slice(start, end).trim()
      if (hasSql) { const begin = start + sql.slice(start, end).indexOf(text); add(begin, begin + text.length) }
      start = end; body = 0; cases = 0; words = []; hasSql = false
    }
    for (const token of tokens) {
      if (token.kind === 'comment') continue
      if (token.kind === 'word' && words.length < 4) words.push(token.text.toUpperCase())
      const trigger = /^CREATE (?:TEMP(?:ORARY)? )?TRIGGER\b/.test(words.join(' '))
      if (trigger && token.kind === 'word') {
        const word = token.text.toUpperCase()
        if (word === 'BEGIN') body++
        if (body && word === 'CASE') cases++
        if (word === 'END') { if (cases) cases--; else if (body) body-- }
      }
      if (token.text === ';' && token.kind === 'symbol' && !body) { finish(token.end); continue }
      hasSql = true
    }
    if (body || cases) throw new Error('Finish the SQLite trigger body before running the current statement.')
    finish(sql.length)
  }
  return units
}

export function currentExecution(sql: string, offset: number, engine: DatabaseEngine, mode?: Mode) {
  if (!Number.isInteger(offset) || offset < 0 || offset > sql.length) throw new Error('Place the cursor inside the SQL to execute.')
  const units = executionUnits(sql, engine, mode)
  if (engine === 'postgres' || engine === 'duckdb') {
    const words = lexSql(sql, engine).filter(token => token.kind === 'word').map(token => token.text.toUpperCase()).join(' ')
    if (/\bBEGIN ATOMIC\b|\bCREATE (?:OR REPLACE )?RULE\b/.test(words)) throw new Error('Select SQL-standard routine bodies or rules explicitly; current-statement boundaries are unavailable for this script.')
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    for (const candidate of units) {
      const words = lexSql(candidate.sql, engine, mode?.noBackslashEscapes, mode?.ansiQuotes).filter(token => token.kind === 'word').slice(0, 40).map(token => token.text.toUpperCase()).join(' ')
      if (candidate.delimiter === ';' && /^CREATE\b.*\b(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/.test(words)) throw new Error('Use an explicit DELIMITER around MySQL/MariaDB routines before running the current statement.')
    }
  }
  const unit = units.find(unit => offset >= unit.start && offset <= unit.end) ?? units.find(unit => {
    const delimiter = unit.delimiter ?? ';'
    return offset === unit.end + delimiter.length && sql.startsWith(delimiter, unit.end)
  })
  if (!unit) throw new Error('Place the cursor inside a SQL statement or select the SQL to execute.')
  // A routine with internal semicolons needs its original client delimiter.
  // Ordinary DML uses the default delimiter so bound parameters still work.
  const custom = unit.delimiter && unit.delimiter !== ';' && lexSql(unit.sql, engine, mode?.noBackslashEscapes, mode?.ansiQuotes).some(token => token.kind === 'symbol' && token.text === ';')
  const prefix = custom ? `DELIMITER ${unit.delimiter}\n` : ''
  return { sql: prefix + unit.sql + (custom ? unit.delimiter : ''), start: unit.start, end: unit.end, prefixLength: prefix.length }
}

/** Native parser failures without a known unit stay attached to the submitted
 * script. Bound SQL positions may differ after parameter rewriting. */
export function failureSource(sql: string, engine: DatabaseEngine, index?: number, bound = false, mode?: Mode, nativeCount?: number): FailureSource {
  const fallback: FailureSource = { start: 0, end: sql.length, scope: 'script' }
  if (bound || index === undefined || index < 0) return fallback
  try {
    const units = executionUnits(sql, engine, mode)
    if (nativeCount !== undefined && units.length !== nativeCount) return fallback
    const unit = units[index]
    return unit ? { start: unit.start, end: unit.end, scope: engine === 'sqlserver' || engine === 'azure-sql' ? 'batch' : 'statement' } : fallback
  } catch { return fallback }
}
