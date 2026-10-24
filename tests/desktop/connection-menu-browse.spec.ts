import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'

for (const engine of ['sqlite', 'duckdb'] as const) test(`${engine}: connection menu owns its sessions and browsing opens a named SQL tab`, async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-menu-browse-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow(), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  const profile = (name: string) => page.getByRole('button', { name: `Open ${name} in new tab`, exact: true })
  async function menu(name: string) {
    await profile(name).click({ button: 'right' })
    return page.getByRole('menu', { name: `Connection actions for ${name}`, exact: true })
  }
  async function buffer() {
    return page.evaluate(async () => { const workspace = (await window.dbCommander.loadWorkspace())!; return workspace.tabs.find(tab => tab.id === workspace.activeTabId)!.sql })
  }
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.evaluate(async ({ engine, directory }) => {
      const workspace = (await window.dbCommander.loadWorkspace())!
      const config = { engine, name: '', host: 'local', port: 1, user: 'local', database: engine, tls: 'disable' as const, ...(engine === 'sqlite' ? { sqliteMode: 'create' as const } : { duckdbMode: 'create' as const }) }
      await window.dbCommander.saveWorkspace({ version: 2, tabs: workspace.tabs, activeTabId: workspace.activeTabId, profiles: ['Primary data', 'Other data'].map((name, index) => ({ id: crypto.randomUUID(), config: { ...config, name, filePath: `${directory}/${index}.db` } })) })
    }, { engine, directory })
    await page.reload(); await expect(profile('Primary data')).toBeVisible()
    let actions = await menu('Primary data')
    await expect(actions.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeDisabled()
    await actions.getByRole('menuitem', { name: 'Connect', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Connected')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const [red, green, blue] = await profile('Primary data').locator('.online-dot').evaluate(element => getComputedStyle(element).backgroundColor.match(/\d+/g)!.map(Number))
    expect(green).toBeGreaterThan(red); expect(green).toBeGreaterThan(blue)
    actions = await menu('Primary data')
    await expect(actions.getByRole('menuitem', { name: 'Connect', exact: true })).toBeDisabled()
    await expect(actions.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeEnabled()
    const menuScreenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('connected-menu.png'), menuScreenshot, 'base64')
    await page.keyboard.press('Escape')

    const setup = 'CREATE TABLE "orders report" (id INTEGER PRIMARY KEY, name VARCHAR(40)); INSERT INTO "orders report" VALUES (42, \'Sample order\');'
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(setup); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    // Hold the first browse reply so tab ownership is exercised during loading.
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('sql:editGrid')
      ipcMain.removeHandler('sql:editGrid')
      ipcMain.handle('sql:editGrid', async (event, request) => {
        const response = await original(event, request)
        if (request.action === 'browse') {
          ipcMain.removeHandler('sql:editGrid'); ipcMain.handle('sql:editGrid', original)
          await new Promise<void>(resolve => { (globalThis as any).releaseBrowse = resolve })
        }
        return response
      })
    })
    await tableAction(page, 'orders report', 'Browse data')
    await expect(page.getByRole('tab', { name: 'orders report', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).releaseBrowse)).toBe('function')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await app.evaluate(() => (globalThis as any).releaseBrowse())
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs.find(tab => tab.title === 'orders report')?.sql ?? '').toMatch(/^SELECT /)
    await expect(page.getByRole('tab', { name: 'Query 2.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(buffer).toBe(setup)
    await page.getByRole('tab', { name: 'orders report', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(page.getByRole('table', { name: 'Table data', exact: true }).getByRole('cell', { name: 'Sample order', exact: true })).toBeVisible()
    await expect.poll(buffer).toContain('LIMIT 201 OFFSET 0;')
    const generated = await buffer()
    expect(generated.startsWith('SELECT ')).toBe(true)
    expect(generated).not.toContain('CREATE TABLE')
    expect(generated).toContain('"main"."orders report"')
    expect(generated).toContain('"id" ASC LIMIT')
    const browseScreenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('browse-sql.png'), browseScreenshot, 'base64')
    const workspace = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    expect(workspace.tabs).toHaveLength(3)
    expect(workspace.tabs.find(tab => tab.title === 'Query 2.sql')!.sql).toBe(setup)
    // A browse tab keeps its SQL and results when the source detaches from the shared session.
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect.poll(buffer).toBe(setup)
    await expect(page.getByRole('table', { name: 'Table data', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('tab', { name: 'orders report', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Table data', exact: true })).toBeVisible()
    await expect.poll(buffer).toBe(generated)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    expect((await page.evaluate(() => window.dbCommander.history())).some(entry => entry.sql.trim() === generated.trim())).toBe(true)

    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    actions = await menu('Other data'); await actions.getByRole('menuitem', { name: 'Connect', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    actions = await menu('Primary data')
    await expect(actions.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeDisabled()
    await expect(actions.getByRole('menuitem', { name: 'Disconnect', exact: true })).toHaveAttribute('title', /Commit or roll back/)
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'orders report', exact: true }).click()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await page.getByRole('tab', { name: 'Query 5.sql', exact: true }).click()
    const beforeDisconnect = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    actions = await menu('Primary data'); await actions.getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    await expect(profile('Primary data').locator('.online-dot')).toHaveCount(0)
    await expect(profile('Other data').locator('.online-dot')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs).toEqual(beforeDisconnect.tabs)
    for (const name of ['Query 2.sql', 'orders report', 'Query 4.sql']) {
      await page.getByRole('tab', { name, exact: true }).click()
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    }
    actions = await menu('Primary data'); await actions.getByRole('menuitem', { name: 'Connect', exact: true }).click()
    await expect(profile('Primary data').locator('.online-dot')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Query 6.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

for (const engine of ['sqlite', 'duckdb'] as const) test(`${engine}: named browse tabs retain a private memory database`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-memory-browse-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow(), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function run(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const setup = "CREATE TABLE orders(id INTEGER PRIMARY KEY, label VARCHAR(40)); INSERT INTO orders VALUES (42,'Memory row'); SELECT label FROM orders;"
    await run(setup)
    await tableAction(page, 'orders', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(page.getByRole('tab', { name: 'orders', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table', { name: 'Table data', exact: true }).getByRole('cell', { name: 'Memory row', exact: true })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs.find(tab => tab.title === 'orders')?.sql ?? '').toMatch(/^SELECT /)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs[0].sql).toBe(setup)
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await page.getByRole('tab', { name: 'orders', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: engine === 'sqlite' ? 'text:Memory row' : 'Memory row', exact: true })).toBeVisible()
    // A second browse view keeps the private database alive after its source closes.
    await tableAction(page, 'orders', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('button', { name: 'Close orders', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'orders', exact: true })).toHaveCount(1)
    await page.getByRole('tab', { name: 'orders', exact: true }).click()
    await run('SELECT label FROM orders')
    await expect(page.getByRole('cell', { name: 'Memory row', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
