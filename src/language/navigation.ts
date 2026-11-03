import type { CatalogObject } from '../shared/catalog'
import type { SchemaSnapshot } from '../shared/contracts'
import { quoteIdentifier } from '../shared/sql/common'
import type { Token } from '../shared/sql/lexer'
import { catalogMatches, localName, queryScopes, type QueryRelation } from './query-scopes'
import { ANALYSIS_LIMIT, folded, identifier, namePath, parentheses, sqlTokens, statementAt, symbol, word, type AnalysisDialect, type SourceRange } from './syntax'

export interface SqlNavigation {
  definition?: SourceRange
  references: SourceRange[]
  objects: CatalogObject[]
}
export interface SqlRename {
  name: string
  replacement: string
  edits: SourceRange[]
}
export interface RoutineSignature {
  label: string
  arguments?: string
}

const range = ({ start, end }: Token): SourceRange => ({ start, end })
const routineKinds = new Set(['function', 'procedure', 'macro'])

function analysis(sql: string, offset: number, dialect: AnalysisDialect, snapshot?: SchemaSnapshot | null) {
  if (sql.length > ANALYSIS_LIMIT || offset < 0 || offset > sql.length) return
  const tokens = statementAt(sql, sqlTokens(sql, dialect).filter(token => token.kind !== 'comment'), offset, dialect.engine)
  const index = queryScopes(tokens, snapshot?.objects ?? [], dialect.engine)
  const sources = index.scopes.flatMap(scope => scope.relations)
  const sourceTokens = new Map<Token, QueryRelation>()
  for (const source of sources) for (const token of source.path) sourceTokens.set(token, source)
  const aliases = new Map(sources.flatMap(relation => relation.alias ? [[relation.alias, relation] as const] : []))
  const at = tokens.findIndex(token => token.start <= offset && offset < token.end)
  const cursor = at >= 0 && identifier(tokens[at]) ? at : tokens.findIndex(token => identifier(token) && token.end === offset)
  const binding = (position: number) => {
    const token = tokens[position]
    if (!identifier(token)) return
    const declaration = aliases.get(token)
    if (declaration) return declaration
    if (sourceTokens.has(token) || symbol(tokens[position - 1], '.') || symbol(tokens[position - 1], '::') ||
        ['AS', 'COLLATE', 'AT'].includes(word(tokens[position - 1])) || word(tokens[position - 2]) === 'OPERATOR' || !symbol(tokens[position + 1], '.') ||
        symbol(tokens[position + 3], '(') || symbol(tokens[position + 3], '.')) return
    return index.relationAt(token, index.scopeAt(token.start))
  }
  return { tokens, index, cursor, sourceTokens, binding }
}

export function navigateSql(sql: string, offset: number, dialect: AnalysisDialect, snapshot?: SchemaSnapshot | null): SqlNavigation {
  const empty = { references: [], objects: [] }
  const parsed = analysis(sql, offset, dialect, snapshot)
  if (!parsed || parsed.cursor < 0 || parsed.index.limited) return empty
  const { tokens, cursor, index, binding, sourceTokens } = parsed
  const token = tokens[cursor]
  const related = binding(cursor) ?? (symbol(tokens[cursor - 1], '.') ? binding(cursor - 2) : undefined)
  const relation = sourceTokens.get(token) ?? related
  const table = index.scopeAt(token.start).tables.find(table => table.name === token) ?? relation?.cte
  if (related?.alias) {
    return {
      definition: range(related.alias),
      references: tokens.flatMap((part, n) => part !== related.alias && binding(n) === related ? [range(part)] : []),
      objects: []
    }
  }
  if (table) return {
    definition: range(table.name),
    references: tokens.flatMap((part, n) => sourceTokens.get(part)?.cte === table && sourceTokens.get(part)?.name === part ||
      binding(n)?.cte === table && !binding(n)?.alias ? [range(part)] : []),
    objects: []
  }
  const catalog = snapshot?.catalog?.objects ?? []
  if (relation) {
    if (relation.object) {
      const { name, catalog: database, schema } = relation.object
      const objects = catalog.filter(item => ['table', 'view', 'materialized view'].includes(item.kind) && item.name === name && item.catalog === database && item.schema === schema)
      const sameTable = (ref?: QueryRelation) => ref?.object === relation.object
      const references = tokens.flatMap((part, index) => {
        const source = sourceTokens.get(part), use = binding(index)
        return source?.name === part && sameTable(source) || use && !use.alias && sameTable(use) ? [range(part)] : []
      }).slice(0, 200)
      return { references, objects }
    }
    return { ...empty, objects: catalogMatches(relation.path, catalog.filter(item => routineKinds.has(item.kind)), dialect.engine) }
  }
  let first = cursor
  while (symbol(tokens[first - 1], '.') && identifier(tokens[first - 2])) first -= 2
  const path = namePath(tokens, first)
  if (symbol(tokens[path.end], '(') || ['EXEC', 'EXECUTE', 'CALL'].includes(word(tokens[first - 1]))) {
    return { ...empty, objects: catalogMatches(path.names, catalog.filter(item => routineKinds.has(item.kind)), dialect.engine) }
  }
  return empty
}

