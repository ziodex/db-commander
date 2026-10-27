import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { BackupRequest } from '../shared/backup'
import { check, quoteIdentifier, quoteLiteral, type BackupContext } from './context'
import { header, publishFile } from './files'

export async function copyDuckDatabase(client: DuckDBConnection, source: string, destination: string, schemaOnly: boolean, context: BackupContext) {
  const name = 'sc_backup_' + randomUUID().replaceAll('-', '')
  const cancel = () => client.interrupt()
  context.signal.addEventListener('abort', cancel, { once: true })
  let attached = false
  try {
    check(context)
    if (schemaOnly) {
      await client.run(`ATTACH ${quoteLiteral(destination)} AS ${quoteIdentifier(name)} (READ_WRITE)`); attached = true
      await client.run(`COPY FROM DATABASE ${quoteIdentifier(source)} TO ${quoteIdentifier(name)} (SCHEMA)`)
    } else {
      // In 1.5.6 COPY FROM DATABASE may load FK children before their parents.
      // Native EXPORT/IMPORT orders dependencies and handles generated columns,
      // exact types, macros and indexes without reconstructing their DDL in JS.
      const exported = join(dirname(destination), 'export')
      await client.run(`USE ${quoteIdentifier(source)}`)
      context.log('Exporting a consistent DuckDB catalog to temporary Parquet files.')
      await client.run(`EXPORT DATABASE ${quoteLiteral(exported)} (FORMAT PARQUET)`)
      check(context)
      const instance = await DuckDBInstance.create(destination, { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
      let target: DuckDBConnection | undefined
      const cancelImport = () => target?.interrupt()
      try {
        target = await instance.connect(); check(context)
        context.signal.addEventListener('abort', cancelImport, { once: true })
        context.log('Importing native DuckDB schema and data into the new snapshot file.')
        check(context)
        await target.run(`IMPORT DATABASE ${quoteLiteral(exported)}`)
      } finally { context.signal.removeEventListener('abort', cancelImport); target?.closeSync(); instance.closeSync() }
    }
  } finally {
    context.signal.removeEventListener('abort', cancel)
    if (attached) await client.run(`DETACH ${quoteIdentifier(name)}`)
  }
}
export async function restoreDuckDatabase(request: BackupRequest, context: BackupContext) {
  if ((await header(request.artifact, 12)).subarray(8, 12).toString() !== 'DUCK') throw new Error('Choose a DuckDB database snapshot.')
  const instance = await DuckDBInstance.create(request.artifact, { access_mode: 'READ_ONLY', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
  let client: DuckDBConnection | undefined
  try {
    client = await instance.connect()
    const source = String((await client.runAndReadAll('SELECT current_database()')).getRows()[0][0])
    await publishFile(request.target!, context, destination => copyDuckDatabase(client!, source, destination, false, context))
  } finally { client?.closeSync(); instance.closeSync() }
}
