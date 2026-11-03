import type { DatabaseEngine, SchemaObject } from '../shared/contracts'
import type { Token } from '../shared/sql/lexer'
import { folded, identifier, namePath, parentheses, symbol, word } from './syntax'

export interface QueryRelation {
  name: Token
  alias?: Token
  path: Token[]
  object?: SchemaObject
  cte?: CommonTable
}

interface CommonTable {
  name: Token
  object: SchemaObject
}

interface QueryScope {
  start: number
  end: number
  relations: QueryRelation[]
  inherited: QueryRelation[]
  tables: CommonTable[]
}

const clauses = new Set('WHERE GROUP ORDER HAVING WINDOW QUALIFY UNION INTERSECT EXCEPT MINUS LIMIT OFFSET FETCH SET VALUES RETURNING OUTPUT CONNECT START FOR'.split(' '))
const relationWords = new Set(['FROM', 'JOIN', 'APPLY', 'UPDATE', 'INTO'])
const aliasBoundary = new Set([...clauses, ...relationWords, ...'AS ON USING SELECT WITH LEFT RIGHT INNER OUTER FULL CROSS NATURAL LATERAL ONLY TABLESAMPLE PARTITION PIVOT UNPIVOT END'.split(' ')])
const setOperators = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'])
const queryStart = (token?: Token) => ['SELECT', 'WITH', 'VALUES'].includes(word(token))

/** Quoted names in PostgreSQL and Oracle keep their spelling. The remaining
 * engines can use connection-specific identifier rules. Ambiguous matches are
 * withheld even when the candidates would be distinct on a specific server. */
export function localName(token: Token, engine: DatabaseEngine) {
  if (engine === 'postgres') return token.kind === 'identifier' ? token.value : folded(token.value)
  if (engine === 'oracle') return token.kind === 'identifier' ? token.value : token.value.toUpperCase()
  return folded(token.value)
}

export function catalogMatches<T extends { catalog?: string; schema: string; name: string }>(names: Token[], objects: T[], engine: DatabaseEngine) {
  if (!names.length) return []
  return objects.filter(object => {
    const path = [object.catalog, object.schema, object.name].filter((value): value is string => Boolean(value))
    return names.length <= path.length && names.every((name, index) => {
      const expected = path[path.length - names.length + index]
      return ['postgres', 'oracle'].includes(engine) && name.kind === 'identifier' ? name.value === expected : folded(name.value) === folded(expected)
    })
  })
}

function projectedColumn(name: string, ordinal: number) {
  return { name, ordinal: ordinal + 1, type: 'Query column', nullable: true }
}

/** A bounded index of SELECT-like scopes. Unknown sources still reserve their
 * aliases, so an unknown inner relation cannot expose an outer shadowed alias. */