/** Rename only a local relation alias whose complete set of uses is known.
 * A same-spelled bare word could be a whole-row expression or an unsupported
 * binding. Refuse the rename instead of skipping a possible reference. */
export function previewSqlRename(sql: string, offset: number, proposed: string, dialect: AnalysisDialect, snapshot?: SchemaSnapshot | null): SqlRename {
  const parsed = analysis(sql, offset, dialect, snapshot)
  if (!parsed || parsed.cursor < 0 || parsed.index.limited) throw new Error('Select a table alias or its qualified reference in a supported query.')
  const { tokens, cursor, binding } = parsed
  const relation = binding(cursor), alias = relation?.alias
  if (!alias || !['SELECT', 'WITH'].includes(word(tokens[0]))) throw new Error('Select a table alias or its qualified reference in a SELECT query.')
  const { open, extra } = parentheses(tokens)
  if (open.length || extra.length || tokens.some(token => !token.closed)) throw new Error('Complete the query before reviewing an alias rename.')
  if (!proposed.trim() || new TextEncoder().encode(proposed).length > 63 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(proposed)) {
    throw new Error('Enter an alias of at most 63 UTF-8 bytes without control characters.')
  }
  const oldName = localName(alias, dialect.engine)
  const name = folded(oldName), next = folded(proposed)
  if (name === next) throw new Error('Enter a different alias name.')
  const edits: SourceRange[] = []
  for (const [index, token] of tokens.entries()) {
    if (!identifier(token)) continue
    if (folded(token.value) === next) throw new Error('The new name is already used in this statement. Choose a distinct alias.')
    if (binding(index) === relation) {
      if (token.value !== alias.value && !['postgres', 'oracle'].includes(dialect.engine)) {
        throw new Error('The alias uses mixed identifier spellings. Review the query manually.')
      }
      edits.push(range(token))
    } else if (folded(token.value) === name) {
      throw new Error('The alias also occurs in another role or scope. Rename it manually to avoid changing bindings.')
    }
    if (edits.length > 200) throw new Error('The alias has more than 200 occurrences. Narrow the query before renaming.')
  }
  return { name: alias.value, replacement: quoteIdentifier(proposed, dialect.engine), edits }
}

export function routineSignatures(sql: string, offset: number, dialect: AnalysisDialect, snapshot?: SchemaSnapshot | null) {
  const catalog = snapshot?.catalog?.objects.filter(object => routineKinds.has(object.kind))
  if (!catalog?.length || sql.length > ANALYSIS_LIMIT || offset < 0 || offset > sql.length) return
  const all = sqlTokens(sql, dialect)
  const inside = all.find(token => token.start < offset && (token.end > offset || !token.closed && token.end === offset))
  if (inside && (inside.kind === 'string' || inside.kind === 'comment')) return
  const tokens = statementAt(sql, all.filter(token => token.kind !== 'comment'), offset, dialect.engine)
  const preceding = tokens.filter(token => token.end <= offset)
  const { open } = parentheses(preceding)
  for (let index = open.length - 1; index >= 0; index--) {
    const paren = open[index]
    if (!identifier(preceding[paren - 1])) continue
    let start = paren - 1
    while (symbol(preceding[start - 1], '.') && identifier(preceding[start - 2])) start -= 2
    const { names } = namePath(preceding, start)
    const matches = catalogMatches(names, catalog, dialect.engine)
    if (!matches.length) continue
    let argument = 0, depth = 0
    for (let n = paren + 1; n < preceding.length; n++) {
      if (symbol(preceding[n], '(')) depth++
      if (symbol(preceding[n], ')')) depth--
      if (!depth && symbol(preceding[n], ',')) argument++
    }
    return {
      argument,
      signatures: matches.slice(0, 20).map((routine): RoutineSignature => ({
        label: [routine.catalog, routine.schema, routine.name].filter(Boolean).join('.'),
        arguments: routine.signature
      })),
      limited: matches.length > 20 || Boolean(snapshot?.catalog?.truncated)
    }
  }
}
