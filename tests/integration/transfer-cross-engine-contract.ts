import { expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DriverRegistry } from '../../src/driver/registry'
import { DEFAULT_PROFILE, type DatabaseEvent } from '../../src/shared/contracts'

export async function verifyCrossEngineTransfer(engine: 'sqlite' | 'duckdb') {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-cross-copy-')), events: DatabaseEvent[] = []
  const registry = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  try {
  const source = await registry.connect({ ...DEFAULT_PROFILE, password: '', engine, filePath: ':memory:', sqliteMode: 'memory', duckdbMode: 'memory' })
  const target = await registry.connect({ ...DEFAULT_PROFILE, password: '', engine: engine === 'sqlite' ? 'duckdb' : 'sqlite', filePath: ':memory:', sqliteMode: 'memory', duckdbMode: 'memory' })
  async function run(id: string, sql: string) {
    const queryId = registry.start({ sessionId: id, sql, maxRows: 10 }); await registry.wait(id)
    expect(events.find(event => event.type === 'complete' && event.queryId === queryId), sql).toMatchObject({ status: 'completed' })
    return events.flatMap(event => event.type === 'rows' && event.queryId === queryId ? event.rows : [])
  }
  const request = { action: 'capture' as const, sessionId: source.id, targetSessionId: target.id, table: { schema: 'main', name: 'received' }, sql: 'SELECT * FROM original', confirmed: true as const }
  async function capture() {
    const job = registry.startTransfer(request); await registry.waitTransfer(job.id)
    const done = registry.listTransferJobs().find(item => item.id === job.id)!
    expect(done, done.phase).toMatchObject({ status: 'completed', rows: 1 }); return done.capture!
  }
    await run(source.id, "CREATE TABLE original(id BIGINT, note VARCHAR(100), amount VARCHAR(100)); INSERT INTO original VALUES(9223372036854775807,'001','9007199254740993.12345678')")
    await run(target.id, 'CREATE TABLE received(id BIGINT, note VARCHAR(100), amount VARCHAR(100))')
    const review = await capture()
    const copy = { action: 'copy' as const, sessionId: target.id, captureId: review.id, mapping: ['id','note','amount'], signature: review.preview.signature, confirmed: true as const }
    const job = registry.startTransfer(copy); await registry.waitTransfer(job.id)
    expect(registry.listTransferJobs().find(item => item.id === job.id)).toMatchObject({ status: 'completed', rows: 1 })
    await run(target.id, 'COMMIT')
    expect(await run(target.id, 'SELECT * FROM received')).toEqual([['9223372036854775807','001','9007199254740993.12345678']])
    const first = await capture(), second = await capture()
    expect(() => registry.startTransfer(request)).toThrow(/two captures/)
    await registry.discardTransferCapture(second.id)
    const now = Date.now
    try { Date.now = () => Date.parse(first.expiresAt); expect(() => registry.startTransfer({ ...copy, captureId: first.id, signature: first.preview.signature })).toThrow(/expired/) }
    finally { Date.now = now }
    // Immediate cancellation is a real reserved capture, not a test-only write bypass.
    const cancelled = registry.startTransfer(request); registry.cancelTransfer(cancelled.id); await registry.waitTransfer(cancelled.id)
    expect(registry.listTransferJobs().find(job => job.id === cancelled.id)).toMatchObject({ status: 'cancelled', rows: 0 })
    expect(await run(target.id, 'SELECT COUNT(*) FROM received')).toEqual([['1']])
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }) }
}
