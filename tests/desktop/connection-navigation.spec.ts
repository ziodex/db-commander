import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE } from '../../src/shared/contracts'
import { WorkspaceStore } from '../../src/storage/store'
import { waitForWorkspaceReady } from './workspace-ready'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(); await waitForWorkspaceReady(page)
  await app.evaluate(({ ipcMain }) => {
    ;(globalThis as any).w1Traffic = []
    for (const method of ['connect', 'cloneSession', 'disconnect']) {
      const original = (ipcMain as any)._invokeHandlers.get(`sql:${method}`)
      ipcMain.removeHandler(`sql:${method}`)
      ipcMain.handle(`sql:${method}`, async (event, request) => {
        const response = await original(event, request)
        ;(globalThis as any).w1Traffic.push({ method, id: method === 'disconnect' ? request : response.id })
        return response
      })
    }
  })
  return { app, page }
}
const traffic = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).w1Traffic as { method: string; id: string }[])
async function run(page: Page, sql: string, status = 'Completed') {
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText(status)
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function closeTab(page: Page, title: string) {
  await page.getByRole('button', { name: `Close ${title}`, exact: true }).click()
  await page.getByRole('dialog', { name: 'Close query tab', exact: true }).getByRole('button', { name: 'Close tab', exact: true }).click()
}

for (const engine of ['sqlite', 'duckdb'] as const) test(`connection navigation ${engine}: shared and independent connections preserve temporary objects, transactions and ownership`, async ({}, info) => {
  test.setTimeout(120000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-navigation-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Connection name', { exact: true }).fill('Daily work')
    await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file', { exact: true }).fill(join(directory, 'daily.db'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    await run(page, 'CREATE TABLE shared_data(id INTEGER); INSERT INTO shared_data VALUES(10); CREATE TEMP TABLE session_temp(value INTEGER); INSERT INTO session_temp VALUES(20);')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.getByLabel('Query connection ownership')).toContainText('Shared by 2 tabs')
    await run(page, 'SELECT value FROM session_temp'); await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    expect((await traffic(app)).filter(call => call.method === 'connect')).toHaveLength(1)
    await page.getByRole('button', { name: 'Connection tabs', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New independent connection', exact: true }).click()
    await expect(page.getByLabel('Query connection ownership')).toContainText('Connection 2')
    await expect(page.getByLabel('Query connection ownership')).toContainText('Only this tab')
    await run(page, 'SELECT value FROM session_temp', 'Failed')
    await expect(page.getByRole('alert', { name: 'Application error' })).toContainText('session_temp')
    await run(page, 'SELECT id FROM shared_data'); await expect(page.getByRole('cell', { name: '10', exact: true })).toBeVisible()
    expect((await traffic(app)).filter(call => call.method === 'cloneSession')).toHaveLength(1)
    expect(new Set((await traffic(app)).filter(call => call.method !== 'disconnect').map(call => call.id)).size).toBe(2)
    // A saved-profile click shares the active matching physical connection,
    // rather than unexpectedly attaching to the first connection opened.
    await page.getByRole('button', { name: 'Open Daily work in new tab', exact: true }).click()
    await expect(page.getByLabel('Query connection ownership')).toContainText('Connection 2')
    await expect(page.getByLabel('Query connection ownership')).toContainText('Shared by 2 tabs')
    expect((await traffic(app)).filter(call => call.method === 'cloneSession')).toHaveLength(1)
    await closeTab(page, 'Query 4.sql')
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    const commands = page.getByRole('dialog', { name: 'Commands', exact: true })
    await commands.getByLabel('Search commands').fill('Switch Daily work Untitled')
    await commands.getByRole('button', { name: 'Switch to Daily work · Connection 1 · 1. Untitled.sql', exact: true }).click()
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.getByLabel('Transaction status')).toHaveText('In transaction')
    await run(page, 'INSERT INTO shared_data VALUES(11)')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click(); await expect(page.getByLabel('Transaction status')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Close Query 2.sql', exact: true }).click()
    await expect(page.getByRole('alert', { name: 'Application error' })).toContainText('Commit or roll back')
    await expect(page.getByRole('tab')).toHaveCount(3)
    await page.getByRole('tab', { name: 'Query 3.sql', exact: true }).click(); await expect(page.getByLabel('Transaction status')).toHaveText('Autocommit')
    await run(page, 'SELECT COUNT(*) AS count FROM shared_data'); await expect(page.locator('[data-result-column]').filter({ hasText: /^1$/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.getByLabel('Transaction status')).toHaveText('Autocommit')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`w1-${engine}-ownership.png`) })
    await closeTab(page, 'Untitled.sql')
    expect((await traffic(app)).filter(call => call.method === 'disconnect')).toHaveLength(0)
    await run(page, 'SELECT value FROM session_temp'); await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    await closeTab(page, 'Query 2.sql')
    expect((await traffic(app)).filter(call => call.method === 'disconnect')).toHaveLength(1)
    await run(page, 'SELECT id FROM shared_data'); await expect(page.getByRole('cell', { name: '10', exact: true })).toBeVisible()
  } finally { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})

test('connection navigation profiles: search, switch, duplicate and reviewed credential-free files', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-profile-navigation-')), tabId = randomUUID(), profileId = randomUUID()
  const config = { ...DEFAULT_PROFILE, name: 'Operations', folder: 'Team', host: 'example.test' }
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  store.save({ version: 2, activeTabId: tabId, tabs: [{ id: tabId, title: 'Keep.sql', sql: 'SELECT never_execute_this;', profile: DEFAULT_PROFILE }], profiles: [{ id: profileId, config, credential: 'os-store' }] }); store.close()
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    const source = page.getByRole('button', { name: 'Open Operations in new tab', exact: true })
    await page.getByLabel('Search connections').fill('not-found'); await expect(source).toHaveCount(0); await expect(page.getByText('No matching connections.', { exact: true })).toBeVisible()
    await page.getByLabel('Search connections').fill('Team example.test'); await expect(source).toBeVisible()
    await source.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Duplicate connection', exact: true }).click()
    const form = page.getByRole('dialog')
    await expect(form.getByLabel('Connection name', { exact: true })).toHaveValue('Operations copy')
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('')
    await form.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(form).toBeHidden()
    const exported = join(directory, 'connections.json')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exported)
    await source.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Export connection without credentials', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Connections exported without credentials')
    const document = JSON.parse(readFileSync(exported, 'utf8'))
    expect(document.profiles).toHaveLength(1)
    for (const text of ['credential', 'password', 'accessToken', 'sshSecrets', profileId]) expect(JSON.stringify(document)).not.toContain(text)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, exported)
    await page.getByRole('button', { name: 'Saved connection actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Import connections', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Import connections', exact: true })
    await expect(review.getByRole('button', { name: 'Import selected connections', exact: true })).toBeDisabled()
    await review.getByLabel('Duplicate connection names').selectOption('copy')
    await expect(review.getByText('Import as Operations copy 2', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('w1-profile-import.png') })
    await review.getByRole('button', { name: 'Import selected connections', exact: true }).click(); await expect(review).toBeHidden()
    const workspace = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(workspace!.profiles).toHaveLength(3)
    expect(new Set(workspace!.profiles.map(profile => profile.id)).size).toBe(3)
    expect(workspace!.profiles.find(profile => profile.id === profileId)?.credential).toBe('os-store')
    expect(workspace!.profiles.filter(profile => profile.id !== profileId).every(profile => !profile.credential)).toBe(true)
    expect(workspace!.tabs).toHaveLength(1); expect(workspace!.tabs[0].sql).toBe('SELECT never_execute_this;')
    expect(await traffic(app)).toHaveLength(0)
    const invalid = join(directory, 'invalid.json'); writeFileSync(invalid, JSON.stringify({ ...document, profiles: [{ ...config, password: 'do-not-display-this' }] }))
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, invalid)
    await page.getByRole('button', { name: 'Saved connection actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Import connections', exact: true }).click()
    await expect(page.getByRole('alert', { name: 'Application error' })).toContainText('valid Db Commander connections file')
    await expect(page.getByRole('alert', { name: 'Application error' })).not.toContainText('do-not-display-this')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
    await page.getByLabel('Search connections').fill('')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650))
    await page.screenshot({ path: info.outputPath('w1-connections-compact.png') })
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    const preferences = page.getByRole('dialog')
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click(); await expect(preferences).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.screenshot({ path: info.outputPath('w1-connections-light.png') })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, exported)
    await page.getByRole('button', { name: 'Saved connection actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Import connections', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Import connections', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('w1-profile-import-light.png') })
    await page.getByRole('dialog', { name: 'Import connections', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles).toHaveLength(3)
  } finally { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
