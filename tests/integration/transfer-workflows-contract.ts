import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { inferImportColumns } from '../../src/shared/import-inference'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import type { TransferRequest } from '../../src/shared/transfer'

export async function verifyTransferWorkflows(config: ConnectionConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-d2-')), events: DatabaseEvent[] = []
  let cancel: 'capture' | 'copy' | undefined
  const registry = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') }, {}, () => {}, job => {
    if (job.action === cancel && job.status === 'running' && job.rows > 0 && !job.cancellationRequested) registry.cancelTransfer(job.id)
  })
  const embedded = ['sqlite','duckdb'].includes(config.engine), local = embedded ? { ...config, filePath: join(directory, 'data.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : config
  const source = await registry.connect(local), target = await registry.connect({ ...local, sqliteMode: 'read-write', duckdbMode: 'read-write' })
  const schema = config.engine === 'postgres' ? 'public' : ['sqlserver','azure-sql'].includes(config.engine) ? 'dbo' : config.engine === 'oracle' ? config.user.toUpperCase() : embedded ? 'main' : target.database
  const name = `d2_${randomUUID().slice(0, 8)}`, table = { schema, name }, q = (name: string) => quoteIdentifier(name, config.engine)
  async function run(sql: string, id = target.id) {
    const queryId = registry.start({ sessionId: id, sql, maxRows: 10 }); await registry.wait(id)
    expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  async function transfer(request: TransferRequest) {
    const job = registry.startTransfer(request); await registry.waitTransfer(job.id)
    return registry.listTransferJobs().find(value => value.id === job.id)!
  }
  const captureRequest = { action: 'capture' as const, sessionId: source.id, targetSessionId: target.id, table, sql: `SELECT * FROM ${q(name + '_source')} ORDER BY ${q('id')}`, confirmed: true as const }
  try {
    const columns = inferImportColumns(config.engine, ['id','code','amount'], [['1','001','9007199254740993.12345678']])
    // Keep the amount text in this fixture so every destination preserves its exact representation.
    columns[2] = { ...columns[2], type: config.engine === 'oracle' ? 'varchar' : 'text' }
    const plan = await registry.prepareSchemaChange({ sessionId: target.id, change: { action: 'create-table', location: { schema }, name, columns } })
    expect(plan.sql).toContain('CREATE TABLE')
    expect((await registry.schema(target.id)).objects.some(object => object.name === name)).toBe(false)
    const created = await registry.applySchemaChange({ sessionId: target.id, planId: plan.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: false })
    expect(created.status, created.message).toBe('completed')
    if (created.session.transaction !== 'idle') await run('COMMIT')
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([['0']])
    const file = join(directory, 'rows.jsonl'), rows = Array.from({ length: 1205 }, (_, i) => [String(i), i === 0 ? '001' : i === 1 ? null : `Ω\n${i}`, '9007199254740993.12345678'])
    const header = JSON.stringify({ columns: ['id','code','amount'].map(name => ({ name, typeId: 0 })) }) + '\n'
    await writeFile(file, header + [...rows.slice(0, 11), ['not_an_integer','late error','exact']].map(row => JSON.stringify(row)).join('\n'))
    const partial = await registry.inspectImport({ sessionId: target.id, table, file, format: 'jsonl' })
    const rejected = await transfer({ action: 'import', sessionId: target.id, table, file, format: 'jsonl', mapping: partial.headers, signature: partial.signature, confirmed: true })
    expect(rejected, rejected.phase).toMatchObject({ status: 'failed', session: { transaction: 'idle' } })
    expect(rejected.phase).toMatch(/record 13:.*rolled back/)
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([['0']]) // The already committed empty table remains.
    await writeFile(file, header + rows.map(row => JSON.stringify(row)).join('\n'))
    const preview = await registry.inspectImport({ sessionId: target.id, table, file, format: 'jsonl' })
    expect(preview.rows).toHaveLength(10)
    let job = await transfer({ action: 'import', sessionId: target.id, table, file, format: 'jsonl', mapping: preview.headers, signature: preview.signature, confirmed: true })
    expect(job, job.phase).toMatchObject({ status: 'completed', rows: 1205, session: { transaction: 'transaction' } }); await run('COMMIT')
    await run(['sqlserver','azure-sql'].includes(config.engine) ? `SELECT * INTO ${q(name + '_source')} FROM ${q(name)}` : `CREATE TABLE ${q(name + '_source')} AS SELECT * FROM ${q(name)}`)
    await run(`DELETE FROM ${q(name)}`); if (config.engine === 'oracle') await run('COMMIT')
    expect(() => registry.startTransfer({ ...captureRequest, targetSessionId: source.id })).toThrow(/different physical/)
    const capturing = registry.startTransfer(captureRequest)
    for (const id of [source.id, target.id]) expect(() => registry.start({ sessionId: id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/operation/)
    await registry.waitTransfer(capturing.id); job = registry.listTransferJobs().find(job => job.id === capturing.id)!
    expect(job, job.phase).toMatchObject({ status: 'completed', rows: 1205 }); const review = job.capture!
    expect(review.preview.rows).toHaveLength(10); expect(review.table).toEqual(table)
    // Change the source after capture. Copy must use the reviewed bytes, never replay SELECT.
    await run(`DELETE FROM ${q(name + '_source')}`, source.id); if (config.engine === 'oracle') await run('COMMIT', source.id)
    const copy = { action: 'copy' as const, sessionId: target.id, captureId: review.id, mapping: review.preview.headers, signature: review.preview.signature, confirmed: true as const }
    expect(() => registry.startTransfer({ ...copy, sessionId: source.id })).toThrow(/unavailable/)
    job = await transfer(copy); expect(job, job.phase).toMatchObject({ status: 'completed', rows: 1205, session: { transaction: 'transaction' } })
    expect(() => registry.startTransfer(copy)).toThrow(/Commit or roll back|unavailable/)
    await run('COMMIT'); expect(await run(`SELECT ${q('code')},${q('amount')} FROM ${q(name)} WHERE ${q('id')}=0`)).toEqual([['001','9007199254740993.12345678']])
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([['1205']])
    expect(() => registry.startTransfer(copy)).toThrow(/unavailable/)
    expect(registry.listTransferJobs().find(job => job.id === capturing.id)?.capture).toBeUndefined()
    // A cancelled destination transfer rolls back every row. The consumed capture cannot be retried.
    const again = await transfer({ ...captureRequest, sql: `SELECT * FROM ${q(name)} ORDER BY ${q('id')}` })
    const second = again.capture!; cancel = 'copy'
    job = await transfer({ ...copy, captureId: second.id, signature: second.preview.signature }); cancel = undefined
    expect(job, job.phase).toMatchObject({ status: 'cancelled', session: { transaction: 'idle' } })
    expect(await run(`SELECT COUNT(*) FROM ${q(name)}`)).toEqual([['1205']])
    const discard = await transfer({ ...captureRequest, sql: `SELECT * FROM ${q(name)}` })
    await registry.discardTransferCapture(discard.capture!.id)
    expect(() => registry.startTransfer({ ...copy, captureId: discard.capture!.id, signature: discard.capture!.preview.signature })).toThrow(/unavailable/)
    await run(`DROP TABLE ${q(name + '_source')}`); await run(`DROP TABLE ${q(name)}`)
    expect((await readdir(directory)).some(path => path.endsWith('.tmp'))).toBe(false)
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }) }
}
