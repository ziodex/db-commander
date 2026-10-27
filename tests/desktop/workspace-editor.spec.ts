import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try { const page = await app.firstWindow(); await ready(page); return { app, page } }
  catch (error) { await close(app); throw error }
}
async function close(app?: ElectronApplication) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }
async function ready(page: Page) { await waitForWorkspaceReady(page); await expect(page.locator('.monaco-editor').first()).toBeVisible() }
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').first().click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function tool(page: Page, name: string) { await page.getByRole('button', { name: 'Workspace', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); return page.getByRole('dialog', { name, exact: true }) }
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb'); await form.getByLabel('Open mode').selectOption('memory')
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible(); await expect(page.locator('.status-text')).toHaveText('Connected')
}
async function run(page: Page, sql: string) { await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click() }
const workspace = (page: Page) => page.evaluate(() => window.dbCommander.loadWorkspace())

test('workspace windows isolate sessions, saves, history and recovery while other windows remain open', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-window-desktop-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let primary = launched.page
    await connect(primary); await run(primary, 'create temp table window_data(n integer); begin; insert into window_data values(11); select n from window_data;')
    const primaryData = await workspace(primary)
    const manager = await tool(primary, 'Workspace windows'); await manager.getByLabel('New workspace name').fill('Analysis')
    const created = app.waitForEvent('window'); await manager.getByRole('button', { name: 'Create window' }).click()
    let second = await created; await ready(second)
    expect(await (await app.browserWindow(second)).evaluate(window => window.getTitle())).toBe('Db Commander — Analysis')
    const record = (await second.evaluate(() => window.dbCommander.workspaceWindows())).currentId
    // Menu ownership wins even if the OS focus lookup yields another window.
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const primary = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Db Commander — Primary')!
      const secondary = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Db Commander — Analysis')!
      const focused = BrowserWindow.getFocusedWindow
      try {
        BrowserWindow.getFocusedWindow = () => primary
        const item = Menu.getApplicationMenu()!.getMenuItemById('toggle-sidebar')!
        item.click(item, secondary, {} as any)
      } finally { BrowserWindow.getFocusedWindow = focused }
    })
    await expect(second.locator('.sidebar')).toBeHidden(); await expect(primary.locator('.sidebar')).toBeVisible()
    await second.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
    expect((await workspace(second))?.profiles).toHaveLength(0)
    expect((await workspace(second))?.tabs[0].id).not.toBe(primaryData?.tabs[0].id)
    expect(await second.evaluate(() => window.dbCommander.history())).toHaveLength(0)
    await connect(second); await run(second, 'create temp table window_data(n integer); insert into window_data values(22); select n from window_data;')
    await expect(second.getByRole('cell', { name: '22', exact: true })).toBeVisible()
    await expect(primary.locator('.transaction-badge')).toHaveText('In transaction')
    // Invalid window IDs and real session identities never route across owners.
    await expect(second.evaluate(() => window.dbCommander.openWorkspaceWindow('../../unsafe'))).rejects.toThrow()
    const owned = await primary.evaluate(() => window.dbCommander.connect({ engine: 'duckdb', name: 'Isolation probe', host: 'local', port: 1, user: 'local', database: 'DuckDB', password: '', tls: 'disable', duckdbMode: 'memory' }))
    await expect(second.evaluate(id => window.dbCommander.cloneSession(id), owned.id)).rejects.toThrow()
    await expect(second.evaluate(id => window.dbCommander.schema(id), owned.id)).rejects.toThrow()
    await primary.evaluate(async id => { await window.dbCommander.schema(id); await window.dbCommander.disconnect(id) }, owned.id)
    let settings = await tool(second, 'Preferences'); await settings.getByLabel('Appearance', { exact: true }).selectOption('light'); await settings.getByRole('button', { name: 'Apply settings' }).click()
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'light'); await expect(primary.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect.poll(async () => (await workspace(second))?.editorSettings?.appearance).toBe('light')
    await second.screenshot({ path: testInfo.outputPath('workspace-window-light.png') })
    const secondWindow = await app.browserWindow(second)
    await secondWindow.evaluate(window => window.close()); await expect.poll(() => second.isClosed()).toBe(true)
    await expect(primary.locator('.transaction-badge')).toHaveText('In transaction')
    const reopened = app.waitForEvent('window'); await primary.evaluate(id => window.dbCommander.openWorkspaceWindow(id), record)
    second = await reopened; await ready(second); await expect(second.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    expect((await workspace(second))?.tabs[0].sql).toContain('values(22)')
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'light')
    // Renderer failure is local to its window and cannot end the primary transaction.
    const recovered = app.waitForEvent('window'); const crashTarget = await app.browserWindow(second)
    await crashTarget.evaluate(window => window.webContents.forcefullyCrashRenderer())
    second = await recovered; await ready(second); await expect(second.locator('.error-banner')).toContainText('recovered')
    await expect(primary.locator('.transaction-badge')).toHaveText('In transaction')
    await run(primary, 'select n from window_data;'); await expect(primary.getByRole('cell', { name: '11', exact: true })).toBeVisible()
    // A rejected close keeps the window and its transaction; accepting only closes that owner.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    const firstWindow = await app.browserWindow(primary); await firstWindow.evaluate(window => window.close())
    await run(primary, 'select n from window_data;'); await expect(primary.getByRole('cell', { name: '11', exact: true })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await firstWindow.evaluate(window => window.close()); await expect.poll(() => primary.isClosed()).toBe(true)
    await expect(second.locator('.monaco-editor')).toBeVisible()
    await close(app); launched = await launch(directory); app = launched.app; primary = launched.page
    await expect.poll(() => app!.windows().length).toBe(1)
    expect((await workspace(primary))?.tabs[0].id).toBe(primaryData?.tabs[0].id)
    const info = await primary.evaluate(() => window.dbCommander.workspaceWindows()); expect(info.windows.find(item => item.id === record)?.open).toBe(false)
    await expect(primary.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

test('workspace editor appearance and shortcuts apply live, reject conflicts and preserve SQL undo and sessions', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-appearance-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await connect(page); await run(page, 'create temp table keys(n integer); begin; insert into keys values(7);')
    const source = 'select n from keys;'
    await enter(page, source)
    await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(source)
    let form = await tool(page, 'Preferences')
    await form.getByLabel('Appearance', { exact: true }).selectOption('light')
    await form.getByRole('tab', { name: 'Shortcuts', exact: true }).click(); await form.getByLabel('Run selection or script', { exact: true }).selectOption('F9')
    await form.getByLabel('Run current statement / batch', { exact: true }).selectOption('F9')
    await form.getByRole('button', { name: 'Apply settings' }).click(); await expect(form.getByRole('alert')).toContainText('different shortcut')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await form.getByLabel('Run current statement / batch', { exact: true }).selectOption('F8')
    await form.getByLabel('Format SQL', { exact: true }).selectOption('CtrlCmd+Shift+F')
    await form.getByRole('button', { name: 'Apply settings' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await expect(page.locator('.monaco-editor')).toHaveClass(/(?:^|\s)vs(?:\s|$)/)
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+Shift+F`)
    await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toContain('\n')
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(source)
    const before = (await page.evaluate(() => window.dbCommander.history())).length
    await page.keyboard.press(`${modifier}+Enter`)
    // A following RPC observes any incorrectly retained old execution binding.
    await page.waitForTimeout(300)
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(before)
    await enter(page, 'select missing;\nselect n from keys;')
    await page.keyboard.press('F8'); await expect(page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    await enter(page, 'select n + 1 as n from keys;'); await page.keyboard.press('F9')
    await expect(page.getByRole('cell', { name: '8', exact: true })).toBeVisible()
    form = await tool(page, 'Preferences'); await form.getByLabel('Appearance', { exact: true }).selectOption('system'); await form.getByRole('button', { name: 'Apply settings' }).click()
    // Playwright owns Chromium's media override; exercise the same change event
    // used for OS appearance changes without changing the developer's desktop.
    await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.screenshot({ path: testInfo.outputPath('editor-light.png') })
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await expect.poll(async () => (await workspace(page))?.editorSettings?.shortcuts?.run).toBe('F9')
    // Normal quit must flush the last appearance change even before debounce.
    await app.close(); app = undefined; launched = await launch(directory); app = launched.app; page = launched.page
    form = await tool(page, 'Preferences'); await expect(form.getByLabel('Appearance', { exact: true })).toHaveValue('system'); await expect(form.getByLabel('Run selection or script', { exact: true })).toHaveValue('F9')
    await form.getByRole('button', { name: 'Reset defaults' }).click(); await form.getByRole('button', { name: 'Apply settings' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})
