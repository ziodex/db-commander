import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAX_TABS } from '../../src/shared/contracts'
import { profileAction } from './profile-actions'
import { waitForWorkspaceReady } from './workspace-ready'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(); await waitForWorkspaceReady(page)
  return { app, page }
}
async function close(app?: ElectronApplication) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }
async function run(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
  await expect.poll(async () => {
    const workspace = await page.evaluate(() => window.dbCommander.loadWorkspace())
    return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql
  }).toBe(sql)
}

for (const engine of ['sqlite', 'duckdb'] as const) test(`connection test ${engine}: draft settings, failures and cleanup preserve the active transaction and saved profile`, async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-connection-test-')), file = join(directory, `existing.${engine}`)
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Connection name', { exact: true }).fill('Local reporting')
    await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(file)
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    await run(page, 'CREATE TABLE retained(id INTEGER); BEGIN; INSERT INTO retained VALUES(41); SELECT id FROM retained;')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible()
    const workspace = await page.evaluate(() => window.dbCommander.loadWorkspace()), history = await page.evaluate(() => window.dbCommander.history())
    await profileAction(page, 'Local reporting', 'Edit'); form = page.getByRole('dialog')
    await form.getByLabel('Connection name', { exact: true }).fill('Unsaved reporting draft')
    const testConnection = form.getByRole('button', { name: 'Test connection', exact: true })
    await testConnection.focus(); await page.keyboard.press('Enter')
    await expect(form.getByRole('status')).toHaveText('Connection successful. Test connection closed.')
    await expect.poll(() => testConnection.evaluate(button => document.activeElement === button ? 'Test connection' : document.activeElement?.outerHTML.slice(0, 200))).toBe('Test connection')
    expect(await page.evaluate(() => window.dbCommander.loadWorkspace())).toEqual(workspace)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    const missing = join(directory, `missing.${engine}`)
    await form.getByLabel('Database file').fill(missing)
    await expect(form.getByRole('status')).toHaveCount(0)
    await form.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Connection failed:')
    expect(existsSync(missing)).toBe(false)
    await form.getByLabel('Database file').fill(file)
    // More tests than the session limit would fail if temporary sessions leak.
    for (let attempt = 0; attempt <= MAX_TABS; attempt++) {
      await form.getByRole('button', { name: 'Test connection', exact: true }).click()
      await expect(form.getByRole('status')).toHaveText('Connection successful. Test connection closed.')
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
    for (const name of ['Test connection', 'Cancel', 'Save profile']) await expect(form.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath(`test-connection-${engine}-compact.png`) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
    await page.screenshot({ path: info.outputPath(`test-connection-${engine}.png`) })
    await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(form).toBeHidden()
    expect(await page.evaluate(() => window.dbCommander.loadWorkspace())).toEqual(workspace)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible()
    await run(page, 'SELECT id FROM retained;'); await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('connection test postgres: saved and typed passwords test the draft without replacing the saved credential', async ({}, info) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('postgres'), 'Requires the disposable PostgreSQL fixture.')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-connection-test-postgres-')), password = 'local-test-only'
  let app: ElectronApplication | undefined, profileId: string | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Connection name', { exact: true }).fill('PostgreSQL reporting')
    await form.getByLabel('Host', { exact: true }).fill('localhost'); await form.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_PG_PORT!)
    await form.getByLabel('Database', { exact: true }).fill('dbcommander'); await form.getByLabel('User', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill(password)
    await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'))
    await form.getByLabel('Remember password', { exact: true }).check()
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden({ timeout: 30_000 })
    await run(page, 'BEGIN; SELECT 42 AS retained;')
    const workspace = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!, history = await page.evaluate(() => window.dbCommander.history())
    profileId = workspace.profiles[0].id
    await profileAction(page, 'PostgreSQL reporting', 'Edit'); form = page.getByRole('dialog')
    await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked()
    await form.getByLabel('Connection name', { exact: true }).fill('Unsaved server draft')
    await form.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(form.getByRole('status')).toHaveText('Connection successful. Test connection closed.')
    await form.getByLabel('Password', { exact: true }).fill('incorrect-test-password')
    await form.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Connection failed:')
    await expect(form.getByRole('alert')).not.toContainText('incorrect-test-password')
    await form.getByLabel('Password', { exact: true }).fill('')
    await form.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(form.getByRole('status')).toHaveText('Connection successful. Test connection closed.')
    expect(await page.evaluate(() => window.dbCommander.loadWorkspace())).toEqual(workspace)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await page.screenshot({ path: info.outputPath('test-connection-postgres.png') })
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
  } finally {
    try { if (app && profileId) await (await app.firstWindow()).evaluate(id => window.dbCommander.removeProfilePassword(id), profileId) }
    finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  }
})
