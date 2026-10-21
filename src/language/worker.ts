import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import { completeSql } from './completion'
import { formatSql } from './format'
const contexts = new Map<string, { engine: DatabaseEngine; schema: SchemaSnapshot | null }>()
self.onmessage = ({ data }) => {
  const { id, method, uri, text, offset, options, formatting } = data
  if (method === 'context') { contexts.set(uri, data.context); return }
  if (method === 'dispose') { contexts.delete(uri); return }
  try {
    const context = contexts.get(uri)
    if (!context) throw new Error('This query tab is no longer available.')
    const value = method === 'complete' ? completeSql(text, offset, context.engine, context.schema) : formatSql(text, context.engine, options.tabSize, !options.insertSpaces, formatting)
    self.postMessage({ id, value })
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}
