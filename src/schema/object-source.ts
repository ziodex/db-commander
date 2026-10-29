import { executionUnits } from '../language/execution'
import type { ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { objectScripts } from '../shared/object-scripts'
import type { SchemaChange } from '../shared/schema-changes'
import { transactionalDdl } from '../shared/schema-changes'
import { lexSql, type Token } from '../shared/sql/lexer'

type SourceEdit = Extract<SchemaChange, { action: 'edit-source' }>

function identifier(token: Token | undefined, wanted: string, engine: SessionInfo['engine']) {
  if (!token || !['word', 'identifier'].includes(token.kind)) return false
  if (token.kind === 'identifier') return token.value === wanted
  if (engine === 'postgres') return token.value.toLowerCase() === wanted
  if (engine === 'oracle') return token.value.toUpperCase() === wanted
  return token.value.toLowerCase() === wanted.toLowerCase()
}

/** Prepare an explicitly reviewed declaration; the driver checks one unit again. */
export function objectSourceSql(change: SourceEdit, session: SessionInfo, detail?: ObjectDetail) {
  const { engine } = session, { target, sql } = change
  if (!['view', 'function', 'procedure', 'trigger', 'macro'].includes(target.kind)) throw new Error('Select a view, routine or trigger to edit its source.')
  if (!detail?.definition.sql || detail.definition.truncated) throw new Error('The complete original definition is unavailable. Refresh the object before editing.')
  if (detail.definition.sql !== change.baseDefinition) throw new Error('The object definition changed since it was loaded. Compare your draft with a fresh definition before reviewing again.')
  if (sql.includes('\0')) throw new Error('SQL cannot contain NUL characters.')
  const units = executionUnits(sql, engine, session.mysqlSqlMode)
  if (units.length !== 1) throw new Error('Edit exactly one object declaration. Run additional statements separately after reviewing them.')
  if (['mysql', 'mariadb'].includes(engine) && /\/\*(?:!|M!)/i.test(units[0].sql)) throw new Error('Executable MySQL comments are not supported in a source review. Review them separately in the SQL editor.')
  const tokens = lexSql(units[0].sql, engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes).filter(token => token.kind !== 'comment')
  if (tokens.some(token => !token.closed)) throw new Error('Finish the SQL string, identifier or comment before reviewing.')
  // SQL Server reports a batch as one execution unit. A view definition has
  // no procedural body, so refuse any command after its terminator explicitly.
  if (['sqlserver', 'azure-sql'].includes(engine) && target.kind === 'view' && tokens.some((token, index) => token.text === ';' && index !== tokens.length - 1)) throw new Error('Run additional statements separately from the view declaration.')
  const first = tokens[0]?.value.toUpperCase()
  if (!['CREATE', 'ALTER'].includes(first ?? '')) throw new Error('The reviewed source must begin with CREATE or ALTER.')
  let kindIndex = 1
  if (tokens[kindIndex]?.value.toUpperCase() === 'OR' && ['REPLACE', 'ALTER'].includes(tokens[kindIndex + 1]?.value.toUpperCase())) kindIndex += 2
  if (['mysql', 'mariadb'].includes(engine)) {
    if (tokens[kindIndex]?.value.toUpperCase() === 'ALGORITHM' && tokens[kindIndex + 1]?.text === '=' && ['UNDEFINED', 'MERGE', 'TEMPTABLE'].includes(tokens[kindIndex + 2]?.value.toUpperCase())) kindIndex += 3
    if (tokens[kindIndex]?.value.toUpperCase() === 'DEFINER' && tokens[kindIndex + 1]?.text === '=') {
      const user = tokens[kindIndex + 2], host = tokens[kindIndex + 3]
      if (!user || !['word', 'identifier', 'string'].includes(user.kind) || !host || host.kind !== 'word' || !host.value.startsWith('@')) throw new Error('The definer syntax could not be verified. Review it separately in the SQL editor.')
      kindIndex += 4
      if (host.value === '@') {
        if (!tokens[kindIndex] || !['word', 'identifier', 'string'].includes(tokens[kindIndex].kind)) throw new Error('The definer host is incomplete.')
        kindIndex++
      }
    }
    if (tokens[kindIndex]?.value.toUpperCase() === 'SQL' && tokens[kindIndex + 1]?.value.toUpperCase() === 'SECURITY' && ['DEFINER', 'INVOKER'].includes(tokens[kindIndex + 2]?.value.toUpperCase())) kindIndex += 3
  }
  while (['EDITIONABLE', 'NONEDITIONABLE', 'FORCE', 'NOFORCE', 'TEMP', 'TEMPORARY'].includes(tokens[kindIndex]?.value.toUpperCase())) kindIndex++
  if (tokens[kindIndex]?.kind !== 'word' || tokens[kindIndex].value.toLowerCase() !== target.kind) throw new Error(`The source must directly declare the selected ${target.kind}. Unsupported declaration options can be reviewed in the SQL editor.`)
  const names: Token[] = [], start = kindIndex + 1
  let index = start
  while (tokens[index] && ['word', 'identifier'].includes(tokens[index].kind)) {
    names.push(tokens[index++])
    if (tokens[index]?.text !== '.') break
    index++
  }
  const expected = engine === 'postgres' && target.kind === 'trigger' ? [target.name] : [target.schema, target.name]
  if (engine === 'duckdb' && target.catalog && names.length === 3) expected.unshift(target.catalog)
  const defaultSchema = engine === 'sqlite' && target.schema === 'main' || ['mysql', 'mariadb'].includes(engine) && target.schema === session.database || engine === 'oracle' && target.schema === session.user.toUpperCase()
  if (names.length === 1 && expected.length === 2 && defaultSchema) expected.shift()
  if (names.length !== expected.length || !names.every((token, i) => identifier(token, expected[i], engine))) throw new Error('The declaration must name the selected object and schema. Qualify the name explicitly, then review again.')
  if (engine === 'duckdb' && target.catalog && names.length !== 3 && target.catalog !== session.database) throw new Error('Qualify the selected DuckDB catalog in the declaration.')
  if (target.kind === 'trigger') {
    if (!target.parent) throw new Error('The trigger parent is unavailable. Refresh its metadata before editing.')
    const on = tokens.findIndex((token, i) => i >= index && token.kind === 'word' && token.value.toUpperCase() === 'ON')
    const firstName = tokens[on + 1], dot = tokens[on + 2], secondName = tokens[on + 3]
    const matchesParent = on >= 0 && (dot?.text === '.'
      ? identifier(firstName, target.schema, engine) && identifier(secondName, target.parent, engine)
      : (engine === 'sqlite' || ['mysql', 'mariadb'].includes(engine) && target.schema === session.database || engine === 'oracle' && target.schema === session.user.toUpperCase()) && identifier(firstName, target.parent, engine))
    if (!matchesParent) throw new Error('The trigger must remain on the selected parent table. Qualify the table if needed.')
  }

  const replaceByDrop = engine === 'sqlite' || ['mysql', 'mariadb'].includes(engine) && target.kind !== 'view'
  if (replaceByDrop && first !== 'CREATE') throw new Error('This engine replaces this object using a reviewed DROP followed by CREATE. Supply its CREATE declaration.')
  const drop = replaceByDrop ? objectScripts(engine, target, detail).drop : undefined
  if (replaceByDrop && !drop) throw new Error('A safe drop script is unavailable for this object. Use separately reviewed SQL.')
  const commands = [...(drop ? [drop] : []), sql]
  const transactional = transactionalDdl(engine), begin = ['sqlserver', 'azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : engine === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN'
  return {
    commands, begin: transactional ? begin : undefined,
    sql: [...(transactional ? [begin + ';'] : []), ...commands].join('\n\n'),
    transaction: transactional ? 'transactional' as const : 'implicit-commit' as const,
    destructive: true,
    warnings: [
      'The edited declaration is authored SQL. Review its target, body, permissions and side effects; the database validates its semantics.',
      'The target definition is checked again immediately before execution, but it is not locked against changes by other sessions.',
      'Dependencies are not locked and can change after review. Functions, triggers and views can affect other objects and future operations.',
      ...(target.kind === 'function' || target.kind === 'procedure' ? ['Changing a routine signature may create a different overload or change callers. Review the signature and dependent objects carefully.'] : []),
      ...(detail.definition.source === 'generated' ? ['The original definition is a generated summary and may omit options, ownership or grants. Compare it with authoritative database metadata before applying.'] : []),
      ...(target.kind === 'macro' && engine === 'duckdb' ? ['DuckDB exposes the macro body and parameter names but not a complete declaration here. Parameter defaults and types may be omitted; review and restore them explicitly.'] : []),
      ...(drop ? ['Replacement explicitly drops the existing object before recreating it. Dependencies, triggers, permissions or grants can be lost or prevent the drop. Review the complete SQL and dependencies.'] : []),
      ...(drop && !transactional ? ['Each DDL statement commits independently. If creation fails or is interrupted after the drop, the original object is gone; inspect and repair it explicitly.'] : []),
      transactional ? 'The change is applied in this tab’s transaction. Commit or roll back explicitly.' : 'The database can commit DDL implicitly, including on error; it cannot be assumed rolled back.'
    ]
  }
}
