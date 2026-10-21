import { expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as tls from 'node:tls'
import { DriverRegistry } from '../../src/driver/registry'
import { runTool, type BackupOptions } from '../../src/backup/tools'
import type { ConnectionConfig, DatabaseEvent, SessionInfo } from '../../src/shared/contracts'
import type { BackupRequest } from '../../src/shared/backup'

/** Native executables run in the fixture image, in its network namespace. The
 * production streaming subprocess runner, TLS/auth files and archive paths are
 * unchanged; only the executable prefix and loopback port differ from desktop. */
function dockerTools(config: ConnectionConfig, directory: string): BackupOptions {
  if (!['postgres', 'mysql', 'mariadb'].includes(config.engine)) return {}
  const id = execFileSync('docker', ['compose', '-p', process.env.SQLCOMMANDER_TEST_PROJECT!, 'ps', '-q', config.engine], { encoding: 'utf8' }).trim()
  const image = execFileSync('docker', ['inspect', '--format', '{{.Image}}', id], { encoding: 'utf8' }).trim()
  return { temporaryRoot: directory, runTool: async (command, context) => {
    const args = [...command.args], env = { ...command.env }
    if (env.PGPORT) {
      env.PGPORT = '5432'
      writeFileSync(env.PGPASSFILE!, readFileSync(env.PGPASSFILE!, 'utf8').replace(`localhost:${config.port}:`, 'localhost:5432:'), { mode: 0o600 })
    }
    if (args[0]?.startsWith('--defaults-file=')) args.splice(config.engine === 'mysql' ? 2 : 1, 0, '--port=3306')
    const environment = Object.entries(env).filter(([key]) => key.startsWith('PG')).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    return runTool({ ...command, executable: 'docker', args: ['run', '--rm', '-i', '--network', `container:${id}`, '--volume', `${directory}:${directory}`, ...environment, '--entrypoint', basename(command.executable), image, ...args] }, context)
  } }
}

export async function verifyBackups(base: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-backup-contract-'))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), source = `sc_backup_${suffix}`, target = `sc_restore_${suffix}`
  const embedded = ['sqlite', 'duckdb'].includes(base.engine), oracle = base.engine === 'oracle'
  const adminConfig = { ...base, ...(['mysql', 'mariadb'].includes(base.engine) ? { user: 'root', password: 'local-root-test-only' } : base.engine === 'sqlserver' ? { user: 'sa', password: 'Local-SA-Only!2026' } : oracle ? { user: 'system', password: 'Local-Admin-Only2026' } : {}) }
  let cancelOnProgress = false
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') }, dockerTools(base, directory), job => { if (cancelOnProgress && job.phase.startsWith('SQLite snapshot:')) { cancelOnProgress = false; driver.cancelBackup(job.id) } })
  let events: DatabaseEvent[] = [], admin: SessionInfo | undefined, session: SessionInfo | undefined, restored: SessionInfo | undefined
  const quote = (value: string) => ['mysql', 'mariadb'].includes(base.engine) ? '`' + value.replaceAll('`', '``') + '`' : '"' + value.replaceAll('"', '""') + '"'
  const table = (name: string, schema = source.toUpperCase()) => oracle ? `${quote(schema)}.${name}` : name
  async function execute(id: string, sql: string, success = true) {
    events = []; driver.start({ sessionId: id, sql, maxRows: 100 }); await driver.wait(id)
    const complete = events.find(event => event.type === 'complete') as Extract<DatabaseEvent, { type: 'complete' }>
    if (success) expect(complete.status, complete.error).toBe('completed')
    return { rows: events.flatMap(event => event.type === 'rows' ? event.rows : []), complete }
  }
  const artifact = base.engine === 'sqlserver' ? `/var/opt/mssql/${source}.bak` : oracle ? `${source}.dmp` : join(directory, `backup.${base.engine}`)
  const targetPath = embedded ? join(directory, `restored.${base.engine}`) : oracle ? target.toUpperCase() : target
  const request = (action: 'backup' | 'restore', extra: Partial<BackupRequest> = {}): BackupRequest => ({ sessionId: session!.id, action, artifact, content: 'all', confirmed: true, ...(oracle ? { sourceSchema: source.toUpperCase(), directory: 'DATA_PUMP_DIR' } : {}), ...(action === 'restore' ? { target: targetPath } : {}), ...extra })
  async function job(input: BackupRequest, status = 'completed') {
    const started = driver.startBackup(input)
    const finished = await driver.waitBackup(started.id)
    expect(finished?.status, finished?.log.join('\n')).toBe(status)
    expect(JSON.stringify(finished)).not.toContain(adminConfig.password || 'nonexistent-secret')
    return finished!
  }
  try {
    if (embedded) session = await driver.connect({ ...base, filePath: join(directory, `source.${base.engine}`), sqliteMode: 'create', duckdbMode: 'create' })
    else {
      admin = await driver.connect(adminConfig)
      await execute(admin.id, oracle ? `CREATE USER ${quote(source.toUpperCase())} NO AUTHENTICATION DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS` : `CREATE DATABASE ${quote(source)}`)
      session = oracle ? admin : await driver.connect({ ...adminConfig, database: source })
    }
    const str = oracle ? 'NVARCHAR2(100)' : base.engine === 'sqlserver' ? 'NVARCHAR(100)' : 'VARCHAR(100)'
    const precise = base.engine === 'sqlite' ? 'TEXT' : 'DECIMAL(30,8)'
    const binary = base.engine === 'postgres' ? 'BYTEA' : oracle ? 'RAW(10)' : base.engine === 'sqlserver' || ['mysql', 'mariadb'].includes(base.engine) ? 'VARBINARY(10)' : 'BLOB'
    const blob = base.engine === 'postgres' ? "decode('00ff802c','hex')" : oracle ? "HEXTORAW('00ff802c')" : base.engine === 'sqlserver' ? '0x00ff802c' : base.engine === 'duckdb' ? "from_hex('00ff802c')" : "X'00ff802c'"
    const unicode = oracle || base.engine === 'sqlserver' ? "N'Hej 世界'" : "'Hej 世界'"
    await execute(session.id, `CREATE TABLE ${table('backup_parent')}(id INT PRIMARY KEY, label ${str} NOT NULL, amount ${precise}, payload ${binary}, missing ${str});
      CREATE TABLE ${table('backup_child')}(id INT PRIMARY KEY, parent_id INT, FOREIGN KEY(parent_id) REFERENCES ${table('backup_parent')}(id));
      INSERT INTO ${table('backup_parent')} VALUES(1,${unicode},'9007199254740993.12345678',${blob},NULL);
      INSERT INTO ${table('backup_child')} VALUES(1,1);${oracle ? 'COMMIT;' : ''}
      ${base.engine === 'sqlserver' ? 'GO\n' : ''}${oracle ? `ALTER SESSION SET CURRENT_SCHEMA=${quote(source.toUpperCase())};` : ''}CREATE VIEW ${table('backup_view')} AS SELECT label FROM backup_parent;`)
    const expected = (await execute(session.id, `SELECT * FROM ${table('backup_parent')}`)).rows
    // Active transactions, running jobs and target collisions must be guarded in
    // the host too, independent of UI button state.
    await execute(session.id, oracle ? 'SAVEPOINT backup_guard' : base.engine === 'sqlserver' ? 'BEGIN TRANSACTION' : 'BEGIN')
    expect(() => driver.startBackup(request('backup'))).toThrow(/Commit or roll back/)
    await execute(session.id, 'ROLLBACK')
    const started = driver.startBackup(request('backup'))
    expect(() => driver.start({ sessionId: session!.id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/database operation/)
    await expect(driver.disconnect(session.id)).rejects.toThrow(/database operation/)
    const backup = await driver.waitBackup(started.id)
    expect(backup?.status, backup?.log.join('\n')).toBe('completed')
    await job(request('backup'), 'failed') // Never replace backup media.
    await job(request('restore'))
    await job(request('restore'), 'failed') // Never replace existing database/file/schema.
    if (base.engine === 'postgres' && typeof tls.setDefaultCACertificates === 'function') {
      const roots = tls.getCACertificates('default')
      try {
        // Other fixtures also use CN=localhost. Scope this trust-store test to
        // PostgreSQL's CA, then restore the caller's roots in finally.
        tls.setDefaultCACertificates([base.ca!])
        const trusted = await driver.connect({ ...adminConfig, database: source, ca: '' })
        try { await job(request('backup', { sessionId: trusted.id, artifact: join(directory, 'runtime-roots.dump') })) }
        finally { await driver.disconnect(trusted.id) }
      } finally { tls.setDefaultCACertificates(roots) }
    }
    if (['mysql', 'mariadb', 'oracle', 'sqlserver'].includes(base.engine)) {
      const limited = await driver.connect(base)
      try {
        const denied = await job(request('restore', { sessionId: limited.id, target: `denied_${suffix}` }), 'failed')
        expect(denied.log.join('\n')).toMatch(/denied|privilege|permission|ORA-/i)
      } finally { await driver.disconnect(limited.id) }
    }
    restored = oracle ? session : await driver.connect({ ...adminConfig, database: target, filePath: targetPath, sqliteMode: 'read-write', duckdbMode: 'read-write' })
    expect((await execute(restored.id, `SELECT * FROM ${table('backup_parent', target.toUpperCase())}`)).rows).toEqual(expected)
    expect((await execute(restored.id, `SELECT COUNT(*) FROM ${table('backup_child', target.toUpperCase())}`)).rows).toEqual([['1']])
    await execute(session.id, `UPDATE ${table('backup_parent')} SET label='changed source';${oracle ? 'COMMIT;' : ''}`)
    expect((await execute(restored.id, `SELECT * FROM ${table('backup_view', target.toUpperCase())}`)).rows).toEqual([[expected[0][1]]])
    await execute(session.id, `UPDATE ${table('backup_parent')} SET label=${unicode};${oracle ? 'COMMIT;' : ''}`)
    expect((await execute(restored.id, `INSERT INTO ${table('backup_child', target.toUpperCase())} VALUES(2,999)`, false)).complete.status).toBe('failed')
    await execute(restored.id, 'ROLLBACK', false)
    expect((await execute(session.id, `SELECT * FROM ${table('backup_parent')}`)).rows).toEqual(expected)
    if (embedded || ['postgres', 'mysql', 'mariadb'].includes(base.engine)) {
      const corrupt = join(directory, 'corrupt.backup'); writeFileSync(corrupt, 'not a backup')
      const invalidTarget = embedded ? join(directory, 'invalid-target') : `invalid_${suffix}`
      await job(request('restore', { artifact: corrupt, target: invalidTarget }), 'failed')
      if (embedded) expect(existsSync(invalidTarget)).toBe(false)
      expect(readdirSync(directory).some(name => name.startsWith('dbcommander-auth-') || name.startsWith('.dbcommander-backup-'))).toBe(false)
    }
    if (['mysql', 'mariadb'].includes(base.engine)) {
      const broken = join(directory, 'failed-restore.sql')
      const prefix = readFileSync(artifact, 'utf8').split('\n')[0]
      writeFileSync(broken, prefix + '\nCREATE TABLE partial_restore(id INT); THIS IS NOT SQL;')
      const partialTarget = `partial_${suffix}`
      await job(request('restore', { artifact: broken, target: partialTarget }), 'failed')
      const partial = await driver.connect({ ...adminConfig, database: partialTarget })
      expect((await execute(partial.id, 'SELECT COUNT(*) FROM partial_restore')).rows).toEqual([['0']])
      await driver.disconnect(partial.id)
      await execute(admin!.id, `DROP DATABASE ${quote(partialTarget)}`)
    }
    if (base.engine !== 'sqlite' && base.engine !== 'sqlserver') {
      const schemaArtifact = oracle ? `schema_${suffix}.dmp` : join(directory, 'schema.backup')
      const schemaTarget = embedded ? join(directory, 'schema-target.duckdb') : oracle ? `SCHEMA_${suffix.toUpperCase()}` : `schema_${suffix}`
      await job(request('backup', { artifact: schemaArtifact, content: 'schema' }))
      await job(request('restore', { artifact: schemaArtifact, target: schemaTarget }))
      const schemaSession = oracle ? session : await driver.connect({ ...adminConfig, database: schemaTarget, filePath: schemaTarget, duckdbMode: 'read-write' })
      expect((await execute(schemaSession.id, `SELECT COUNT(*) FROM ${table('backup_parent', schemaTarget)}`)).rows).toEqual([['0']])
      if (!oracle) await driver.disconnect(schemaSession.id)
      if (admin) await execute(admin.id, oracle ? `DROP USER ${quote(schemaTarget)} CASCADE` : `DROP DATABASE ${quote(schemaTarget)}`)
    }
    if (base.engine === 'sqlite') {
      await execute(session.id, 'CREATE TABLE large_backup(payload BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<64) INSERT INTO large_backup SELECT zeroblob(1048576) FROM n')
      cancelOnProgress = true
      const interruptedPath = join(directory, 'interrupted.sqlite')
      await job(request('backup', { artifact: interruptedPath }), 'cancelled')
      expect(existsSync(interruptedPath)).toBe(false)
      expect((await execute(session.id, 'SELECT COUNT(*) FROM large_backup')).rows).toEqual([['64']])
    }
    // Cancellation before the native operation starts must not publish a file.
    const cancelledFile = embedded || ['postgres', 'mysql', 'mariadb'].includes(base.engine) ? join(directory, 'cancelled.backup') : oracle ? `cancel_${suffix}.dmp` : `/var/opt/mssql/cancel_${suffix}.bak`
    const cancelled = driver.startBackup(request('backup', { artifact: cancelledFile }))
    expect(driver.cancelBackup(cancelled.id).requested).toBe(true)
    expect((await driver.waitBackup(cancelled.id))?.status).toBe('cancelled')
    if (embedded) expect(existsSync(cancelledFile)).toBe(false)
    if (embedded) {
      await driver.disconnect(session.id)
      session = await driver.connect({ ...base, filePath: join(directory, `source.${base.engine}`), sqliteMode: 'read-only', duckdbMode: 'read-only' })
      await job(request('backup', { artifact: join(directory, 'readonly.backup'), content: base.engine === 'duckdb' ? 'schema' : 'all' }))
    }

  } finally {
    if (restored && restored.id !== session?.id) await driver.disconnect(restored.id).catch(() => {})
    if (session && session.id !== admin?.id) await driver.disconnect(session.id).catch(() => {})
    if (admin) for (const name of [target, source]) await execute(admin.id, oracle ? `DROP USER ${quote(name.toUpperCase())} CASCADE` : `DROP DATABASE ${quote(name)}`, false).catch(() => {})
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}
