import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { delimitedRow, openDelimited } from '../../src/transfer/delimited'
import type { ConnectionConfig, DatabaseEvent, GridTable } from '../../src/shared/contracts'
import type { TransferJob, TransferRequest } from '../../src/shared/transfer'

export async function verifyDataTransfer(config: ConnectionConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-transfer-')), events: DatabaseEvent[] = []
  let cancelAction: 'import' | 'export' | undefined
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') }, {}, () => {}, job => {
    if (job.action === cancelAction && job.status === 'running' && job.rows > 0 && !job.cancellationRequested) driver.cancelTransfer(job.id)
  })
  const embedded = ['sqlite', 'duckdb'].includes(config.engine), oracle = config.engine === 'oracle'
  const local = { ...config, ...(embedded ? { filePath: join(directory, 'data.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : {}) }
  const session = await driver.connect(local)
  const independent = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
  const q = (value: string) => quoteIdentifier(value, config.engine), name = `transfer_${randomUUID().slice(0, 8)}`
  const text = ['sqlserver', 'azure-sql'].includes(config.engine) ? 'NVARCHAR' : 'VARCHAR'
  const special = 'O\'Brien, "quoted"\nUnicode Ω\t=1+1', payload = 'x'.repeat(2800)
  let table: GridTable
  async function run(sql: string, id = session.id, maxRows = 1000) {
    const queryId = driver.start({ sessionId: id, sql, maxRows }); await driver.wait(id)
    expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  async function transfer(request: TransferRequest): Promise<TransferJob> {
    const job = driver.startTransfer(request)
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/operation/)
    expect(await run(oracle ? 'SELECT 1 FROM dual' : 'SELECT 1', independent.id)).toEqual([['1']])
    await driver.waitTransfer(job.id)
    return driver.listTransferJobs().find(value => value.id === job.id)!
  }
  async function load(file: string, format: 'csv' | 'tsv' = 'csv') {
    const source = { sessionId: session.id, table, file, format }
    const preview = await driver.inspectImport(source)
    return { preview, request: { ...source, action: 'import' as const, mapping: preview.headers.map(header => header === 'source_label' ? 'label' : header), signature: preview.signature, confirmed: true as const } }
  }
  try {
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY,${q('label')} ${text}(3000),${q('note')} ${text}(30),${q('exact')} ${text}(40) DEFAULT 'default')`)
    const object = (await driver.schema(session.id)).objects.find(object => object.name === name)!
    table = { schema: object.schema, name, ...(object.catalog ? { catalog: object.catalog } : {}) }
    const file = join(directory, 'input.csv')
    const rows = Array.from({ length: 3205 }, (_, i) => [String(i), i === 0 ? special : payload, i === 0 ? null : i === 1 ? '' : i === 2 ? '\\N' : 'value', '9007199254740993.12345678'])
    await writeFile(file, '\uFEFF' + delimitedRow(['id', 'source_label', 'note', 'exact'], ',') + rows.map(row => delimitedRow(row, ',')).join(''))
    let { preview, request } = await load(file)
    expect(preview.rows).toHaveLength(10); expect(preview.rows[0]).toEqual(rows[0])
    let job = await transfer(request)
    expect(job, job.phase).toMatchObject({ status: 'completed', rows: rows.length, session: { transaction: 'transaction' } })
    expect(() => driver.startTransfer({ action: 'export', sessionId: session.id, file: join(directory, 'in-transaction.csv'), sql: `SELECT * FROM ${q(name)}`, format: 'csv', confirmed: true })).toThrow(/Commit or roll back/)
    await run('ROLLBACK'); expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([['0']])
    job = await transfer(request); expect(job, job.phase).toMatchObject({ status: 'completed', rows: rows.length })
    await run('COMMIT')
    const reader = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`, reader.id)).toEqual([[String(rows.length)]])
    await driver.disconnect(reader.id)
    // Preview caps are unchanged. Export goes beyond both 1,000 rows and 8 MiB.
    expect(await run(`SELECT * FROM ${q(name)} ORDER BY ${q('id')}`, session.id, 2)).toHaveLength(2)
    const previewQuery = events.filter(event => event.type === 'complete' && event.sessionId === session.id).at(-1)! as Extract<DatabaseEvent, { type: 'complete' }>
    for (const format of ['csv', 'tsv', 'json'] as const) {
      const output = join(directory, `full.${format}`), before = events.length
      job = await transfer({ action: 'export', sessionId: session.id, file: output, format, sql: `SELECT * FROM ${q(name)} ORDER BY ${q('id')}`, confirmed: true })
      expect(job, job.phase).toMatchObject({ status: 'completed', rows: rows.length, session: { transaction: 'idle' } })
      expect(events.slice(before).filter(event => event.type === 'rows' && event.sessionId === session.id)).toEqual([])
      expect((await stat(output)).size).toBeGreaterThan(8 * 1024 * 1024)
      if (format === 'json') {
        const data = JSON.parse(await readFile(output, 'utf8'))
        expect(data.columns.map((column: any) => column.name)).toEqual(['id', 'label', 'note', 'exact'])
        expect(data.rows).toHaveLength(rows.length); expect(data.rows[0]).toEqual(rows[0])
      } else {
        const source = await openDelimited(output, format)
        try {
          expect(source.headers).toEqual(['id', 'label', 'note', 'exact'])
          let count = 0
          for await (const row of source.records) { expect(row).toEqual(oracle && count === 1 ? [rows[1][0], rows[1][1], null, rows[1][3]] : rows[count]); count++ }
          expect(count).toBe(rows.length)
        } finally { await source.close() }
      }
      const size = (await stat(output)).size
      job = await transfer({ action: 'export', sessionId: session.id, file: output, format, sql: `SELECT * FROM ${q(name)}`, confirmed: true })
      expect(job.status).toBe('failed'); expect(job.phase).toMatch(/already exists/); expect((await stat(output)).size).toBe(size)
    }
    const cached = join(directory, 'cached.csv')
    await driver.exportCsv(previewQuery.queryId, 0, cached)
    const cachedSource = await openDelimited(cached, 'csv'); let cachedRows = 0
    try { for await (const _ of cachedSource.records) cachedRows++ } finally { await cachedSource.close() }
    expect(cachedRows).toBe(2)
    // Constraint/type/parse failures after successful rows roll back the entire batch.
    for (const content of ['id,label\n9001,new\n0,duplicate\n', 'id,label\n9001,new\nnot_integer,bad\n', 'id,label\n9001,new\n9002,"unterminated']) {
      // Put the failure after the preview window to exercise execution-time rollback.
      const [header, ...rest] = content.split('\n')
      const late = [header, ...Array.from({ length: 11 }, (_, i) => `${8000 + i},valid`), ...rest].join('\n')
      await writeFile(file, late); ({ request } = await load(file)); job = await transfer(request)
      expect(job.status, job.phase).toBe('failed'); expect(job.phase).toMatch(/record 14:/); expect(job.phase).toMatch(/rolled back/)
      expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([[String(rows.length)]])
    }
    await writeFile(file, 'id,label\n9999,changed\n'); ({ request } = await load(file)); await writeFile(file, 'id,label\n9999,changed again\n')
    job = await transfer(request); expect(job.status).toBe('failed'); expect(job.phase).toMatch(/changed/)
    await writeFile(file, delimitedRow(['id', 'label'], '\t') + delimitedRow(['9999', special], '\t'))
    ;({ request } = await load(file, 'tsv')); job = await transfer(request); expect(job.status, job.phase).toBe('completed'); await run('COMMIT')
    expect(await run(`SELECT ${q('label')},${q('exact')} FROM ${q(name)} WHERE ${q('id')}=9999`)).toEqual([[special, 'default']])
    // No primary key is needed for an append-only import.
    await run(`CREATE TABLE ${q(name + '_keyless')} (${q('id')} INTEGER)`)
    const original = table; table = { ...table, name: name + '_keyless' }
    await writeFile(file, 'id\n1\n'); ({ request } = await load(file)); expect((await transfer(request)).status).toBe('completed'); await run('ROLLBACK'); table = original
    await run(`DROP TABLE ${q(name + '_keyless')}`)
    await writeFile(file, 'id,label\n' + Array.from({ length: 1200 }, (_, i) => `${10000 + i},cancel me\n`).join(''))
    ;({ request } = await load(file)); cancelAction = 'import'; job = await transfer(request); cancelAction = undefined
    expect(job, job.phase).toMatchObject({ status: 'cancelled', session: { transaction: 'idle' } })
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([[String(rows.length + 1)]])
    const cancelledFile = join(directory, 'cancelled.csv')
    cancelAction = 'export'; job = await transfer({ action: 'export', sessionId: session.id, file: cancelledFile, format: 'csv', sql: `SELECT * FROM ${q(name)}`, confirmed: true }); cancelAction = undefined
    expect(['cancelled', 'unknown']).toContain(job.status); await expect(stat(cancelledFile)).rejects.toThrow()
    // SQLite cancellation intentionally closes its worker; reopen without replay.
    if (job.session?.transaction === 'unknown') {
      await driver.disconnect(session.id)
      const cleanup = await driver.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
      await run(`DROP TABLE ${q(name)}`, cleanup.id)
    } else await run(`DROP TABLE ${q(name)}`)
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }) }
}
