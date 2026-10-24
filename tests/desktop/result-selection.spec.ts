import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withClipboard } from './clipboard-fixture'
import { tableAction } from './explorer-actions'
import { tableDataAction } from './table-data-actions'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-selection-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow()
  await waitForWorkspaceReady(page)
  return { app, page, directory }
}
async function close(app: ElectronApplication, directory: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Database engine').selectOption('sqlite'); await form.getByLabel('Open mode').selectOption('memory')
  await form.getByLabel('Connection name').fill('Selection database')
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
}
async function run(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
const cell = (page: Page, row: number, column: number) => page.locator(`[data-result-row="${row}"][data-result-column="${column}"]`)
const clipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())

test('result ranges copy through mouse, keyboard and native menus without losing values', async ({}, info) => {
  const { app, page, directory } = await launch()
  try {
    await connect(page)
    await run(page, "SELECT 1 AS id, 'Alpha' AS label, NULL AS note UNION ALL SELECT 2, 'Beta', '' UNION ALL SELECT 3, 'Tab'||char(9)||'quote'||char(10)||'\"value\"', 'tail';")
    await withClipboard(app, async () => {
      await cell(page, 0, 0).click(); await cell(page, 1, 1).click({ modifiers: ['Shift'] })
      await expect(page.locator('[data-selected=true]')).toHaveCount(4)
      await page.keyboard.press(`${modifier}+C`)
      await expect.poll(() => clipboard(app)).toBe('1\tAlpha\r\n2\tBeta')
      // Right-clicking inside the range and restoring focus must preserve it.
      await cell(page, 0, 0).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Copy with headers', exact: true }).click()
      await expect.poll(() => clipboard(app)).toBe('id\tlabel\r\n1\tAlpha\r\n2\tBeta')
      await expect(page.locator('[data-selected=true]')).toHaveCount(4)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy())
      await expect.poll(() => clipboard(app)).toBe('1\tAlpha\r\n2\tBeta')

      await cell(page, 0, 1).click(); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press(`${modifier}+Shift+C`)
      await expect.poll(() => clipboard(app)).toBe('label\tnote\r\nAlpha\tNULL\r\nBeta\t')
      await page.keyboard.press('Escape'); await expect(page.locator('[data-selected=true]')).toHaveCount(1)

      const from = await cell(page, 0, 0).boundingBox(), to = await cell(page, 2, 2).boundingBox()
      await page.mouse.move(from!.x + 20, from!.y + 16); await page.mouse.down()
      await page.mouse.move(to!.x + 20, to!.y + 16, { steps: 8 }); await page.mouse.up()
      await expect(page.locator('[data-selected=true]')).toHaveCount(9)
      await page.getByRole('button', { name: 'Copy', exact: true }).click()
      await expect.poll(() => clipboard(app)).toBe('1\tAlpha\tNULL\r\n2\tBeta\t\r\n3\t"Tab\tquote\n""value"""\ttail')
      writeFileSync(info.outputPath('selected-results.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))

      // Only displayed columns are selected, in displayed order, including pinned columns.
      await page.getByRole('button', { name: 'Columns', exact: true }).click()
      const columns = page.getByRole('dialog', { name: 'Column controls', exact: true })
      await columns.getByLabel('Show column 1 id', { exact: true }).uncheck()
      await columns.getByLabel('Pin column 3', { exact: true }).check()
      await columns.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.locator('[data-selected=true]')).toHaveCount(0)
      await cell(page, 0, 2).click(); await cell(page, 1, 1).click({ modifiers: ['Shift'] })
      await page.keyboard.press(`${modifier}+Shift+C`)
      await expect.poll(() => clipboard(app)).toBe('note\tlabel\r\nNULL\tAlpha\r\n\tBeta')
      await cell(page, 2, 1).dblclick(); await expect(page.getByRole('dialog', { name: 'Value inspector', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')

      await app.evaluate(({ clipboard }) => {
        ;(globalThis as any).__writeText = clipboard.writeText
        clipboard.writeText = async () => { throw new Error('Clipboard unavailable') }
      })
      await page.keyboard.press(`${modifier}+C`)
      await expect(page.locator('.grid-copy-error')).toContainText('Clipboard unavailable')
      await expect.poll(() => clipboard(app)).toBe('note\tlabel\r\nNULL\tAlpha\r\n\tBeta')
      await app.evaluate(({ clipboard }) => { clipboard.writeText = (globalThis as any).__writeText })
      await page.getByRole('button', { name: 'Copy', exact: true }).click()
      await expect.poll(() => clipboard(app)).toBe('Tab\tquote\n"value"')
    })
  } finally { await close(app, directory) }
})

test('selection includes virtual rows, autoscrolls during drag and resets for a new result', async () => {
  const { app, page, directory } = await launch()
  try {
    await connect(page)
    await run(page, "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250) SELECT i, 'row '||i AS label FROM n;")
    await withClipboard(app, async () => {
      await cell(page, 0, 0).click(); await page.keyboard.press(`${modifier}+Shift+End`)
      await expect(page.locator('.grid-selection-count')).toHaveText('500 selected')
      await expect(cell(page, 249, 1)).toBeFocused()
      await page.keyboard.press(`${modifier}+C`)
      await expect.poll(async () => (await clipboard(app)).split('\r\n').length).toBe(250)
      expect((await clipboard(app)).startsWith('1\trow 1\r\n')).toBe(true)
      expect((await clipboard(app)).endsWith('250\trow 250')).toBe(true)
      expect(await page.locator('.grid-row').count()).toBeLessThan(80)
      await page.keyboard.press(`${modifier}+Home`)
      await page.keyboard.press(`${modifier}+A`)
      await expect(page.locator('.grid-selection-count')).toHaveText('500 selected')
      await page.keyboard.press('Escape')
      const from = await cell(page, 0, 0).boundingBox(), table = page.getByRole('table', { name: 'Query results', exact: true }), bounds = await table.boundingBox()
      await page.mouse.move(from!.x + 20, from!.y + 15); await page.mouse.down()
      await page.mouse.move(from!.x + 20, bounds!.y + bounds!.height + 10, { steps: 5 })
      await expect.poll(() => table.evaluate(element => element.scrollTop)).toBeGreaterThan(250)
      await page.mouse.up()
      await expect.poll(async () => Number((await page.locator('.grid-selection-count').innerText()).split(' ')[0])).toBeGreaterThan(8)
      await page.keyboard.press(`${modifier}+C`)
      expect((await clipboard(app)).split('\r\n').length).toBeGreaterThan(8)
      await run(page, "SELECT 'empty' AS label WHERE 0;")
      await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
      await table.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape')
      await expect(page.getByText('Query returned no rows.', { exact: true })).toBeVisible()
    })
  } finally { await close(app, directory) }
})

test('compact browse controls and active saved connection follow tab changes', async ({}, info) => {
  const { app, page, directory } = await launch()
  try {
    await page.evaluate(async () => {
      const workspace = (await window.dbCommander.loadWorkspace())!
      const config = { engine: 'sqlite' as const, host: 'local', port: 1, user: 'local', database: 'sqlite', tls: 'disable' as const, sqliteMode: 'memory' as const }
      await window.dbCommander.saveWorkspace({ version: 2, tabs: workspace.tabs, activeTabId: workspace.activeTabId, profiles: ['Sales', 'Reporting'].map(name => ({ id: crypto.randomUUID(), config: { ...config, name } })) })
    })
    await page.reload()
    const profile = (name: string) => page.getByRole('button', { name: `Open ${name} in new tab`, exact: true })
    await profile('Sales').click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await expect(profile('Sales')).toHaveAttribute('aria-current', 'true')
    await run(page, "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<205) INSERT INTO orders SELECT i,'Customer '||i FROM n;")
    await profile('Reporting').click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await expect(profile('Reporting')).toHaveAttribute('aria-current', 'true')
    await expect(profile('Sales')).not.toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.online-dot')).toHaveCount(2)
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(profile('Sales')).toHaveAttribute('aria-current', 'true')
    await tableAction(page, 'orders', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(profile('Sales')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.table-data .data-toolbar')).toHaveCount(1)
    await expect(page.locator('.table-data .grid-edit-toolbar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await expect(page.locator('.page-range')).toHaveText('Rows 201–205')
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
    await cell(page, 0, 0).click(); await cell(page, 2, 1).click({ modifiers: ['Shift'] })
    await withClipboard(app, async () => {
      await page.keyboard.press(`${modifier}+C`)
      await expect.poll(() => clipboard(app)).toBe('201\tCustomer 201\r\n202\tCustomer 202\r\n203\tCustomer 203')
    })
    for (const [width, height, zoom] of [[1440, 940, 1], [1024, 700, 1], [1440, 940, 2]]) {
      await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, height); window.webContents.setZoomFactor(zoom) }, { width, height, zoom })
      await expect(page.getByRole('button', { name: 'Table actions', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Filters & sort', exact: true })).toBeInViewport()
      await expect.poll(() => page.locator('.data-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      if (zoom === 2) {
        await page.getByRole('button', { name: 'Maximize results', exact: true }).click()
        await expect(cell(page, 0, 0)).toBeInViewport()
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      writeFileSync(info.outputPath(`browse-${width}-${zoom}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
      if (zoom === 2) await page.getByRole('button', { name: 'Restore editor and results', exact: true }).click()
    }
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 940) })
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).not.toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await cell(page, 0, 0).click(); await cell(page, 2, 1).click({ modifiers: ['Shift'] })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    writeFileSync(info.outputPath('browse-light.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    await tableDataAction(page, 'Edit this page')
    await expect(page.getByRole('table', { name: 'Editable table data', exact: true })).toBeVisible()
    await tableDataAction(page, 'Close data')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect(page.locator('.profile-open[aria-current=true]')).toHaveCount(0)
    await expect(page.locator('.online-dot')).toHaveCount(2)
  } finally { await close(app, directory) }
})
