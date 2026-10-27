import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { schemaColumnSchema } from '../../src/shared/schema-changes'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { runTool } from '../../src/backup/tools'

export function tunneledConfig(base: ConnectionConfig): ConnectionConfig {
  const destination = base.engine === 'azure-sql' ? 'sqlserver' : base.engine
  return { ...base, port: ({ postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, 'azure-sql': 1433, oracle: 2484 } as Record<string,number>)[base.engine],
    ssh: { host: '127.0.0.1', port: Number(process.env.SQLCOMMANDER_SSH_PORT), user: 'tunnel', authentication: 'password', fingerprint: process.env.SQLCOMMANDER_SSH_FINGERPRINT!, destinationHost: destination }, sshSecrets: { password: 'local-ssh-only' } }
}
export async function verifyConnectionSafeguards(base: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-connections-')), events: DatabaseEvent[] = []
  const driver = new DriverRegistry(event => { events.push(event) }, { workerPath: resolve('out/main/sqlite-worker.cjs') })
  const embedded = ['sqlite','duckdb'].includes(base.engine), config = { ...(embedded ? { ...base, filePath: join(directory, 'protected.db'), sqliteMode: 'create' as const, duckdbMode: 'create' as const } : tunneledConfig(base)), environment: 'production' as const, folder: 'Team/Production', favorite: true }
  const q = (name: string) => quoteIdentifier(name, base.engine), name = `guard_${randomUUID().replaceAll('-','').slice(0,8)}`
  async function run(id: string, sql: string) {
    const queryId = driver.start({ sessionId: id, sql, maxRows: 20 }); await driver.wait(id)
    const complete = events.find(e => e.type === 'complete' && e.queryId === queryId) as Extract<DatabaseEvent,{type:'complete'}>
    expect(complete.status, complete.error).toBe('completed')
    return events.flatMap(e => e.type === 'rows' && e.queryId === queryId ? e.rows : [])
  }
  let id: string | undefined
  try {
    const session = await driver.connect(config); id = session.id
    expect(session).toMatchObject({ ...(embedded ? {} : { host: base.host }), safety: { environment: 'production', protected: true, unlockedUntil: 0 } })
    if (!embedded) expect(session.safety?.ssh?.fingerprint).toBe(config.ssh!.fingerprint)
    expect(() => driver.start({ sessionId: id!, sql: 'SELECT 1', maxRows: 1 })).toThrow(/locked/)
    expect(() => driver.unlockSession(id!, 'wrong')).toThrow(/exact connection name/)
    driver.unlockSession(id, config.name)
    await run(id, `CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY, ${q('value')} INTEGER)`)
    await run(id, `INSERT INTO ${q(name)} VALUES (1,10)`); if (base.engine === 'oracle') await run(id, 'COMMIT')
    driver.lockSession(id)
    const found = (await driver.schema(id)).objects.find(table => table.name === name)!
    expect(found).toBeDefined()
    const table = { name: found.name, schema: found.schema, ...(found.catalog ? { catalog: found.catalog } : {}) }
    const grid = (await driver.editGrid({ action: 'open', sessionId: id, table })).grid!
    expect(grid.rows).toEqual([['1','10']])
    await expect(driver.editGrid({ action: 'apply', sessionId: id, snapshotId: grid.id, changes: [{ kind: 'delete', row: 0 }] })).rejects.toThrow(/locked/)
    expect(() => driver.start({ sessionId: id!, sql: 'COMMIT; DELETE FROM ' + q(name), maxRows: 1 })).toThrow(/locked/)
    expect(() => driver.startTransfer({ action: 'export', sessionId: id!, file: join(directory,'export.csv'), format: 'csv', sql: `SELECT * FROM ${q(name)}`, confirmed: true })).toThrow(/locked/)
    expect(() => driver.startTransfer({ action: 'import', sessionId: id!, table, file: join(directory,'import.csv'), format: 'csv', mapping: ['id'], signature: '0'.repeat(64), confirmed: true })).toThrow(/locked/)
    expect(() => driver.startBackup({ action: 'restore', sessionId: id!, artifact: join(directory,'backup'), target: join(directory,'restored'), content: 'all', confirmed: true })).toThrow(/locked/)
    const target = (await driver.schema(id)).catalog!.objects.find(object => object.name === name && object.kind === 'table')!
    const plan = await driver.prepareSchemaChange({ sessionId: id, change: { action: 'add-column', target, column: schemaColumnSchema.parse({ name: 'blocked', type: 'integer', nullable: true }) } })
    expect(() => driver.applySchemaChange({ sessionId: id!, planId: plan.id, confirmed: true, implicitCommitApproved: true, destructiveApproved: true })).toThrow(/locked/)
    driver.unlockSession(id, config.name)
    const other = await driver.connect({ ...config, sqliteMode: 'read-write', duckdbMode: 'read-write' })
    expect(driver.sessionSafety(other.id).unlockedUntil).toBe(0)
    expect(() => driver.start({ sessionId: other.id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/locked/)
    await driver.disconnect(other.id)
    await run(id, base.engine === 'oracle' ? 'SAVEPOINT GUARD_TEST' : ['sqlserver','azure-sql'].includes(base.engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    await run(id, `UPDATE ${q(name)} SET ${q('value')}=20`)
    driver.lockSession(id); await run(id, 'ROLLBACK')
    driver.unlockSession(id, config.name)
    expect(await run(id, `SELECT ${q('value')} FROM ${q(name)}`)).toEqual([['10']])
    await run(id, `DROP TABLE ${q(name)}`)
    if (!embedded && base.engine !== 'oracle') {
      const databases = await driver.databases(id), destination = databases.databases.find(database => database !== session.database)
      if (destination) { const replacement = await driver.switchDatabase({ sessionId: id, database: destination }); id = replacement.id; expect(replacement.safety?.unlockedUntil).toBe(0); expect(replacement.safety?.ssh).toBeDefined(); expect(() => driver.sessionSafety(session.id)).toThrow(/disconnected/) }
    }
    await driver.disconnect(id); id = undefined
    if (!embedded) {
      const ssh = config.ssh!
      await expect(driver.connect({ ...config, ssh: { ...ssh, fingerprint: 'SHA256:'+'A'.repeat(43) } })).rejects.toThrow(/host key/)
      await expect(driver.connect({ ...config, sshSecrets: { password: 'deliberately-wrong-secret' } })).rejects.toThrow(/SSH connection or authentication failed/)
      await expect(driver.connect({ ...config, host: 'wrong.invalid' })).rejects.toThrow(/certificate|hostname|TLS|altname|DN/i)
      const keyed = await driver.connect({ ...config, ssh: { ...ssh, authentication: 'private-key', privateKeyPath: process.env.SQLCOMMANDER_SSH_KEY }, sshSecrets: { passphrase: 'local-key-passphrase' } })
      driver.unlockSession(keyed.id, config.name); expect((await run(keyed.id, base.engine === 'oracle' ? 'SELECT 42 FROM dual' : 'SELECT 42'))[0][0]).toBe('42')
      const sql = base.engine === 'postgres' ? 'SELECT pg_sleep(20)' : ['mysql','mariadb'].includes(base.engine) ? 'SELECT SLEEP(20)' : base.engine === 'oracle' ? 'BEGIN DBMS_SESSION.SLEEP(20); END;' : "WAITFOR DELAY '00:00:20'"
      const queryId = driver.start({ sessionId: keyed.id, sql, maxRows: 1 }); await new Promise(resolve => setTimeout(resolve, 250)); await driver.cancel(keyed.id); await driver.wait(keyed.id)
      expect(events.find(e => e.type === 'complete' && e.queryId === queryId)).toMatchObject({ status: 'cancelled' })
      expect((await run(keyed.id, base.engine === 'oracle' ? 'SELECT 43 FROM dual' : 'SELECT 43'))[0][0]).toBe('43')
      await driver.disconnect(keyed.id)
      await expect(driver.connect({ ...config, port: 65534 })).rejects.toThrow()
    }
  } finally {
    if (id) { try { driver.unlockSession(id, config.name); await run(id, 'ROLLBACK'); await run(id, `DROP TABLE ${q(name)}`) } catch {} }
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}

export async function verifySshAgent(base: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-agent-')), previous = process.env.SSH_AUTH_SOCK
  const driver = new DriverRegistry(() => {}), config = tunneledConfig(base)
  let pid: number | undefined
  try {
    const output = execFileSync('ssh-agent', ['-s'], { encoding: 'utf8' })
    const socket = output.match(/SSH_AUTH_SOCK=([^;]+);/)![1]; pid = Number(output.match(/SSH_AGENT_PID=(\d+);/)![1])
    const askpass = join(directory,'askpass'); writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" "local-key-passphrase"\n', { mode: 0o700 })
    execFileSync('ssh-add', [process.env.SQLCOMMANDER_SSH_KEY!], { env: { ...process.env, SSH_AUTH_SOCK: socket, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' }, stdio: 'pipe' })
    process.env.SSH_AUTH_SOCK = socket
    const session = await driver.connect({ ...config, ssh: { ...config.ssh!, authentication: 'agent' }, sshSecrets: undefined })
    expect((await driver.schema(session.id)).objects.length).toBeGreaterThan(0)
    await driver.disconnect(session.id)
  } finally { await driver.close(); if (previous === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previous; if (pid) process.kill(pid, 'SIGTERM'); rmSync(directory, { recursive: true, force: true }) }
}

export async function verifySshPostgresBackup(base: ConnectionConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-ssh-backup-')), config = tunneledConfig(base), target = 'ssh_restore_'+randomUUID().replaceAll('-','').slice(0,8)
  const container = execFileSync('docker', ['compose','-p',process.env.SQLCOMMANDER_TEST_PROJECT!,'ps','-q','postgres'], { encoding: 'utf8' }).trim()
  const image = execFileSync('docker', ['inspect','--format','{{.Image}}',container], { encoding: 'utf8' }).trim()
  // Clients in a separate Docker process reach the host's loopback tunnel via
  // host networking on Linux or Docker Desktop's host gateway on macOS.
  const network = process.platform === 'linux' ? ['--network','host'] : []
  const hostAddress = process.platform === 'linux' ? '127.0.0.1' : execFileSync('docker', ['run','--rm','--entrypoint','getent',image,'hosts','host.docker.internal'], { encoding: 'utf8' }).trim().split(/\s+/)[0]
  const driver = new DriverRegistry(() => {}, undefined, { temporaryRoot: directory, runTool: async (command, context) => {
    const env = { ...command.env }
    if (env.PGHOSTADDR) { expect(env.PGHOSTADDR).toBe('127.0.0.1'); expect(env.PGHOST).toBe(config.host); expect(env.PGSSLMODE).toBe('verify-full'); env.PGHOSTADDR = hostAddress }
    const environment = Object.entries(env).filter(([key]) => key.startsWith('PG')).flatMap(([key,value]) => ['--env',`${key}=${value}`])
    return runTool({ ...command, executable: 'docker', args: ['run','--rm','-i',...network,'--volume',`${directory}:${directory}`,...environment,'--entrypoint',basename(command.executable),image,...command.args] }, context)
  } })
  let sessionId: string | undefined
  try {
    const session = await driver.connect(config); sessionId = session.id
    const artifact = join(directory,'tunneled.dump')
    const backup = driver.startBackup({ sessionId, action: 'backup', artifact, content: 'all', confirmed: true })
    const backedUp = await driver.waitBackup(backup.id); expect(backedUp?.status, backedUp?.phase).toBe('completed')
    const restore = driver.startBackup({ sessionId, action: 'restore', artifact, target, content: 'all', confirmed: true })
    const restored = await driver.waitBackup(restore.id); expect(restored?.status, restored?.phase).toBe('completed')
    const check = await driver.connect({ ...config, database: target })
    expect((await driver.schema(check.id)).objects.some(table => table.name === 'customers')).toBe(true)
    await driver.disconnect(check.id)
  } finally {
    if (sessionId) { driver.start({ sessionId, sql: `DROP DATABASE IF EXISTS "${target}"`, maxRows: 1 }); await driver.wait(sessionId) }
    await driver.close(); rmSync(directory, { recursive: true, force: true })
  }
}

export async function verifySshLoss(base: ConnectionConfig) {
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) })
  const docker = (args: string[]) => execFileSync('docker', ['compose', '-p', process.env.SQLCOMMANDER_TEST_PROJECT!, ...args], { stdio: 'pipe' })
  try {
    const session = await driver.connect(tunneledConfig(base))
    driver.start({ sessionId: session.id, sql: 'BEGIN; SELECT pg_sleep(30)', maxRows: 1 })
    await new Promise(resolve => setTimeout(resolve, 250)); docker(['kill','-s','KILL','ssh'])
    await driver.wait(session.id)
    await expect.poll(() => events.some(e => e.type === 'session-lost' && e.sessionId === session.id)).toBe(true)
    expect(events.find(e => e.type === 'complete')).toMatchObject({ status: 'unknown' })
    expect(() => driver.start({ sessionId: session.id, sql: 'SELECT 1', maxRows: 1 })).toThrow(/disconnected/)
  } finally {
    try { await driver.close() } finally {
      // Older Compose versions on hosted agents do not support start --wait.
      // Restart the existing fixture and wait for its health check explicitly.
      docker(['start','ssh'])
      const container = docker(['ps','-q','ssh']).toString().trim()
      expect(container).not.toBe('')
      await expect.poll(() => execFileSync('docker', ['inspect','--format','{{.State.Health.Status}}',container], { encoding: 'utf8' }).trim(), { timeout: 45000 }).toBe('healthy')
    }
  }
}
