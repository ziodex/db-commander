import { open } from 'node:fs/promises'
import { parameterTokens } from '../shared/parameters'
import { publishFile } from '../backup/files'
import { delimitedRow } from './delimited'
import { insertWriter } from './insert'
import type { DatabaseEngine, DatabaseEvent, SessionInfo } from '../shared/contracts'
import type { TransferRequest, ImportContext } from '../shared/transfer'

export function validateExportSql(sql: string, engine: DatabaseEngine, mode?: SessionInfo['mysqlSqlMode']) {
  const scanned = parameterTokens(sql, engine, mode?.noBackslashEscapes, mode?.ansiQuotes)
  if (scanned.tokens.some(token => !token.closed && (token.kind !== 'comment' || token.text.startsWith('/*')))) throw new Error('Complete SQL strings, identifiers and comments before exporting.')
  // Parameter names are data placeholders, even when named :update or :into.
  const markers = new Set(scanned.refs.flatMap(ref => [ref.start, ref.start + 1]))
  const tokens = scanned.tokens.filter(token => token.kind !== 'comment' && !markers.has(token.start))
  if (!['SELECT', 'WITH'].includes(tokens[0]?.text.toUpperCase())) throw new Error('Full-result export requires one SELECT or WITH query.')
  if (tokens.some((token, index) => token.kind === 'symbol' && token.text === ';' && index !== tokens.length - 1) || tokens.some(token => token.kind === 'word' && /^(INSERT|UPDATE|DELETE|MERGE|INTO|CREATE|ALTER|DROP|TRUNCATE|EXEC|EXECUTE|CALL|COPY|ATTACH|DETACH|PRAGMA|COMMIT|ROLLBACK|GRANT|REVOKE|GO)$/.test(token.text.toUpperCase()))) throw new Error('Export one SELECT query without script batches or write statements. Select the query in the editor first.')
}

/** Publish only after successful execution and a complete file. No row cache. */
export async function exportFile(request: Extract<TransferRequest, { action: 'export' }>, context: ImportContext,
  execute: (consume: (event: DatabaseEvent) => Promise<void>) => Promise<void>, engine?: DatabaseEngine) {
  if (request.format === 'sql' && (!engine || !request.insertTarget)) throw new Error('SQL INSERT export requires a connected engine and destination table.')
  await publishFile(request.file, { signal: context.signal, log() {} }, async temporary => {
    const file = await open(temporary, 'wx', 0o600)
    let index: number | undefined, rows = 0
    let inserts: ReturnType<typeof insertWriter> | undefined
    try {
      await execute(async event => {
        context.signal.throwIfAborted()
        if (event.type === 'result' && event.result.columns.length) {
          if (event.result.truncated) throw new Error('The driver returned a truncated result. No export was published.')
          if (index !== undefined && index !== event.result.index) throw new Error('Export accepts one result set. Select a single query explicitly.')
          if (index === undefined) {
            index = event.result.index
            if (request.format === 'sql') inserts = insertWriter(engine!, request.insertTarget!, event.result.columns)
            await file.writeFile(inserts ? inserts.header : request.format === 'json' ? `{"columns":${JSON.stringify(event.result.columns)},"rows":[\n` : delimitedRow(event.result.columns.map(column => column.name), request.format === 'tsv' ? '\t' : ','))
          }
        } else if (event.type === 'rows') {
          if (index === undefined || index !== event.index) throw new Error('Export received rows without matching column metadata.')
          for (const row of event.rows) {
            context.signal.throwIfAborted()
            await file.writeFile(inserts ? inserts.row(row) : request.format === 'json' ? `${rows ? ',\n' : ''}${JSON.stringify(row)}` : delimitedRow(row, request.format === 'tsv' ? '\t' : ','))
            rows++
          }
          context.progress(rows)
        }
      })
      context.signal.throwIfAborted()
      if (index === undefined) throw new Error('The query did not return a tabular result.')
      if (request.format === 'json') await file.writeFile('\n]}\n')
      await file.close()
    } finally { await file.close().catch(() => {}) }
  })
}
