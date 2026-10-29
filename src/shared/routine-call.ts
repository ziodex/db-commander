import type { CatalogSection, ObjectDetail } from './catalog'
import type { DatabaseEngine } from './database-engines'
import { quoteIdentifier } from './sql/common'
import { lexSql } from './sql/lexer'

export interface RoutineArgument { placeholder: string; name: string; type: string; mode: string }
export interface RoutineCall { sql?: string; arguments: RoutineArgument[]; notice: string }
function value(section: CatalogSection, row: (string | null)[], column: string) { return row[section.columns.indexOf(column)] ?? null }

/** format_type supplies SQL, but catalog names remain untrusted data. */
function safePostgresType(type: string) {
  const tokens = lexSql(type, 'postgres')
  let depth = 0, brackets = 0
  if (!tokens.length || tokens.some(token => !token.closed || token.kind === 'string' || token.kind === 'comment' || token.kind === 'symbol' && !['.', ',', '(', ')', '[', ']'].includes(token.text))) return false
  for (const token of tokens) {
    if (token.text === '(') depth++
    if (token.text === ')' && --depth < 0) return false
    if (token.text === '[') brackets++
    if (token.text === ']' && --brackets < 0) return false
  }
  return depth === 0 && brackets === 0
}

/** Builds a query-tab template only. Values are supplied through normal binds. */
export function routineCall(engine: DatabaseEngine, detail: ObjectDetail): RoutineCall {
  const object = detail.object, none = (notice: string): RoutineCall => ({ arguments: [], notice })
  if (!['function', 'procedure', 'macro'].includes(object.kind)) return none('Parameter-aware calls are available for supported routines.')
  const q = (name: string) => quoteIdentifier(name, engine), full = [...(engine === 'duckdb' && object.catalog ? [q(object.catalog)] : []), q(object.schema), q(object.name)].join('.')
  const args: RoutineArgument[] = [], callArguments: (RoutineArgument | null)[] = []
  let table = false
  if (engine === 'duckdb' && object.kind === 'macro') {
    const section = detail.sections.find(item => item.title === 'Macro'), row = section?.rows[0]
    if (!section || section.truncated || !row) return none('Macro parameters are unavailable or incomplete. Inspect the definition before calling it.')
    try {
      const names: unknown = JSON.parse(value(section, row, 'Parameter names (JSON)') ?? '')
      if (!Array.isArray(names) || names.length > 100 || names.some(name => typeof name !== 'string' || !name || name.length > 255)) return none('Macro parameters are unavailable or incomplete. Inspect the definition before calling it.')
      names.forEach((name, i) => { const arg = { placeholder: `arg${i + 1}`, name, type: 'Inferred by DuckDB', mode: 'IN' }; args.push(arg); callArguments.push(arg) })
      table = value(section, row, 'Kind') === 'table_macro'
    } catch { return none('Macro parameters are unavailable or incomplete. Inspect the definition before calling it.') }
  } else {
    const section = detail.sections.find(item => item.title === (engine === 'oracle' ? 'Arguments' : 'Parameters'))
    if (!section || section.truncated) return none('Routine parameters are unavailable or incomplete. Inspect the definition before calling it.')
    if (['sqlserver','azure-sql'].includes(engine)) {
      const kind = detail.sections.find(item => item.title === 'Routine')?.rows[0]?.[0]?.trim()
      if (!kind || !(object.kind === 'procedure' ? ['P','PC'] : ['FN','FS','IF','TF','FT']).includes(kind)) return none('The SQL Server routine kind is unavailable. Inspect its definition before calling it.')
      table = ['IF','TF','FT'].includes(kind)
    }
    for (const row of section.rows) {
      const positionText = value(section, row, 'Position'), position = Number(positionText)
      if (!positionText || !/^\d+$/.test(positionText) || !Number.isSafeInteger(position)) return none('Routine parameter positions are incomplete. Inspect the definition before calling it.')
      if (position === 0) continue
      const output = value(section, row, 'Output')
      const mode = engine === 'postgres' ? value(section, row, 'Mode') : engine === 'oracle' ? value(section, row, 'Mode') : ['sqlserver','azure-sql'].includes(engine) ? ['1','true'].includes(output ?? '') ? 'OUT' : ['0','false'].includes(output ?? '') ? 'IN' : null : value(section, row, 'Mode')
      if (engine === 'postgres' && ['o','t'].includes(mode ?? '')) { if (object.kind === 'procedure' && mode === 'o') callArguments.push(null); continue }
      if (!(engine === 'postgres' ? ['i','b'].includes(mode ?? '') : mode === 'IN')) return none('This routine has output, variadic or unsupported parameters. Inspect its definition and use explicit SQL.')
      const type = value(section, row, 'Type')
      if (!type || engine === 'postgres' && !safePostgresType(type)) return none('A parameter type is unavailable or cannot be represented safely. Inspect the definition before calling it.')
      const arg = { placeholder: `arg${args.length + 1}`, name: value(section, row, engine === 'oracle' ? 'Argument' : 'Name') ?? `Argument ${position}`, type, mode: mode === 'b' ? 'INOUT' : 'IN' }
      args.push(arg); callArguments.push(arg)
    }
  }
  if (args.length > 100) return none('This routine has more than 100 parameters. Use explicit SQL.')
  const argumentsSql = callArguments.map(arg => !arg ? 'NULL' : engine === 'postgres' ? `CAST(:${arg.placeholder} AS ${arg.type})` : `:${arg.placeholder}`).join(', ')
  const sql = object.kind === 'procedure' ? ['sqlserver','azure-sql'].includes(engine) ? `EXEC ${full}${argumentsSql ? ' ' + argumentsSql : ''};` : `CALL ${full}(${argumentsSql});` : `SELECT ${table ? '* FROM ' : ''}${full}(${argumentsSql})${engine === 'oracle' ? ' FROM dual' : ''};`
  return { sql, arguments: args, notice: 'Opening a call does not execute it. Running a routine can change data or session state. Values are entered for this run and bound as data; refresh metadata if the routine changes.' }
}
