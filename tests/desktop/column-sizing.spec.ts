import { _electron as electron, test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function drag(app: ElectronApplication, page: Page, handle: Locator, distance: number, cancel?: 'escape' | 'blur') {
  await handle.scrollIntoViewIfNeeded()
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  const box = (await handle.boundingBox())!
  // Keep the native gesture together: host mouse movement must not release capture.
  await app.evaluate(({ BrowserWindow }, { x, y, distance, cancel }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'mouseMove', x, y })
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
    for (let i = 1; i <= 8; i++) contents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftbuttondown'], x: x + Math.round(distance * i / 8), y })
    if (cancel === 'escape') {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    }
    if (!cancel || cancel === 'escape') contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: x + distance, y })
  }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), distance, cancel })
  if (cancel === 'blur') {
    await expect.poll(() => page.evaluate(() => document.body.dataset.columnResizing)).toBe('true')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 20, y: 20 }))
  }
  await expect.poll(() => page.evaluate(() => document.body.dataset.columnResizing)).toBeUndefined()
}
async function size(header: Locator) { return Math.round((await header.boundingBox())!.width) }

test('column sizing duckdb: pointer, keyboard, sampled fit, pinned columns and independent editable state', async ({}, testInfo) => {
  test.setTimeout(120000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-column-sizing-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb'); await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    const source = "select 'short' as duplicate, repeat('W',70) as duplicate, NULL as missing from range(40);"
    await run(page, source)
    const results = page.getByRole('table', { name: 'Query results', exact: true })
    const first = results.getByRole('separator', { name: 'Resize column 1 duplicate', exact: true })
    const second = results.getByRole('separator', { name: 'Resize column 2 duplicate', exact: true })
    const header = results.getByRole('columnheader').nth(1)
    const history = await page.evaluate(() => window.dbCommander.history())
    await expect(first).toHaveAttribute('aria-valuenow', '210')
    await drag(app, page, first, 80); await expect.poll(() => size(header)).toBe(290)
    await drag(app, page, first, 50, 'escape'); await expect.poll(() => size(header)).toBe(290)
    await drag(app, page, first, 40, 'blur'); await expect.poll(() => size(header)).toBe(290)
    await first.focus(); await page.keyboard.press('ArrowRight'); await expect(first).toHaveAttribute('aria-valuenow', '300')
    await page.keyboard.press('Shift+ArrowLeft'); await expect(first).toHaveAttribute('aria-valuenow', '250')
    await page.keyboard.press('Home'); await expect(first).toHaveAttribute('aria-valuenow', '90')
    await page.keyboard.press('End'); await expect(first).toHaveAttribute('aria-valuenow', '800')
    await page.keyboard.press('Delete'); await expect(first).toHaveAttribute('aria-valuenow', '210')
    await first.dblclick(); await expect.poll(() => size(header)).toBeLessThan(210)
    await second.focus(); await page.keyboard.press('Enter'); await expect.poll(async () => Number(await second.getAttribute('aria-valuenow'))).toBeGreaterThan(210)
    const fittedSecond = Number(await second.getAttribute('aria-valuenow')); expect(fittedSecond).toBeGreaterThan(210)
    await page.getByRole('button', { name: 'Columns', exact: true }).click()
    const columns = page.getByRole('dialog', { name: 'Column controls', exact: true })
    await columns.getByLabel('Pin column 2', { exact: true }).check(); await columns.getByLabel('Show column 1 duplicate', { exact: true }).uncheck()
    await columns.getByRole('button', { name: 'Fit visible columns', exact: true }).click(); await columns.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(results).toHaveAttribute('aria-colcount', '3')
    await expect(results.getByRole('columnheader').nth(1)).toContainText('duplicate')
    await drag(app, page, second, 20); await expect(second).toHaveAttribute('aria-valuenow', String(fittedSecond + 20))
    await results.getByRole('separator', { name: 'Resize column 3 missing', exact: true }).focus(); await page.keyboard.press('End')
    await results.evaluate(node => { node.scrollTop = 180; node.scrollLeft = 120 })
    await expect.poll(() => results.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    await expect.poll(() => results.getByRole('columnheader').nth(1).evaluate(node => {
      const r = node.getBoundingClientRect(); return document.elementFromPoint(r.right - 4, r.y + 20)?.getAttribute('role')
    })).toBe('separator')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(source)
    // Display order and widths must never change fetched export columns or values.
    const destination = join(directory, 'fetched.csv')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, destination)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    const exported = readFileSync(destination, 'utf8').split(/\r?\n/)
    expect(exported[0]).toBe('"duplicate","duplicate","missing"')
    expect(exported[1]).toBe(`"short","${'W'.repeat(70)}",`)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await run(page, "select 'other tab' as duplicate;")
    await expect(page.getByRole('separator', { name: 'Resize column 1 duplicate', exact: true })).toHaveAttribute('aria-valuenow', '210')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click(); await expect(second).toHaveAttribute('aria-valuenow', String(fittedSecond + 20))
    await run(page, "create table resize_data(id integer primary key, label varchar); insert into resize_data values(1,'original');")
    await tableAction(page, 'resize_data', 'Edit data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    const draft = 'uncommitted ' + 'W'.repeat(60)
    await page.getByRole('textbox', { name: 'Row 1 label', exact: true }).fill(draft)
    const edited = page.getByRole('separator', { name: 'Resize column 2 label', exact: true })
    await edited.focus(); await page.keyboard.press('Enter'); await expect.poll(async () => Number(await edited.getAttribute('aria-valuenow'))).toBeGreaterThan(210)
    await expect(page.getByRole('textbox', { name: 'Row 1 label', exact: true })).toHaveValue(draft)
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await edited.focus(); await page.keyboard.press('Backspace'); await expect(edited).toHaveAttribute('aria-valuenow', '210')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await tableAction(page, 'resize_data', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(page.getByRole('cell', { name: 'original', exact: true })).toBeVisible()
    await expect(edited).toHaveAttribute('aria-valuenow', '210')
    await page.screenshot({ path: testInfo.outputPath('column-resizing.png') })
    expect(JSON.stringify(await page.evaluate(() => window.dbCommander.loadWorkspace()))).not.toContain(draft)
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
