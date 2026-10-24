import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'

for (const engine of ['sqlite', 'duckdb'] as const) test(`${engine}: tabs share one connection with independent grids and exports`, async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-shared-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow(), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function run(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  const traffic = () => app.evaluate(() => (globalThis as any).connectionTraffic as { method: string; sessionId: string }[])
  const select = (name: string) => page.getByRole('tab', { name, exact: true }).click()
  const saved = () => page.getByRole('button', { name: 'Open Shared data in new tab', exact: true })
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      (globalThis as any).connectionTraffic = []
      for (const method of ['connect', 'cloneSession', 'disconnect', 'run', 'editGrid']) {
        const original = (ipcMain as any)._invokeHandlers.get(`sql:${method}`)
        ipcMain.removeHandler(`sql:${method}`)
        ipcMain.handle(`sql:${method}`, async (event, request) => {
          const response = await original(event, request)
          ;(globalThis as any).connectionTraffic.push({ method, sessionId: method === 'connect' || method === 'cloneSession' ? response.id : method === 'disconnect' ? request : request.sessionId })
          return response
        })
      }
    })
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Connection name').fill('Shared data')
    await form.getByLabel('Open mode').selectOption('create')
    await form.getByLabel('Database file', { exact: true }).fill(join(directory, 'shared.db'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await run("CREATE TABLE orders(id INTEGER PRIMARY KEY, label VARCHAR(30)); CREATE TABLE customers(id INTEGER PRIMARY KEY, label VARCHAR(30)); INSERT INTO orders VALUES(1,'First order'); INSERT INTO customers VALUES(2,'First customer')")
    await tableAction(page, 'orders', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await tableAction(page, 'customers', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await select('orders')
    await expect(page.getByRole('table', { name: 'Table data', exact: true }).getByRole('cell', { name: 'First order', exact: true })).toBeVisible()
    // The first tab's retained snapshot must still support live inspection.
    await page.getByRole('cell', { name: 'First order', exact: true }).dblclick()
    const inspector = page.getByRole('dialog', { name: 'Value inspector', exact: true })
    await inspector.getByRole('button', { name: 'Load live value', exact: true }).click()
    await expect(inspector.getByLabel('Inspected value')).toHaveValue('First order')
    await inspector.getByRole('button', { name: 'Close value inspector' }).click()
    await select('customers')
    await expect(page.getByRole('cell', { name: 'First customer', exact: true })).toBeVisible()
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('shared-connection.png'), screenshot, 'base64')
    await select('orders'); await run("SELECT 'Order result' AS result")
    await select('customers'); await run("SELECT 'Customer result' AS result")
    await select('orders'); await expect(page.getByRole('cell', { name: 'Order result', exact: true })).toBeVisible()
    const exported = join(directory, 'orders.csv')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exported)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(exported, 'utf8')).toContain('Order result')
    expect(readFileSync(exported, 'utf8')).not.toContain('Customer result')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await run('SELECT COUNT(*) AS count FROM orders')
    await saved().click(); await expect(page.getByRole('tab', { name: 'Query 5.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await run('SELECT COUNT(*) AS count FROM customers')
    const calls = await traffic()
    expect(calls.filter(call => call.method === 'connect')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'cloneSession')).toHaveLength(0)
    expect(new Set(calls.map(call => call.sessionId)).size).toBe(1)
    // Closing the original owner must leave every retained view connected.
    await page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click()
    await page.getByRole('dialog', { name: 'Close query tab', exact: true }).getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Untitled.sql', exact: true })).toHaveCount(0)
    expect((await traffic()).filter(call => call.method === 'disconnect')).toHaveLength(0)
    await select('customers'); await expect(page.getByRole('cell', { name: 'Customer result', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await select('orders'); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await saved().click({ button: 'right' })
    await page.getByRole('menu', { name: 'Connection actions for Shared data', exact: true }).getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    await expect(saved().locator('.online-dot')).toHaveCount(0)
    expect((await traffic()).filter(call => call.method === 'disconnect')).toHaveLength(1)
    for (const name of ['orders', 'customers', 'Query 4.sql', 'Query 5.sql']) {
      await select(name); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    }
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
