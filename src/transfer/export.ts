import { open } from 'node:fs/promises'
import { publishFile } from '../backup/files'
import { delimitedRow } from './delimited'
import { insertWriter } from './insert'
import type { DatabaseEngine, DatabaseEvent } from '../shared/contracts'
import type { TransferRequest, ImportContext } from '../shared/transfer'

export { validateExportSql } from '../shared/export-query'

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
