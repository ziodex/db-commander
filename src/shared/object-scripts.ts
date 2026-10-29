import type { CatalogObject, ObjectDetail } from './catalog'
import type { DatabaseEngine } from './database-engines'
import { quoteIdentifier } from './sql/common'
import { lexSql } from './sql/lexer'

export interface ObjectScripts { create?: string; alter?: string; drop?: string; notice: string }

/** Catalogs can omit the namespace in their CREATE text. Make an unqualified
 * draft point at the selected object without changing the rest of the source. */
export function qualifySourceDeclaration(engine: DatabaseEngine, object: CatalogObject, sql: string) {
  // PostgreSQL trigger names are scoped by their ON table, not schema-qualified.
  if (engine === 'postgres' && object.kind === 'trigger') return sql
  const tokens = lexSql(sql, engine).filter(token => token.kind !== 'comment')
  const kind = tokens.findIndex((token, index) => index > 0 && index < 50 && token.kind === 'word' && token.value.toLowerCase() === object.kind)
  const name = tokens[kind + 1], after = tokens[kind + 2]
  if (kind < 0 || !name || !['word', 'identifier'].includes(name.kind) || after?.text === '.' || name.value.toLowerCase() !== object.name.toLowerCase()) return sql
  const q = (value: string) => quoteIdentifier(value, engine)
  const qualified = [...(engine === 'duckdb' && object.catalog ? [q(object.catalog)] : []), q(object.schema), q(object.name)].join('.')
  return sql.slice(0, name.start) + qualified + sql.slice(name.end)
}

/** A catalog signature is display data, not an authority to add SQL commands. */
function safePostgresSignature(signature: string | undefined) {
  if (signature === undefined) return undefined
  const tokens = lexSql(signature, 'postgres')
  if (tokens.some(token => !token.closed || token.kind === 'comment' || token.kind === 'string' || token.kind === 'symbol' && !['.', ',', '(', ')', '[', ']'].includes(token.text))) return undefined
  return signature
}

/** These are editable scripts for a query tab. They never execute by themselves. */
export function objectScripts(engine: DatabaseEngine, object: CatalogObject, detail: ObjectDetail): ObjectScripts {
  const q = (value: string) => quoteIdentifier(value, engine)
  const qualified = [...(engine === 'duckdb' && object.catalog ? [q(object.catalog)] : []), q(object.schema), q(object.name)].join('.')
  const source = detail.definition.sql && !detail.definition.truncated ? detail.definition.sql : undefined
  const kind = object.kind
  const applicable = ['view', 'function', 'procedure', 'trigger', 'macro'].includes(kind)
  if (!applicable) return { notice: 'Create, alter and drop scripting is available for views, routines and triggers.' }
  let create: string | undefined, alter: string | undefined, drop: string | undefined
  const startsCreate = source && /^\s*CREATE\b/i.test(source)
  // A stored SQL Server definition may still start with ALTER or CREATE OR
  // ALTER. Normalize its script labels; a body alone is not a CREATE script.
  if (source && ['sqlserver', 'azure-sql'].includes(engine) && /^\s*(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\b/i.test(source)) {
    create = source.replace(/^(\s*)(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\b/i, '$1CREATE')
    alter = source.replace(/^(\s*)(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\b/i, '$1ALTER')
  } else if (startsCreate && kind !== 'macro') create = source
  if (startsCreate && source) {
    if (['postgres', 'duckdb', 'oracle'].includes(engine) && ['view', 'function', 'procedure', 'trigger', 'macro'].includes(kind))
      alter = source.replace(/^(\s*CREATE)(?!\s+OR\s+REPLACE\b)/i, '$1 OR REPLACE')
    else if (['mysql', 'mariadb'].includes(engine) && kind === 'view')
      alter = source.replace(/^(\s*CREATE)(?!\s+OR\s+REPLACE\b)/i, '$1 OR REPLACE')
  }
  if (kind === 'view') drop = `DROP VIEW ${qualified};`
  if (kind === 'trigger') {
    if (engine === 'postgres') {
      if (object.parent) drop = `DROP TRIGGER ${q(object.name)} ON ${q(object.schema)}.${q(object.parent)};`
    } else if (engine !== 'duckdb') drop = `DROP TRIGGER ${qualified};`
  }
  if (kind === 'function' || kind === 'procedure') {
    if (engine === 'postgres') {
      const signature = safePostgresSignature(object.signature)
      if (signature !== undefined) drop = `DROP ${kind.toUpperCase()} ${qualified}(${signature});`
    } else if (engine !== 'sqlite' && engine !== 'duckdb') drop = `DROP ${kind.toUpperCase()} ${qualified};`
  }
  if (kind === 'macro' && engine === 'duckdb') drop = `DROP MACRO ${qualified};`
  if (kind === 'macro' && engine === 'duckdb' && source) {
    const section = detail.sections.find(item => item.title === 'Macro'), row = section?.rows[0], namesJson = row?.[section?.columns.indexOf('Parameter names (JSON)') ?? -1], macroKind = row?.[section?.columns.indexOf('Kind') ?? -1]
    try {
      const names: unknown = JSON.parse(namesJson ?? '')
      if (!section?.truncated && Array.isArray(names) && names.length <= 100 && names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.includes('\0')) && ['macro', 'table_macro'].includes(macroKind ?? '')) {
        create = `CREATE MACRO ${qualified}(${names.map(q).join(', ')}) AS ${macroKind === 'table_macro' ? 'TABLE ' : ''}${source}`
        alter = create.replace(/^CREATE\b/, 'CREATE OR REPLACE')
      }
    } catch { /* Incomplete metadata cannot produce a reliable declaration. */ }
  }
  if (create && ['mysql', 'mariadb'].includes(engine) && ['function', 'procedure', 'trigger'].includes(kind) && create.includes(';')) {
    const delimiter = ['$$', '//', '@@', '%%', '!!', '^^', '||'].find(candidate => !create!.includes(candidate))
    if (delimiter) create = `DELIMITER ${delimiter}\n${create}\n${delimiter}\nDELIMITER ;`
  }
  return { create, alter, drop, notice: `${detail.definition.source === 'generated' ? 'The definition is a generated summary; metadata or options may be omitted. ' : ''}${kind === 'macro' && engine === 'duckdb' ? 'Macro declarations are reconstructed; parameter defaults and types may be omitted. Review them before use. ' : ''}Scripts open in a query tab and do not run until you execute them. Drop may affect dependent objects; review the database behavior first.${!alter ? ' This engine or definition has no automatic alter script; edit explicit SQL instead.' : ''}` }
}
