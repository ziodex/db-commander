import { expect, it } from 'vitest'
import { backup, DatabaseSync } from 'node:sqlite'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { publishFile } from '../../src/backup/files'
import { copyDuckDatabase } from '../../src/backup/embedded'
import { SqliteDriver } from '../../src/driver/sqlite'

// Actual EACCES from an owned, read-only scratch directory. No filesystem or
// native-engine mocks: the final artifact must still open as a valid snapshot.
for (const engine of ['sqlite', 'duckdb'] as const) for (const outcome of ['completed', 'query-failed', 'cancelled'] as const) {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(`backup finalization ${engine}: ${outcome} survives a real cleanup permission failure`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `backup-finalization-${engine}-`)), file = join(directory, `snapshot.${engine}`)
    const controller = new AbortController(), messages: string[] = [], context = { signal: controller.signal, log(message: string) { messages.push(message) } }
    let sqlite: DatabaseSync | undefined, instance: DuckDBInstance | undefined, client: DuckDBConnection | undefined, scratch: string | undefined, primary: unknown
    const sql = "CREATE TABLE payload(id BIGINT, label VARCHAR); INSERT INTO payload VALUES(9223372036854775807,'snapshot Ω');"
    const expected = [['9223372036854775807', 'snapshot Ω']]
    try {
      if (engine === 'sqlite') { sqlite = new DatabaseSync(':memory:'); sqlite.exec(sql) }
      else { instance = await DuckDBInstance.create(':memory:'); client = await instance.connect(); await client.run(sql) }
      const copy = async (temporary: string, live = context) => {
        if (sqlite) await backup(sqlite, temporary)
        else {
          const source = String((await client!.runAndReadAll('SELECT current_database()')).getRows()[0][0])
          await copyDuckDatabase(client!, source, temporary, false, live)
        }
      }
      const operation = publishFile(file, context, async temporary => {
        await copy(temporary)
        scratch = dirname(temporary); await chmod(scratch, 0o500)
        if (outcome === 'cancelled') { primary = new Error('Cancelled after copying snapshot'); controller.abort(primary) }
        if (outcome === 'query-failed') {
          try {
            if (sqlite) sqlite.prepare('SELECT * FROM missing_finalization_table').all()
            else await client!.run('SELECT * FROM missing_finalization_table')
          } catch (error) { primary = error; throw error }
        }
      })
      if (outcome === 'completed') await operation
      else {
        const error = await operation.then(() => undefined, error => error)
        expect(primary).toBeDefined(); expect(error).toBe(primary)
        await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(messages.filter(message => /temporary.*could not be removed/i.test(message))).toEqual([
        expect.stringContaining(scratch!)
      ])
      expect((await stat(scratch!)).mode & 0o077).toBe(0)
      if (outcome === 'completed') expect((await stat(join(scratch!, 'backup'))).mode & 0o777).toBe(0o600)
      // Manual repair of only this fixture's folder, then explicit retry. A
      // completed destination must retain its bytes and reject another backup.
      await chmod(scratch!, 0o700); await rm(scratch!, { recursive: true })
      const live = { signal: new AbortController().signal, log(message: string) { messages.push(message) } }
      if (outcome === 'completed') {
        const saved = await readFile(file)
        await expect(publishFile(file, live, temporary => copy(temporary, live))).rejects.toThrow('already exists')
        expect(await readFile(file)).toEqual(saved)
      } else await publishFile(file, live, temporary => copy(temporary, live))
      expect(await readdir(directory)).toEqual([`snapshot.${engine}`])
      if (sqlite) {
        const restored = new DatabaseSync(file, { readOnly: true })
        try {
          expect(restored.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
          const statement = restored.prepare('SELECT id,label FROM payload'); statement.setReadBigInts(true); statement.setReturnArrays(true)
          expect((statement.all() as unknown as unknown[][]).map(row => row.map(String))).toEqual(expected)
        } finally { restored.close() }
      } else {
        const restored = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' })
        let connection: DuckDBConnection | undefined
        try { connection = await restored.connect(); expect((await connection.runAndReadAll('SELECT id,label FROM payload')).getRows().map(row => row.map(String))).toEqual(expected) }
        finally { connection?.closeSync(); restored.closeSync() }
      }
    } finally {
      sqlite?.close(); client?.closeSync(); instance?.closeSync()
      if (scratch) await chmod(scratch, 0o700).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })
}

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('SQLite worker forwards cleanup warnings while a completed snapshot remains successful', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-worker-finalization-')), file = join(directory, 'snapshot.sqlite'), wrapper = join(directory, 'worker.cjs')
  const logs: string[] = [], driver = new SqliteDriver(() => {}, { workerPath: wrapper })
  try {
    // Change only this worker's own scratch permissions immediately before its
    // real removal attempt; retain production native backup and IPC handling.
    await writeFile(wrapper, `const fs = require('node:fs/promises'), path = require('node:path'), remove = fs.rm;
fs.rm = async (folder, options) => {
  if (path.dirname(String(folder)) === ${JSON.stringify(directory)} && path.basename(String(folder)).startsWith('.dbcommander-backup-')) await fs.chmod(folder, 0o500);
  return remove(folder, options);
};
require(${JSON.stringify(resolve('out/main/sqlite-worker.cjs'))});
`)
    const session = await driver.connect({ engine: 'sqlite', name: 'Cleanup warning', host: 'local', port: 1, user: 'local', password: '', database: 'local', tls: 'disable', sqliteMode: 'memory' })
    driver.start({ sessionId: session.id, sql: "CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained Ω');", maxRows: 10 })
    await driver.wait(session.id)
    await driver.backup({ action: 'backup', sessionId: session.id, artifact: file, content: 'all', confirmed: true }, { signal: new AbortController().signal, log(message) { logs.push(message) } })
    const scratch = (await readdir(directory)).find(name => name.startsWith('.dbcommander-backup-'))!
    expect(logs).toContainEqual(expect.stringContaining(`could not be removed from ${join(directory, scratch)}`))
    const snapshot = new DatabaseSync(file, { readOnly: true })
    try { expect(snapshot.prepare('SELECT value FROM payload').get()).toEqual({ value: 'retained Ω' }); expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' }) }
    finally { snapshot.close() }
  } finally {
    await driver.close()
    for (const folder of await readdir(directory)) if (folder.startsWith('.dbcommander-backup-')) await chmod(join(directory, folder), 0o700)
    await rm(directory, { recursive: true, force: true })
  }
})
