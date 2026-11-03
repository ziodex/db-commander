import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'

test('Q1 SQL intelligence keeps diagnostics, definition navigation and reviewed edits separate from execution', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-intelligence-'))
  const env: NodeJS.ProcessEnv = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string>
  })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const buffer = () => page.evaluate(async () => {
    const workspace = await window.dbCommander.loadWorkspace()
    return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql
  })
  const history = () => page.evaluate(async () => (await window.dbCommander.history()).length)
  async function enter(marked: string) {
    const cursor = marked.indexOf('|'), sql = marked.replace('|', '')
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press(modifier + '+A')
    await page.keyboard.insertText(sql)
    await page.keyboard.press('Escape')
    if (cursor >= 0) for (let index = cursor; index < sql.length; index++) await page.keyboard.press('ArrowLeft')
    return sql
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb')
    await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).not.toBeVisible()

    await enter('CREATE TABLE q1_sales (amount INTEGER); CREATE MACRO q1_discount(amount, percent) AS amount * percent;')
    const run = page.getByRole('button', { name: /^Run SQL/ })
    await run.click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(run).toBeEnabled()
    const before = await history()

    await enter('SELECT 1)')
    await expect.poll(buffer).toBe('SELECT 1)')
    await expect(page.locator('.squiggly-warning').first()).toBeVisible()
    await enter('SELECT * FROM q1_sale|s')
    await expect(page.locator('.squiggly-warning')).toHaveCount(0)
    await page.keyboard.press('F12')
    const definition = page.getByRole('dialog', { name: /object detail/i })
    await expect(definition.getByText('q1_sales', { exact: false }).first()).toBeVisible()
    await expect(definition.getByRole('button', { name: 'Close object details', exact: true })).toBeEnabled()
    await expect(definition.getByRole('textbox', { name: 'Object definition', exact: true })).toHaveValue(/CREATE TABLE.*q1_sales/i)
    await page.keyboard.press('Escape')
    await expect(definition).not.toBeVisible()

    await enter('SELECT q1_discount(2, |)')
    await page.keyboard.press(modifier + '+Shift+Space')
    await expect(page.locator('.parameter-hints-widget')).toContainText('q1_discount')
    await expect(page.locator('.parameter-hints-widget')).toContainText('percent')

    const original = await enter('SELECT s|.amount FROM q1_sales s WHERE s.amount > 2')
    await page.keyboard.press('Shift+F12')
    await expect(page.locator('.reference-zone-widget')).toBeVisible()
    await page.keyboard.press('Escape')
    await enter('SELECT s|.amount FROM q1_sales s WHERE s.amount > 2')
    await page.keyboard.press('F2')
    const rename = page.getByRole('dialog', { name: 'Review alias rename' })
    await rename.getByLabel('New alias name').fill('sales')
    await expect(rename.getByRole('button', { name: 'Apply rename' })).toBeDisabled()
    await rename.getByRole('button', { name: 'Preview rename' }).click()
    await expect(rename.getByRole('heading', { name: '3 changes to s' })).toBeFocused()
    await expect(rename.getByRole('row')).toHaveCount(4)
    await expect.poll(buffer).toBe(original)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    writeFileSync(info.outputPath('q1-rename-dark.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    await rename.getByRole('button', { name: 'Apply rename' }).click()
    await expect(rename).not.toBeVisible()
    await expect.poll(buffer).toBe('SELECT "sales".amount FROM q1_sales "sales" WHERE "sales".amount > 2')
    await page.keyboard.press(modifier + '+Z')
    await expect.poll(buffer).toBe(original)

    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).not.toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(512)
    await enter('SELECT s|.amount FROM q1_sales s WHERE s.amount > 2')
    await page.keyboard.press('F2')
    await rename.getByLabel('New alias name').fill('sales')
    await rename.getByRole('button', { name: 'Preview rename' }).click()
    await rename.getByRole('button', { name: 'Apply rename' }).click({ trial: true })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    writeFileSync(info.outputPath('q1-rename-light-200.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(buffer).toBe(original)
    expect(await history()).toBe(before)
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
