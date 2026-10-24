import { waitForWorkspaceReady } from './workspace-ready'
import { openBackup } from './explorer-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { engineNames, type DatabaseEngine } from '../../src/shared/contracts'

for (const engine of ['sqlite', 'duckdb'] as const) test(`backup ${engine}: review, native round trip, target protection, transactions and history`, async ({}, testInfo) => {
  test.setTimeout(90000)
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-backup-${engine}-`)), backup = join(directory, `backup.${engine}`), restored = join(directory, `restored.${engine}`)
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(); await waitForWorkspaceReady(page); return page
  }
  async function run(page: Page, sql: string) {
    await page.locator('.monaco-editor').first().click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
  }
  try {
    let page = await launch()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog'); await connection.getByLabel('Database engine').selectOption(engine); await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    await run(page, "CREATE TABLE backup_data(id BIGINT PRIMARY KEY, value VARCHAR); INSERT INTO backup_data VALUES(9223372036854775807,'backup value');")
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await openBackup(page)
    let form = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await expect(form.getByRole('button', { name: 'Review job' })).toBeDisabled()
    await form.getByRole('button', { name: 'Close backup dialog' }).click(); await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await openBackup(page)
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, backup)
    await form.getByRole('button', { name: 'Choose backup destination' }).click(); await expect(form.getByLabel('Backup file', { exact: true })).toHaveValue(backup)
    await form.getByRole('button', { name: 'Review job' }).click()
    await expect(form.getByRole('button', { name: 'Start backup' })).toBeDisabled()
    await expect(form).toContainText(backup)
    await form.getByRole('checkbox').check(); await form.getByRole('button', { name: 'Start backup' }).click()
    await expect(form.locator('.backup-status')).toHaveText('completed')
    expect(existsSync(backup)).toBe(true)
    await form.getByRole('button', { name: 'Configure another job' }).click()
    await form.getByLabel('Operation').selectOption('restore'); await form.getByLabel('New database file').fill(restored)
    await form.getByRole('button', { name: 'Review job' }).click(); await expect(form).toContainText(restored)
    await form.getByRole('checkbox').check(); await form.getByRole('button', { name: 'Start restore' }).click(); await expect(form.locator('.backup-status')).toHaveText('completed')
    const rows = await page.evaluate(async ({ engine, filePath }) => {
      const api = window.dbCommander, session = await api.connect({ engine, filePath, sqliteMode: 'read-write', duckdbMode: 'read-write', host: 'local', port: 1, database: 'local', name: 'Restored backup', user: 'local', password: '', tls: 'disable' })
      const rows: (string | null)[][] = []
      const completed = new Promise<void>((resolve, reject) => { const off = api.onEvent(event => { if (!('sessionId' in event) || event.sessionId !== session.id) return; if (event.type === 'rows') rows.push(...event.rows); if (event.type === 'complete') { off(); event.status === 'completed' ? resolve() : reject(new Error(event.error)) } }) })
      await api.run({ sessionId: session.id, sql: 'SELECT * FROM backup_data', maxRows: 10 }); await completed; await api.disconnect(session.id); return rows
    }, { engine, filePath: restored })
    expect(rows).toEqual([['9223372036854775807', 'backup value']])
    // A repeated restore is rejected and the existing file remains unchanged.
    const before = readFileSync(restored)
    await form.getByRole('button', { name: 'Configure another job' }).click(); await form.getByRole('button', { name: 'Review job' }).click(); await form.getByRole('checkbox').check(); await form.getByRole('button', { name: 'Start restore' }).click()
    await expect(form.locator('.backup-status')).toHaveText('failed'); await expect(form).toContainText('already exists'); expect(readFileSync(restored)).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath(`backup-${engine}.png`) })
    await form.getByRole('button', { name: 'Close backup dialog' }).click()
    await app!.close(); app = undefined
    page = await launch(); await openBackup(page)
    form = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await expect(form.locator('.backup-job-list button')).toHaveCount(3)
    expect(readFileSync(join(directory, 'backup-jobs.json'), 'utf8')).not.toContain('password')
  } finally { if (app) await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('backup recovery: interrupted restore is unknown after restart, never replayed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-backup-recovery-')), id = randomUUID()
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  writeFileSync(join(directory, 'backup-jobs.json'), JSON.stringify([{ id, sessionId: randomUUID(), engine: 'sqlite', action: 'restore', database: 'old', artifact: '/missing/backup', target: join(directory, 'must-not-exist'), status: 'running', phase: 'Restoring', log: [], startedAt: new Date().toISOString() }]))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(); await waitForWorkspaceReady(page)
    await openBackup(page)
    await page.locator('.backup-job-list button').click(); await expect(page.locator('.backup-status')).toHaveText('unknown'); await expect(page.getByRole('dialog')).toContainText('No operation was replayed')
    expect(existsSync(join(directory, 'must-not-exist'))).toBe(false)
  } finally { if (app) await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

for (const engine of ['postgres', 'mysql', 'mariadb', 'sqlserver', 'oracle'] as const) test(`backup ${engine}: Docker desktop native backup and restore`, async () => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'Engine not selected by Docker runner')
  const prefix = engine === 'postgres' ? 'PG' : engine.toUpperCase()
  test.skip(['postgres', 'mysql', 'mariadb'].includes(engine) && !process.env[`SQLCOMMANDER_${prefix}_TOOLS`], 'Desktop native client shim requires the POSIX Docker runner')
  test.setTimeout(180000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-backup-network-')), suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const artifact = engine === 'sqlserver' ? `/var/opt/mssql/desktop_${suffix}.bak` : engine === 'oracle' ? `desktop_${suffix}.dmp` : join(directory, 'database.backup')
  const target = engine === 'oracle' ? `DESKTOP_${suffix.toUpperCase()}` : `desktop_${suffix}`
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  if (engine === 'postgres') env.NODE_EXTRA_CA_CERTS = process.env.SQLCOMMANDER_PG_CA
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
    const page = await app.firstWindow(); await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog'); await connection.getByLabel('Database engine').selectOption(engine)
    await connection.getByLabel('Host', { exact: true }).fill('localhost'); await connection.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
    await connection.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
    await connection.getByLabel('User', { exact: true }).fill(engine === 'oracle' ? 'system' : engine === 'sqlserver' ? 'sa' : engine === 'postgres' ? 'dbcommander' : 'root')
    await connection.getByLabel('Password', { exact: true }).fill(engine === 'oracle' ? 'Local-Admin-Only2026' : engine === 'sqlserver' ? 'Local-SA-Only!2026' : engine === 'postgres' ? 'local-test-only' : 'local-root-test-only')
    if (engine !== 'oracle' && engine !== 'postgres') { await connection.getByText('Custom CA certificate', { exact: true }).click(); await connection.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    await openBackup(page)
    const form = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await expect(form).toContainText(engineNames[engine as DatabaseEngine])
    await form.getByLabel(engine === 'oracle' ? 'Dump filename' : engine === 'sqlserver' ? 'Backup file on database server' : 'Backup file', { exact: true }).fill(artifact)
    if (engine === 'oracle') await form.getByLabel('Source schema').fill('DBCOMMANDER')
    if (['postgres', 'mysql', 'mariadb'].includes(engine)) await form.getByLabel('Native tools directory (optional)').fill(process.env[`SQLCOMMANDER_${prefix}_TOOLS`]!)
    await form.getByRole('button', { name: 'Review job' }).click(); await form.getByRole('checkbox').check(); await form.getByRole('button', { name: 'Start backup' }).click()
    await expect(form.locator('.backup-status')).toHaveText('completed', { timeout: 90000 })
    await form.getByRole('button', { name: 'Configure another job' }).click(); await form.getByLabel('Operation').selectOption('restore')
    await form.getByLabel(engine === 'oracle' ? 'New schema name (case sensitive)' : 'New database name').fill(target)
    await form.getByRole('button', { name: 'Review job' }).click(); await form.getByRole('checkbox').check(); await form.getByRole('button', { name: 'Start restore' }).click()
    await expect(form.locator('.backup-status')).toHaveText('completed', { timeout: 90000 })
    await form.getByRole('button', { name: 'Close backup dialog' }).click()
    // The source tab stays connected; restored data can be explicitly selected.
    await page.locator('.monaco-editor').first().click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(engine === 'oracle' ? `SELECT COUNT(*) FROM "${target}".customers; DROP USER "${target}" CASCADE;` : engine === 'postgres' ? `DROP DATABASE "${target}"; SELECT COUNT(*) FROM customers;` : `SELECT COUNT(*) FROM ${engine === 'sqlserver' ? `[${target}].dbo.customers` : '`' + target + '`.customers'}; DROP DATABASE ${engine === 'sqlserver' ? '[' + target + ']' : '`' + target + '`'};`)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
  } finally { if (app) await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
