import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { delimitedRow } from '../../src/transfer/delimited'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { QueryParameter } from '../../src/shared/parameters'
import type { TransferJob, TransferRequest } from '../../src/shared/transfer'

export async function verifyParameterExport(config: ConnectionConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-bound-export-')), events: DatabaseEvent[] = [], updates: TransferJob[] = []
  let cancel = false
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') }, {}, () => {}, job => {
    updates.push(job)
    if (cancel && job.status === 'running' && job.rows > 0 && !job.cancellationRequested) driver.cancelTransfer(job.id)
  })
  const engine = config.engine, oracle = engine === 'oracle', embedded = ['sqlite', 'duckdb'].includes(engine)
  const local = { ...config, ...(embedded ? { filePath: join(directory, 'data.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const session = await driver.connect(local), q = (name: string) => quoteIdentifier(name, engine), from = oracle ? ' FROM dual' : ''
  const p = (name: string, type: QueryParameter['type'], value = ''): QueryParameter => ({ name, type, value })
  const secret = "export-private O'Brien \\ Ω ; DELETE FROM customers; --"
  const parameters = [p('value', 'text', secret), p('exact', 'integer', '9223372036854775807'), p('missing', 'null'), p('flag', 'boolean', 'true'), p('bytes', 'hex', '00ff8041'), p('minimum', 'integer', '0'), p('maximum', 'integer', '1205')]
  const digits = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS n${from}`).join(' UNION ALL ')
  const sql = `SELECT n AS ${q('id')}, :value AS ${q('label')}, :value AS ${q('label')}, :exact AS ${q('exact')}, :missing AS ${q('missing')}, :flag AS ${q('flag')}, :bytes AS ${q('bytes')} FROM (SELECT a.n+10*b.n+100*c.n AS n FROM (${digits(10)}) a CROSS JOIN (${digits(10)}) b CROSS JOIN (${digits(13)}) c) numbers WHERE n>=:minimum AND n<:maximum ORDER BY n`
  const request = (extra: Partial<Extract<TransferRequest, { action: 'export' }>> = {}): Extract<TransferRequest, { action: 'export' }> => ({ action: 'export', sessionId: session.id, sql, parameters, format: 'json', file: join(directory, 'full.json'), confirmed: true, ...extra })
  async function run(sql: string, values?: QueryParameter[], id = session.id) {
    const queryId = driver.start({ sessionId: id, sql, parameters: values, maxRows: 2 }); await driver.wait(id)
    const completion = events.find(event => event.type === 'complete' && event.queryId === queryId) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(completion, completion?.error).toMatchObject({ status: 'completed' })
    return { queryId, rows: events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : []) }
  }
  async function transfer(input: TransferRequest) {
    const job = driver.startTransfer(input); await driver.waitTransfer(job.id)
    return driver.listTransferJobs().find(item => item.id === job.id)!
  }
  try {
    const preview = await run(sql, parameters)
    expect(preview.rows).toHaveLength(2)
    expect(preview.rows[0].slice(0, 5)).toEqual(['0', secret, secret, '9223372036854775807', null])
    expect(preview.rows[0][6]?.toLowerCase().replace(/^(0x|\\x)/, '')).toBe('00ff8041')
    for (const format of ['csv', 'tsv', 'json'] as const) {
      const file = join(directory, `full.${format}`), before = events.length, job = await transfer(request({ file, format }))
      expect(job, job.phase).toMatchObject({ status: 'completed', rows: 1205, session: { transaction: 'idle' } })
      expect(events.slice(before).filter(event => 'queryId' in event)).toEqual([])
      if (format === 'json') {
        const data = JSON.parse(await readFile(file, 'utf8'))
        expect(data.columns.map((column: { name: string }) => column.name)).toEqual(['id', 'label', 'label', 'exact', 'missing', 'flag', 'bytes'])
        expect(data.rows).toHaveLength(1205); expect(data.rows.slice(0, 2)).toEqual(preview.rows); expect(data.rows.at(-1)[0]).toBe('1204')
      } else {
        // Duplicate result names are preserved; the import reader deliberately
        // rejects such headers, so compare serialized rows directly here.
        expect(await readFile(file, 'utf8')).toBe(delimitedRow(['id', 'label', 'label', 'exact', 'missing', 'flag', 'bytes'], format === 'csv' ? ',' : '\t') + Array.from({ length: 1205 }, (_, i) => delimitedRow([String(i), ...preview.rows[0].slice(1)], format === 'csv' ? ',' : '\t')).join(''))
      }
    }
    const cached = join(directory, 'cached.csv'); await driver.exportCsv(preview.queryId, 0, cached)
    expect((await readFile(cached, 'utf8')).split('export-private')).toHaveLength(5) // two rows, repeated column
    const before = await readFile(request().file)
    expect((await transfer(request())).phase).toMatch(/already exists/)
    expect((await readFile(request().file)).equals(before)).toBe(true)
    const files = await readdir(directory), jobs = driver.listTransferJobs().length
    for (const bad of [request({ parameters: undefined }), request({ parameters: [p('wrong', 'text', secret)] }), request({ sql: 'SELECT :value; DELETE FROM customers', parameters: [p('value', 'text', secret)] })]) expect(() => driver.startTransfer(bad)).toThrow()
    expect(await readdir(directory)).toEqual(files); expect(driver.listTransferJobs()).toHaveLength(jobs)
    const other = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
    const distinct = await transfer(request({ sessionId: other.id, sql: `SELECT :update AS ${q('value')}${from}`, parameters: [p('update', 'text', 'other tab')], file: join(directory, 'other.json') }))
    expect(distinct.status, distinct.phase).toBe('completed'); expect(JSON.parse(await readFile(distinct.file, 'utf8')).rows).toEqual([['other tab']]); await driver.disconnect(other.id)
    await run(oracle ? 'SAVEPOINT export_guard' : ['sqlserver', 'azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    expect(() => driver.startTransfer(request())).toThrow(/Commit or roll back/); await run('ROLLBACK')
    const protectedSession = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write', environment: 'production' })
    expect(() => driver.startTransfer(request({ sessionId: protectedSession.id }))).toThrow(/protected/i); await driver.disconnect(protectedSession.id)
    const failed = await transfer(request({ sql: `SELECT :value FROM missing_parameter_export_table`, parameters: [p('value', 'text', secret)], file: join(directory, 'failed.json') }))
    expect(failed.status).toBe('failed'); expect(failed.phase).toContain('server diagnostics were omitted'); await expect(stat(failed.file)).rejects.toThrow()
    if (['postgres', 'duckdb', 'oracle', 'sqlserver', 'azure-sql'].includes(engine)) {
      // These engines normally include offending text in conversion diagnostics.
      const conversion = await transfer(request({ sql: `SELECT CAST(:value AS INTEGER)${from}`, parameters: [p('value', 'text', secret)], file: join(directory, 'conversion.json') }))
      expect(conversion.status).toBe('failed'); expect(conversion.phase).toContain('server diagnostics were omitted'); await expect(stat(conversion.file)).rejects.toThrow()
    }
    if (['mysql', 'mariadb'].includes(engine)) {
      await run("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
      const mode = await transfer(request({ sql: String.raw`SELECT '\' AS slash, :value AS value`, parameters: [p('value', 'text', secret)], file: join(directory, 'mode.json') }))
      expect(mode.status, mode.phase).toBe('completed'); expect(JSON.parse(await readFile(mode.file, 'utf8')).rows).toEqual([['\\', secret]])
    }
    cancel = true
    const cancelled = await transfer(request({ file: join(directory, 'cancelled.json') })); cancel = false
    expect(['cancelled', 'unknown']).toContain(cancelled.status); await expect(stat(cancelled.file)).rejects.toThrow()
    expect(JSON.stringify(updates)).not.toContain(secret); expect(JSON.stringify(driver.listTransferJobs())).not.toContain(secret)
    expect((await readdir(directory)).some(name => name.includes('dbcommander-backup-'))).toBe(false)
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }) }
}
