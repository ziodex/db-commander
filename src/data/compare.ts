import type { DatabaseDriver } from '../driver/driver'
import { objectKey } from '../shared/catalog'
import { dataCompareSchema, type DataCapture, type DataCompareRequest, type DataComparison, type DataDifference, type DataScope } from '../shared/data-compare'
import type { SessionInfo } from '../shared/contracts'

type Reader = Pick<DatabaseDriver, 'getSession' | 'explore' | 'editGrid'>
function ready(session: SessionInfo) {
  if (session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Commit or roll back and enable autocommit in both tabs before comparing data.')
  if (!session.database) throw new Error('Select a database in both tabs before comparing data.')
}
export function matchData(source: DataCapture, target: DataCapture): DataDifference[] {
  if (JSON.stringify(source.keys) !== JSON.stringify(target.keys)) throw new Error('The primary keys differ. Choose the same explicit key columns for both tables.')
  if (source.columns.length !== target.columns.length || source.columns.some(c => !target.columns.some(t => t.name === c.name && t.type.toLowerCase() === c.type.toLowerCase()))) throw new Error('Selected column names and native types must match. Choose compatible columns or review the schemas.')
  const positions = source.columns.map(c => target.columns.findIndex(t => t.name === c.name))
  const keyIndexes = source.keys.map(name => source.columns.findIndex(c => c.name === name))
  const key = (row: (string | null)[]) => keyIndexes.map(i => row[i]!)
  const left = new Map(source.rows.map(row => [JSON.stringify(key(row)), row]))
  const right = new Map(target.rows.map(row => positions.map(i => row[i])).map(row => [JSON.stringify(key(row)), row]))
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(encoded => {
    const a = left.get(encoded), b = right.get(encoded)
    const changedColumns = a && b ? source.columns.filter((_, i) => a[i] !== b[i]).map(c => c.name) : []
    return { key: JSON.parse(encoded), status: !a ? 'target-only' : !b ? 'source-only' : changedColumns.length ? 'changed' : 'matching', source: a, target: b, changedColumns }
  })
}
export async function compareData(input: DataCompareRequest, source: Reader, target: Reader): Promise<DataComparison> {
  const request = dataCompareSchema.parse(input), a = source.getSession(request.source.sessionId), b = target.getSession(request.target.sessionId)
  if (a.engine !== b.engine) throw new Error('Data comparison requires the same engine in both tabs.')
  ready(a); ready(b)
  const started = performance.now()
  const budget = () => { if (performance.now() - started > 45_000) throw new Error('The comparison collection budget was exceeded. Narrow the scope and retry.') }
  const identity = async (driver: Reader, scope: DataScope) => {
    budget()
    const catalog = (await driver.explore(scope.sessionId)).catalog
    if (!catalog || catalog.truncated) throw new Error('A complete visible catalog is required. Refresh the schema before comparing.')
    const object = catalog.objects.find(o => o.kind === 'table' && o.schema === scope.table.schema && o.name === scope.table.name && (o.catalog ?? '') === (scope.table.catalog ?? ''))
    if (!object) throw new Error('The selected base table is unavailable. Refresh the schema and check permissions.')
    return objectKey(object)
  }
  const read = async (driver: Reader, scope: DataScope) => {
    const before = await identity(driver, scope)
    const result = await driver.editGrid({ ...scope, action: 'compare-data', keys: request.keys, columns: request.columns, maxRows: request.maxRows })
    if (result.error || !result.dataCapture) throw new Error(result.error ?? 'Comparison data is unavailable.')
    ready(result.session)
    if (before !== await identity(driver, scope)) throw new Error('The table changed during capture. Refresh and compare again.')
    budget()
    return result.dataCapture
  }
  const left = await read(source, request.source), right = await read(target, request.target)
  const rows = matchData(left, right), counts: DataComparison['counts'] = { 'source-only': 0, 'target-only': 0, changed: 0, matching: 0 }
  for (const row of rows) counts[row.status]++
  const label = (session: SessionInfo, scope: DataScope) => `${session.name} / ${session.host}${session.port ? ':' + session.port : ''} / ${session.database} / ${[scope.table.catalog, scope.table.schema, scope.table.name].filter(Boolean).join('.')}`
  return { engine: a.engine, request, sourceLabel: label(a, request.source), targetLabel: label(b, request.target), capturedAt: new Date().toISOString(), columns: left.columns, keys: left.keys, sourceRows: left.rows.length, targetRows: right.rows.length, counts, rows, notices: [
    'Both filtered sets fit the chosen limit. Only selected columns and visible rows are compared; row-level permissions can hide data. No writes or synchronization SQL are performed.',
    'Sequential live reads, not an atomic cross-database snapshot. Concurrent writes can produce transient differences. Refresh before acting on a result.',
    'Keys and values use exact, case-sensitive captured strings (NULL is distinct from empty text); database collation, numeric/date session formatting and JSON whitespace are not normalized. Selected native types must match.',
    'Limits: 200 rows per side, 32 columns including up to 8 key columns, 4,096 characters per value and 4 MiB per side. Limits bound captured data, not server scan work or time. Native reads may outlast the collection budget.',
    ...(a.engine === 'sqlite' ? ['SQLite values include storage-class prefixes (integer:, real:, text:, blob:) so different stored types remain distinct.'] : [])
  ] }
}
