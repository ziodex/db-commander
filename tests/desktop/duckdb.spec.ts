import { _electron as electron, test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendTableSelect } from './explorer-actions'

test('DuckDB file dialog, analytics, transactions, cancellation, export and persistent recovery', async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('duckdb'), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-duckdb-desktop-')), path = join(directory, 'analytics.duckdb')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  let application: ElectronApplication | undefined
  async function launch() {
    application = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string>
    })
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
    const page = await application.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    return page
  }
  async function enter(page: Page, sql: string) {
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(sql)
  }
  async function run(page: Page, sql: string, status = 'Completed') {
    await enter(page, sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText(status)
  }
  async function connect(page: Page, mode: string) {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('duckdb')
    for (const name of ['Host', 'Password', 'Transport security']) await expect(form.getByLabel(name, { exact: true })).toHaveCount(0)
    await form.getByLabel('Open mode').selectOption(mode)
    await form.getByRole('button', { name: mode === 'create' ? 'Choose new database file' : 'Browse database files' }).click()
    await expect(form.getByLabel('Database file', { exact: true })).toHaveValue(path)
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.locator('.statusbar .dialect-label')).toHaveText('DuckDB')
  }
  try {
    let page = await launch()
    await connect(page, 'create')
    await run(page, "CREATE TABLE customers AS SELECT 1 AS id, 'Ada Lovelace' AS name, 12345678901234567890.123456789::DECIMAL(38,9) AS balance;")
    await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
    await appendTableSelect(page, 'customers')
    await expect(page.locator('.monaco-editor')).toContainText('"analytics"."main"."customers"')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '12345678901234567890.123456789', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('duckdb-workbench.png') })
    const csv = join(directory, 'export.csv')
    await application!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csv)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(csv, 'utf8')).toContain('"12345678901234567890.123456789"')
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled()
    await run(page, "UPDATE customers SET name='uncommitted'; SELECT CAST('bad' AS INTEGER)", 'Failed')
    await expect(page.locator('.transaction-badge')).toHaveText('Transaction failed')
    await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await enter(page, 'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b; DELETE FROM customers;')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await run(page, 'SELECT name FROM customers')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await run(page, "BEGIN; UPDATE customers SET name='crashed'")
    await enter(page, 'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    const recovered = application!.waitForEvent('window')
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await recovered
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await connect(page, 'read-write')
    await run(page, 'SELECT name FROM customers')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await run(page, 'SELECT * FROM range(5000)')
    await expect(page.getByText(/Preview limit reached/).first()).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.profile?.duckdbMode)).toBe('read-write')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await connect(page, 'read-only')
    await run(page, 'DELETE FROM customers', 'Failed')
    await expect(page.locator('.error-banner')).toContainText('read-only')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await application!.close(); application = undefined
    page = await launch()
    await connect(page, 'read-write')
    await run(page, 'SELECT name FROM customers')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  } finally { await application?.close(); rmSync(directory, { recursive: true, force: true }) }
})
