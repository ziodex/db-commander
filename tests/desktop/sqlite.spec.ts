import { _electron as electron, test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendTableSelect } from './explorer-actions'

test('SQLite file dialog, local SQL, transactions, read-only mode, Stop and crash recovery', async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlite'), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-sqlite-desktop-'))
  const path = join(directory, 'local.sqlite')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  let application: ElectronApplication | undefined
  async function launch() {
    application = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
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
  async function run(page: Page, sql: string) {
    await enter(page, sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
  }
  async function connect(page: Page, mode: string) {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await expect(form.getByLabel('Host', { exact: true })).toHaveCount(0)
    await expect(form.getByLabel('Password', { exact: true })).toHaveCount(0)
    await expect(form.getByLabel('Transport security')).toHaveCount(0)
    await form.getByLabel('Open mode').selectOption(mode)
    await form.getByRole('button', { name: mode === 'create' ? 'Choose new database file' : 'Browse database files' }).click()
    await expect(form.getByLabel('Database file', { exact: true })).toHaveValue(path)
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.locator('.statusbar .dialect-label')).toHaveText('SQLite')
  }
  try {
    let page = await launch()
    await connect(page, 'create')
    await run(page, "CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, balance TEXT); INSERT INTO customers VALUES(1,'Ada Lovelace','1250.50000000');")
    await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
    await appendTableSelect(page, 'customers')
    await expect(page.locator('.monaco-editor')).toContainText('"main"."customers"')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('sqlite-workbench.png') })
    const csv = join(directory, 'export.csv')
    await application!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csv)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(csv, 'utf8')).toContain('"1250.50000000"')
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await run(page, "UPDATE customers SET name='uncommitted'")
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run(page, "SELECT name,9223372036854775807 AS exact FROM customers")
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.profile?.sqliteMode)).toBe('read-write')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await connect(page, 'read-only')
    await enter(page, 'DELETE FROM customers')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Failed')
    await expect(page.locator('.error-banner')).toContainText('readonly')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await connect(page, 'read-write')
    const longQuery = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;'
    await enter(page, longQuery)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Disconnected')
    await expect(page.locator('.error-banner')).toContainText('Reconnect explicitly')
    await connect(page, 'read-write')
    await run(page, "BEGIN IMMEDIATE; UPDATE customers SET name='crashed'")
    await enter(page, longQuery)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.sql)).toContain('1000000000')
    const recovered = application!.waitForEvent('window')
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await recovered
    await expect(page.locator('.monaco-editor')).toContainText('1000000000')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await connect(page, 'read-write')
    // A surviving orphan would keep BEGIN IMMEDIATE's write lock and fail this.
    await run(page, 'BEGIN IMMEDIATE; UPDATE customers SET balance=balance; COMMIT; SELECT name FROM customers')
    await page.getByRole('button', { name: 'Result 4', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.profile?.filePath)).toBe(path)
    await application!.close(); application = undefined
    page = await launch()
    await connect(page, 'read-write')
    await run(page, 'SELECT name FROM customers')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
  } finally { await application?.close(); rmSync(directory, { recursive: true, force: true }) }
})
