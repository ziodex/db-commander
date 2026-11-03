import { PLAN_LIMIT, postgresPlan, type ExplainResult, type PlanNode, type PlanTree } from './explain'

type Fields = Record<string, unknown>
type Operator = Omit<PlanNode, 'id' | 'parent' | 'depth'>
const TREE_LIMIT = 1000
const DEPTH_LIMIT = 100
const limitedNotice = 'The visual tree is limited to 1,000 operators and 100 levels. Open Raw plan for captured details.'
const unrecognized = () => new Error('The captured format could not be mapped to an operator tree. Inspect Raw plan.')
const fields = (value: unknown): Fields | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
function measure(value: unknown) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i.test(value))) return
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function flatten<T>(roots: T[], read: (value: T) => { operator: Operator; children: T[] }): PlanTree {
  if (!roots.length) throw unrecognized()
  const pending = roots.slice().reverse().map(value => ({ value, parent: undefined as number | undefined, depth: 0 }))
  const nodes: PlanNode[] = []
  let limited = false
  while (pending.length) {
    if (nodes.length >= TREE_LIMIT) { limited = true; break }
    const { value, parent, depth } = pending.pop()!
    if (depth > DEPTH_LIMIT) { limited = true; continue }
    const { operator, children } = read(value), id = nodes.length
    nodes.push({ ...operator, id, parent, depth })
    for (let i = children.length - 1; i >= 0; i--) pending.push({ value: children[i], parent: id, depth: depth + 1 })
  }
  return { nodes, notice: limited ? limitedNotice : undefined }
}

interface NumberedOperator { key: string; parentKey?: string; operator: Operator }
function numberedTree(rows: NumberedOperator[]) {
  const byKey = new Map(rows.map(row => [row.key, row]))
  if (byKey.size !== rows.length) throw unrecognized()
  const roots: NumberedOperator[] = [], children = new Map<string, NumberedOperator[]>()
  for (const row of rows) {
    if (row.parentKey === undefined) roots.push(row)
    else {
      if (!byKey.has(row.parentKey)) throw unrecognized()
      const siblings = children.get(row.parentKey)
      if (siblings) siblings.push(row)
      else children.set(row.parentKey, [row])
    }
  }
  // Reject cycles or orphaned components before rendering a subset as a tree.
  const visited = new Set<string>(), queue = roots.slice()
  for (let i = 0; i < queue.length; i++) {
    const { key } = queue[i]
    if (visited.has(key)) throw unrecognized()
    visited.add(key)
    queue.push(...children.get(key) ?? [])
  }
  if (visited.size !== rows.length) throw unrecognized()
  return flatten(roots, ({ key, operator }) => ({ operator, children: children.get(key) ?? [] }))
}

function sqliteTree({ columns, rows }: ExplainResult['output']) {
  if (columns.length !== 4 || columns[0].toLowerCase() !== 'id' || columns[1].toLowerCase() !== 'parent' ||
      columns[3].toLowerCase() !== 'detail') throw unrecognized()
  return numberedTree(rows.map(([key, parent, , description]) => {
    if (!key || !/^\d+$/.test(key) || !parent || !/^\d+$/.test(parent) || !description) throw unrecognized()
    return { key, parentKey: parent === '0' ? undefined : parent, operator: { type: description, details: { 'Plan node': key, 'Parent node': parent } } }
  }))
}

function oracleTree(operators: ExplainResult['output']['oracleOperators']) {
  if (!operators?.length) throw unrecognized()
  return numberedTree(operators.map(([key, parent, position, operation, options, owner, object, cardinality, cost, bytes]) => {
    if (!key || !/^\d+$/.test(key) || parent !== null && !/^\d+$/.test(parent ?? '') || !operation) throw unrecognized()
    return {
      key, parentKey: parent ?? undefined,
      operator: {
        type: [operation, options].filter(Boolean).join(' '), relation: object ? [owner, object].filter(Boolean).join('.') : undefined,
        estimatedRows: measure(cardinality), cost: measure(cost),
        details: { 'Plan node': key, 'Parent node': parent, 'Sibling position': position, 'Estimated bytes': bytes }
      }
    }
  }))
}