export function queryScopes(tokens: Token[], catalog: SchemaObject[], engine: DatabaseEngine) {
  const { close } = parentheses(tokens)
  const scopes: QueryScope[] = []
  const relationsByName = new Map<string, SchemaObject[]>()
  for (const object of catalog) {
    const name = folded(object.name)
    const matches = relationsByName.get(name)
    if (matches) matches.push(object)
    else relationsByName.set(name, [object])
  }
  let limited = false
  const stop = (index: number) => close.get(index)
  const named = (token?: Token): token is Token => identifier(token) && !aliasBoundary.has(word(token))
  const same = (left: Token, right: Token) => localName(left, engine) === localName(right, engine)
  function namedColumns(start: number) {
    const end = stop(start)
    if (end === undefined || !symbol(tokens[start], '(')) return { names: [], end: start }
    const names: Token[] = []
    for (let index = start + 1; index < end; index += 2) {
      if (!named(tokens[index]) || index + 1 < end && !symbol(tokens[index + 1], ',')) return { names: [], end: start }
      names.push(tokens[index])
    }
    return { names, end: end + 1 }
  }
  const visible = (scope: QueryScope) => {
    const shadowed = new Set(scope.relations.map(relation => localName(relation.alias ?? relation.name, engine)))
    return [...scope.relations, ...scope.inherited.filter(relation => !shadowed.has(localName(relation.alias ?? relation.name, engine)))]
  }

  function projection(scope?: QueryScope) {
    if (!scope) return []
    let index = scope.start
    while (index < scope.end && word(tokens[index]) !== 'SELECT') index = (stop(index) ?? index) + 1
    if (index === scope.end) return []
    index++
    if (['DISTINCT', 'ALL'].includes(word(tokens[index]))) index++
    const names: string[] = []
    let chunk = index
    function finish(end: number) {
      const last = tokens[end - 1]
      if (end <= chunk || !last) return
      if (named(last) && word(tokens[end - 2]) === 'AS') names.push(last.value)
      else if (symbol(last, '*') && (end - chunk === 1 || end - chunk === 3 && symbol(tokens[chunk + 1], '.'))) {
        const relations = end - chunk === 1 ? scope!.relations : scope!.relations.filter(relation => same(relation.alias ?? relation.name, tokens[chunk]))
        for (const relation of relations) for (const column of relation.object?.columns ?? []) if (names.length < 200) names.push(column.name)
      } else if (named(last) && namePath(tokens, chunk).end === end) names.push(last.value)
      else if (named(last) && end - chunk === 2 && (identifier(tokens[chunk]) || tokens[chunk].kind === 'string')) names.push(last.value)
    }
    for (; index < scope.end; index = (stop(index) ?? index) + 1) {
      if (word(tokens[index]) === 'FROM' || clauses.has(word(tokens[index]))) break
      if (symbol(tokens[index], ',')) { finish(index); chunk = index + 1 }
      if (names.length >= 200) break
    }
    finish(index)
    return names.slice(0, 200).map(projectedColumn)
  }

  function collect(start: number, end: number, tables: CommonTable[], inherited: QueryRelation[], level: number): QueryScope | undefined {
    if (level >= 24 || scopes.length >= 128) { limited = true; return }
    const scope: QueryScope = { start, end, tables: [...tables], inherited, relations: [] }
    scopes.push(scope)
    let cursor = start
    if (word(tokens[cursor]) === 'WITH') {
      const recursive = word(tokens[cursor + 1]) === 'RECURSIVE'
      cursor += recursive ? 2 : 1
      while (cursor < end && named(tokens[cursor])) {
        if (scope.tables.length >= 128) { limited = true; break }
        const name = tokens[cursor++], declared = namedColumns(cursor)
        cursor = declared.end
        if (word(tokens[cursor]) !== 'AS') break
        cursor++
        if (word(tokens[cursor]) === 'NOT') cursor++
        if (word(tokens[cursor]) === 'MATERIALIZED') cursor++
        const right = stop(cursor)
        if (right === undefined || right >= end) break
        const table: CommonTable = { name, object: { schema: '', name: name.value, kind: 'cte', columns: declared.names.map((column, index) => projectedColumn(column.value, index)) } }
        const body = collect(cursor + 1, right, recursive ? [...scope.tables, table] : scope.tables, [], level + 1)
        if (!table.object.columns.length) table.object.columns = projection(body)
        scope.tables = [...scope.tables.filter(previous => !same(previous.name, name)), table]
        cursor = right + 1
        if (!symbol(tokens[cursor], ',')) break
        cursor++
      }
    }
    let from = false
    const children: { start: number; end: number }[] = []
    for (let index = cursor; index < end; index++) {
      const token = tokens[index], keyword = word(token)
      const right = stop(index)
      if (right !== undefined) {
        if (queryStart(tokens[index + 1])) children.push({ start: index + 1, end: right })
        else {
          // A scalar function or boolean grouping can contain a subquery.
          for (let inner = index + 1; inner < right; inner++) {
            const nested = stop(inner)
            if (nested !== undefined && queryStart(tokens[inner + 1])) { children.push({ start: inner + 1, end: nested }); inner = nested }
          }
        }
        index = right
        continue
      }
      if (setOperators.has(keyword)) {
        scope.end = index
        const next = index + (['ALL', 'DISTINCT'].includes(word(tokens[index + 1])) ? 2 : 1)
        collect(next, end, scope.tables, inherited, level + 1)
        break
      }
      if (clauses.has(keyword)) from = false
      if (!relationWords.has(keyword) && !(from && symbol(token, ','))) continue
      from = true
      if (scope.relations.length >= 128) { limited = true; break }
      let begin = index + 1
      const lateral = keyword === 'APPLY' || word(tokens[begin]) === 'LATERAL'
      if (['LATERAL', 'ONLY'].includes(word(tokens[begin]))) begin++
      const rightSource = stop(begin)
      const derived = rightSource !== undefined && queryStart(tokens[begin + 1])
      const path = derived ? { names: [], end: rightSource + 1 } : namePath(tokens, begin)
      if (!derived && !path.names.length) continue
      const functionEnd = !derived ? stop(path.end) : undefined
      const after = functionEnd === undefined ? path.end : functionEnd + 1
      const aliasIndex = word(tokens[after]) === 'AS' ? after + 1 : after
      const alias = named(tokens[aliasIndex]) ? tokens[aliasIndex] : undefined
      const cte = path.names.length === 1 && functionEnd === undefined ? scope.tables.find(table => same(table.name, path.names[0])) : undefined
      const found = !cte && functionEnd === undefined && path.names.length ? catalogMatches(path.names, relationsByName.get(folded(path.names.at(-1)!.value)) ?? [], engine) : []
      let object = cte?.object ?? (found.length === 1 ? found[0] : undefined)
      if (derived) {
        const child = collect(begin + 1, rightSource, scope.tables, lateral ? visible(scope) : inherited, level + 1)
        if (alias) {
          const declared = namedColumns(aliasIndex + 1)
          object = { schema: '', name: alias.value, kind: 'derived table', columns: declared.names.length ? declared.names.map((column, n) => projectedColumn(column.value, n)) : projection(child) }
        }
      }
      const name = path.names.at(-1) ?? alias
      if (name) scope.relations.push({ name, alias, path: path.names, object, cte })
      // Continue scanning inside table function arguments for scalar subqueries.
      if (functionEnd === undefined) index = alias ? aliasIndex : path.end - 1
    }
    const outer = visible(scope)
    for (const child of children) collect(child.start, child.end, scope.tables, outer, level + 1)
    return scope
  }

  collect(0, tokens.length, [], [], 0)
  function scopeAt(offset: number) {
    return scopes.filter(scope => tokens[scope.start]?.start <= offset && (tokens[scope.end]?.start ?? Infinity) >= offset)
      .sort((a, b) => b.start - a.start || a.end - b.end)[0] ?? scopes[0]
  }
  function relationAt(token: Token, scope: QueryScope) {
    const matches = visible(scope).filter(relation => same(relation.alias ?? relation.name, token))
    return matches.length === 1 ? matches[0] : undefined
  }
  return { scopes, scopeAt, visible, relationAt, limited }
}
