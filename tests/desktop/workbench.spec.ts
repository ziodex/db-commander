import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('PostgreSQL desktop workflow, secure bridge, export and crash recovery', async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('postgres'), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-desktop-'))
  const environment: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete environment.ELECTRON_RUN_AS_NODE
  let application: ElectronApplication | undefined
  async function launch() {
    application = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
      env: environment as Record<string, string>
    })
    if (process.env.SQLCOMMANDER_TEST_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const page = await application.firstWindow()
    await waitForWorkspaceReady(page)
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    return page
  }
  async function enterSql(page: Page, sql: string) {
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(sql)
  }
  async function run(page: Page, sql: string) {
    await enterSql(page, sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
  }
  try {
    let page = await launch()
    const globals = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process }))
    expect(globals).toEqual({ require: 'undefined', process: 'undefined' })
    const preferences = await application!.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences())
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Connect to PostgreSQL' })
    await form.getByLabel('Connection name').fill('Docker PostgreSQL')
    await form.getByLabel('Host', { exact: true }).fill('localhost')
    await form.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_PG_PORT!)
    await form.getByLabel('Database', { exact: true }).fill('dbcommander')
    await form.getByLabel('User', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill('local-test-only')
    await form.getByText('Custom CA certificate', { exact: true }).click()
    await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.getByText('TLS verified', { exact: true })).toBeVisible()
    await expect(page.locator('.schema-list').getByRole('button', { name: 'customers public' })).toBeVisible()
    await run(page, 'SELECT id, name, email, balance FROM public.customers ORDER BY id;')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1250.50000000', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('workbench.png') })
    const csvPath = join(directory, 'export.csv')
    await application!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csvPath)
    await page.getByRole('button', { name: 'Export preview', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(csvPath, 'utf8')).toContain('"Ada Lovelace"')
    await run(page, 'CREATE TEMP TABLE desktop_work(value integer); INSERT INTO desktop_work VALUES(1);')
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await run(page, 'UPDATE desktop_work SET value=2; SELECT value FROM desktop_work;')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run(page, 'SELECT value FROM desktop_work;')
    await expect(page.getByRole('table', { name: 'Query results' }).getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText('1')
    await enterSql(page, 'SELECT pg_sleep(30);')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await run(page, 'SELECT generate_series(1, 10000000) AS n;')
    await expect(page.getByText(/Preview limit reached/)).toBeVisible()
    await page.getByRole('button', { name: 'Query history', exact: true }).click()
    await expect(page.locator('.history-list button').first()).toContainText('generate_series')
    await enterSql(page, "-- recover this scratch buffer\nSELECT 'still here';")
    await expect.poll(async () => await page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.sql)).toContain('recover this scratch buffer')
    // Force a renderer crash. The main process replaces it and ends its sessions.
    const recoveredWindow = application!.waitForEvent('window')
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await recoveredWindow
    await expect(page.locator('.monaco-editor')).toContainText('recover this scratch buffer')
    await expect(page.locator('.status-text')).toHaveText('Ready')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await application!.close(); application = undefined
    // Confirm workspace durability across an application restart too.
    page = await launch()
    await expect(page.locator('.monaco-editor')).toContainText('recover this scratch buffer')
    expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from('local-test-only'))).toBe(false)
    await application!.close(); application = undefined
  } finally { if (application) await application.close(); rmSync(directory, { recursive: true, force: true }) }
})