function duckdbTree(raw: string, output: ExplainResult['output']) {
  const captured = JSON.parse(raw)
  const nativePlans: unknown = fields(captured)?.plans
  const phase = Array.isArray(nativePlans) ? nativePlans.find(plan => fields(plan)?.phase === 'physical_plan') ?? nativePlans[0] : undefined
  const roots: unknown = phase ? fields(phase)?.plan : captured
  if (!Array.isArray(roots)) throw unrecognized()
  const plan = flatten(roots as unknown[], value => {
    const node = fields(value), name = text(node?.name)
    if (!node || !name || !Array.isArray(node.children)) throw unrecognized()
    const details = fields(node.extra_info) ?? {}
    return { operator: { type: name, relation: text(details.Table), estimatedRows: measure(details['Estimated Cardinality']), details }, children: node.children }
  })
  const phaseName = fields(phase)?.phase ?? output.rows[0]?.[0]
  if (phaseName !== 'physical_plan') plan.notice = [plan.notice, 'The session returned a logical plan. Operator shape may differ from the physical plan.'].filter(Boolean).join(' ')
  return plan
}

const jsonOperatorNames: Record<string, string> = {
  query_block: 'Query block', table: 'Table access', nested_loop: 'Nested loop', ordering_operation: 'Ordering',
  grouping_operation: 'Grouping', duplicates_removal: 'Remove duplicates', filesort: 'File sort',
  read_sorted_file: 'Read sorted rows', materialized: 'Materialized subquery', materialized_from_subquery: 'Materialized subquery',
  union_result: 'Union', query_specifications: 'Union input', windowing: 'Window', window_functions_computation: 'Window',
  temporary_table: 'Temporary table', subqueries: 'Subquery', attached_subqueries: 'Attached subquery',
  select_list_subqueries: 'Select-list subquery', optimized_away_subqueries: 'Optimized-away subquery', 'block-nl-join': 'Block nested loop',
  expression_cache: 'Expression cache', buffer_result: 'Buffer result'
}
type JsonOperator = { kind: string; value: unknown }
function mysqlTree(raw: string) {
  const document = fields(JSON.parse(raw))
  if (!document) throw unrecognized()
  if (text(document.operation)) {
    return flatten([document], node => {
      const operation = text(node.operation)
      if (!operation || node.inputs !== undefined && !Array.isArray(node.inputs)) throw unrecognized()
      const { inputs, ...details } = node
      const children: Fields[] = []
      if (Array.isArray(inputs)) for (const input of inputs) {
        const child = fields(input)
        if (!child) throw unrecognized()
        children.push(child)
      }
      return { operator: { type: operation, relation: text(node.table_name), estimatedRows: measure(node.estimated_rows), cost: measure(node.estimated_total_cost), details }, children }
    })
  }
  if (!fields(document.query_block)) throw unrecognized()
  const plan = flatten<JsonOperator>([{ kind: 'query_block', value: document.query_block }], ({ kind, value }) => {
    const node = fields(value)
    if (!node && !Array.isArray(value)) throw unrecognized()
    const children: JsonOperator[] = []
    const details: Fields = {}
    if (Array.isArray(value)) {
      for (const entry of value) {
        const branch = fields(entry)
        if (!branch) throw unrecognized()
        for (const [key, child] of Object.entries(branch)) {
          if (Object.hasOwn(jsonOperatorNames, key) && child && typeof child === 'object') children.push({ kind: key, value: child })
        }
      }
    } else for (const [key, child] of Object.entries(node!)) {
      if (Object.hasOwn(jsonOperatorNames, key) && child && typeof child === 'object') children.push({ kind: key, value: child })
      else details[key] = child
    }
    const cost = fields(node?.cost_info)
    const access = text(node?.access_type)
    return {
      operator: {
        type: jsonOperatorNames[kind] + (access ? ' · ' + access : ''),
        relation: text(node?.table_name), estimatedRows: measure(node?.rows_produced_per_join ?? node?.rows_examined_per_scan ?? node?.rows),
        cost: measure(cost?.query_cost ?? cost?.prefix_cost), details
      },
      children
    }
  })
  plan.notice = [plan.notice, 'Shows recognized JSON plan sections. The raw capture includes the remaining native fields.'].filter(Boolean).join(' ')
  return plan
}

