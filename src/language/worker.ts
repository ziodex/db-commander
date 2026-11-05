import type { SchemaSnapshot } from '../shared/contracts'
import { completeSql } from './completion'
import { diagnoseSql } from './diagnostics'
import { formatSql } from './format'
import { navigateSql, previewSqlRename, routineSignatures } from './navigation'
import type { AnalysisDialect } from './syntax'
const contexts = new Map<string, AnalysisDialect & { schema: SchemaSnapshot | null }>()
self.onmessage = ({ data }) => {
  const { id, method, uri, text, offset, options, formatting, name } = data
  if (method === 'context') { contexts.set(uri, data.context); return }
  if (method === 'dispose') { contexts.delete(uri); return }
  try {
    const context = contexts.get(uri)
    if (!context) throw new Error('This query tab is no longer available.')
    let value: unknown
    switch (method) {
      case 'complete': value = completeSql(text, offset, context.engine, context.schema, context); break
      case 'format': value = formatSql(text, context.engine, options.tabSize, !options.insertSpaces, formatting); break
      case 'diagnostics': value = diagnoseSql(text, context); break
      case 'navigate': value = navigateSql(text, offset, context, context.schema); break
      case 'rename': value = previewSqlRename(text, offset, name, context, context.schema); break
      case 'signature': value = routineSignatures(text, offset, context, context.schema); break
      default: throw new Error('Unknown SQL analysis request.')
    }
    self.postMessage({ id, value })
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}
