/** UTF-16 offsets in the submitted SQL, never offsets inferred from error text. */
export interface FailureSource { start: number; end: number; scope: 'statement' | 'batch' | 'script' }
export interface ExecutionSource {
  singleUnit?: boolean; document: string; sql: string; start: number; end: number; prefixLength: number
}
export function errorSource(source: ExecutionSource | undefined, failure: FailureSource | undefined, document: string) {
  if (!source || !failure || source.document !== document) return undefined
  if (![failure.start, failure.end].every(Number.isSafeInteger) || failure.start < 0 || failure.end < failure.start || failure.end > source.sql.length) return undefined
  const start = Math.max(source.start, Math.min(source.end, source.start + failure.start - source.prefixLength))
  const end = Math.max(start, Math.min(source.end, source.start + failure.end - source.prefixLength))
  return { start, end }
}