function sqlServerTree(raw: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw unrecognized()
  const document = new DOMParser().parseFromString(raw, 'application/xml')
  const namespace = 'http://schemas.microsoft.com/sqlserver/2004/07/showplan'
  if (document.documentElement.localName !== 'ShowPlanXML' || document.documentElement.namespaceURI !== namespace || document.querySelector('parsererror')) throw unrecognized()
  const nodes: PlanNode[] = []
  const pending: { element: Element; parent?: number; depth: number }[] = [{ element: document.documentElement, depth: 0 }]
  let limited = false
  while (pending.length) {
    if (nodes.length >= TREE_LIMIT) { limited = true; break }
    let { element, parent, depth } = pending.pop()!
    if (element.namespaceURI !== namespace) continue
    if (element.localName === 'RelOp') {
      if (depth > DEPTH_LIMIT) { limited = true; continue }
      const id = nodes.length, type = element.getAttribute('PhysicalOp') ?? element.getAttribute('LogicalOp')
      if (!type) throw unrecognized()
      nodes.push({
        id, parent, depth, type, estimatedRows: measure(element.getAttribute('EstimateRows')),
        cost: measure(element.getAttribute('EstimatedTotalSubtreeCost')),
        details: Object.fromEntries(Array.from(element.attributes, attribute => [attribute.name, attribute.value]))
      })
      parent = id
      depth++
    } else if (element.localName === 'Object' && parent !== undefined && nodes[parent].relation === undefined) {
      const relation = ['Database', 'Schema', 'Table', 'Index'].map(name => element.getAttribute(name)).filter(Boolean).join('.')
      if (relation) nodes[parent].relation = relation
    }
    for (let i = element.children.length - 1; i >= 0; i--) pending.push({ element: element.children[i], parent, depth })
  }
  if (!nodes.length) throw unrecognized()
  return { nodes, notice: limited ? limitedNotice : undefined }
}

export function explainTree(result: ExplainResult): PlanTree {
  if (result.status !== 'completed' || !result.raw || result.raw.length > PLAN_LIMIT) throw unrecognized()
  switch (result.engine) {
    case 'postgres': return postgresPlan(result.raw)
    case 'sqlite': return sqliteTree(result.output)
    case 'duckdb': return duckdbTree(result.raw, result.output)
    case 'mysql':
    case 'mariadb': return mysqlTree(result.raw)
    case 'sqlserver':
    case 'azure-sql': return sqlServerTree(result.raw)
    case 'oracle': return oracleTree(result.output.oracleOperators)
  }
}

function operatorCounts(tree: PlanTree) {
  const counts = new Map<string, { type: string; relation?: string; count: number }>()
  for (const { type, relation } of tree.nodes) {
    const key = JSON.stringify([type, relation]), item = counts.get(key)
    if (item) item.count++
    else counts.set(key, { type, relation, count: 1 })
  }
  return counts
}

export function comparePlanOperators(baseline: PlanTree, current: PlanTree) {
  const left = operatorCounts(baseline), right = operatorCounts(current)
  return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(key => {
    const before = left.get(key), after = right.get(key)
    if (before?.count === after?.count) return []
    const { type, relation } = (before ?? after)!
    return [{ key, type, relation, before: before?.count ?? 0, after: after?.count ?? 0 }]
  })
}
