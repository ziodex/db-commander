import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'
import { withClipboard } from './clipboard-fixture'

const key = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-exploration-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await waitForWorkspaceReady(page); await page.bringToFront()
    return { app, page, directory, close: async () => { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } }
  } catch (error) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); throw error }
}
async function connect(page: Page, engine: 'sqlite' | 'duckdb') {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Open mode').selectOption('memory')
  await form.getByLabel('Save connection profile').uncheck(); await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
}
async function enter(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor'), input = editor.locator('textarea.inputarea')
  await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
  await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await expect(editor.locator('.view-lines')).toContainText(sql)
}
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
}
const live = (page: Page) => page.getByRole('region', { name: 'Live result', exact: true })
const pinned = (page: Page) => page.getByRole('region', { name: 'Pinned result', exact: true })
const cell = (pane: Locator, row: number, column: number) => pane.locator(`[data-result-row="${row}"][data-result-column="${column}"]`)
async function copyAs(page: Page, pane: Locator, format: string) {
  await pane.getByRole('button', { name: 'Copy options', exact: true }).click()
  await page.getByRole('menuitem', { name: `Copy as ${format}`, exact: true }).click()
}
async function viewEditor(pane: Locator) { await pane.getByRole('button', { name: /^Filter \/ sort/ }).click() }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) }

for (const engine of ['sqlite', 'duckdb'] as const) {
  test(`result exploration ${engine}: find, exact filters/sort and copy use shown rows without replay`, async ({}, info) => {
    const { app, page, directory, close } = await launch()
    try {
      await connect(page, engine)
      const long = 'retained '.repeat(90) + 'needle beyond the display'
      await run(page, `CREATE TEMP TABLE explored(amount BIGINT, label TEXT, note TEXT); INSERT INTO explored VALUES(9007199254740993,'Alpha',NULL),(9007199254740992,'beta','${long}'),(NULL,'',''),(9007199254740993,'ALPHA','NULL'),(-10,'last','tail'); SELECT amount,label,note FROM explored;`)
      const pane = live(page), history = await page.evaluate(() => window.dbCommander.history())
      await cell(pane, 0, 0).click(); await page.keyboard.press(`${key}+F`)
      const find = pane.getByRole('searchbox', { name: 'Find in loaded rows', exact: true })
      await expect(find).toBeFocused().catch(async error => {
        console.log('Result find focus diagnostics:', await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 500), search: [...document.querySelectorAll('.result-find-fields input')].map(input => ({ html: input.outerHTML, hidden: input.closest('[hidden]')?.outerHTML.slice(0, 500), bounds: input.getBoundingClientRect().toJSON() })) })))
        throw error
      })
      await find.fill('alpha'); await expect(pane.locator('.result-find-count')).toHaveText('2 matching cells')
      await find.press('Enter'); await expect(cell(pane, 0, 1)).toBeFocused(); await expect(cell(pane, 0, 1)).toBeInViewport({ ratio: 1 })
      await pane.getByRole('button', { name: 'Next result match', exact: true }).click(); await expect(cell(pane, 3, 1)).toBeFocused()
      await pane.getByLabel('Match case', { exact: true }).check(); await find.fill('Alpha'); await expect(pane.locator('.result-find-count')).toHaveText('1 matching cell')
      await pane.getByLabel('Match case', { exact: true }).uncheck(); await find.fill('needle'); await find.press('Enter')
      await expect(cell(pane, 1, 2)).toBeFocused(); await expect(cell(pane, 1, 2)).not.toContainText('needle')
      await page.keyboard.press('Enter'); const inspection = page.getByRole('dialog', { name: 'Value inspector', exact: true })
      await expect(inspection.getByRole('textbox')).toHaveValue(long); await page.keyboard.press('Escape')
      await find.fill(''); await viewEditor(pane)
      await pane.getByRole('button', { name: 'Add filter', exact: true }).click(); await pane.getByLabel('Filter 1 operator', { exact: true }).selectOption('gt')
      await pane.getByLabel('Filter 1 value', { exact: true }).fill('not a number'); await expect(pane.getByRole('alert')).toContainText('enter a number')
      await expect(pane.getByRole('button', { name: 'Apply locally', exact: true })).toBeDisabled()
      await settle(page)
      writeFileSync(info.outputPath(`${engine}-filter-error.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
      await pane.getByLabel('Filter 1 value', { exact: true }).fill('9007199254740992')
      await pane.getByRole('button', { name: 'Add filter', exact: true }).click(); await pane.getByLabel('Filter 2 column', { exact: true }).selectOption('1'); await pane.getByLabel('Filter 2 value', { exact: true }).fill('alpha')
      await pane.getByRole('button', { name: 'Add sort key', exact: true }).click(); await pane.getByLabel('Sort 1 direction', { exact: true }).selectOption('desc')
      await pane.getByRole('button', { name: 'Add sort key', exact: true }).click(); await pane.getByLabel('Sort 2 column', { exact: true }).selectOption('1')
      await pane.getByRole('button', { name: 'Apply locally', exact: true }).focus(); await page.keyboard.press('Enter')
      await expect(pane.getByRole('button', { name: /^Filter \/ sort/ })).toBeFocused()
      await page.keyboard.press('Enter'); await pane.getByRole('button', { name: 'Cancel view changes', exact: true }).focus(); await page.keyboard.press('Enter')
      await expect(pane.getByRole('button', { name: /^Filter \/ sort/ })).toBeFocused()
      await expect(pane.locator('.result-footer')).toContainText('2 shown'); await expect(cell(pane, 0, 1)).toHaveText('ALPHA'); await expect(cell(pane, 0, 1)).toHaveAttribute('data-source-row', '3')
      await expect(cell(pane, 1, 1)).toHaveText('Alpha')
      await expect(pane.locator('.result-view-editor')).toHaveCount(0); await pane.locator('.result-footer').scrollIntoViewIfNeeded(); await settle(page)
      writeFileSync(info.outputPath(`${engine}-filtered.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
      await withClipboard(app, async () => {
        await cell(pane, 0, 0).click(); await page.keyboard.press(`${key}+A`)
        await copyAs(page, pane, 'JSON')
        await expect.poll(async () => JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()))).toEqual({ columns: ['amount', 'label', 'note'], rows: [['9007199254740993', 'ALPHA', 'NULL'], ['9007199254740993', 'Alpha', null]] })
        await copyAs(page, pane, 'CSV')
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('"amount","label","note"\r\n"9007199254740993","ALPHA","NULL"\r\n"9007199254740993","Alpha",NULL')
        await copyAs(page, pane, 'Markdown table'); await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('| amount | label | note |')
      })
      const file = join(directory, 'all-cached-rows.csv')
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, file)
      await page.getByRole('button', { name: 'Export preview', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
      expect(readFileSync(file, 'utf8')).toContain('beta'); expect(readFileSync(file, 'utf8')).toContain(long)
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await pane.getByRole('button', { name: 'Reset view', exact: true }).click(); await expect(cell(pane, 0, 1)).toHaveText('Alpha'); await expect(pane.locator('[data-selected=true]')).toHaveCount(0)
      await viewEditor(pane); await pane.getByRole('button', { name: 'Add filter', exact: true }).click(); await pane.getByLabel('Filter 1 column', { exact: true }).selectOption('1'); await pane.getByLabel('Filter 1 value', { exact: true }).fill('absent')
      await pane.getByRole('button', { name: 'Apply locally', exact: true }).click(); await expect(pane.getByText(/No loaded rows match/)).toBeVisible(); await expect(pane.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
      await expect(pane.locator('.result-view-editor')).toHaveCount(0); await pane.getByText(/No loaded rows match/).scrollIntoViewIfNeeded(); await settle(page)
      writeFileSync(info.outputPath(`${engine}-empty.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
      await pane.getByRole('button', { name: 'Reset view', exact: true }).click(); await expect(cell(pane, 4, 0)).toHaveText('-10')
    } finally { await close() }
  })

  test(`result exploration ${engine}: pinned snapshots survive reruns, tab close and disconnect`, async () => {
    const { page, close } = await launch()
    try {
      await connect(page, engine); await run(page, "SELECT 'retained before change' AS label; SELECT 'other result' AS label;")
      const before = await page.evaluate(() => window.dbCommander.loadWorkspace()), history = await page.evaluate(() => window.dbCommander.history())
      await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click()
      await pinned(page).getByRole('textbox', { name: 'Snapshot name', exact: true }).fill('Private capture')
      await expect(cell(pinned(page), 0, 0)).toHaveText('retained before change')
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      expect(await page.evaluate(() => window.dbCommander.loadWorkspace())).toEqual(before)
      await run(page, "SELECT 'new live value' AS label;")
      await expect(cell(live(page), 0, 0)).toHaveText('new live value'); await expect(cell(pinned(page), 0, 0)).toHaveText('retained before change')
      await page.getByRole('button', { name: 'New query tab', exact: true }).click()
      await page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: 'Close query tab', exact: true }); await confirmation.getByRole('button', { name: 'Close tab', exact: true }).click(); await expect(confirmation).toHaveCount(0)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Disconnected')
      await expect(cell(pinned(page), 0, 0)).toHaveText('retained before change'); await expect(page.getByRole('button', { name: 'Run SQL', exact: false })).toBeDisabled()
      expect(JSON.stringify(await page.evaluate(() => window.dbCommander.loadWorkspace()))).not.toContain('Private capture')
      await page.getByRole('button', { name: 'Remove pinned result 1', exact: true }).click(); await expect(page.getByRole('group', { name: 'Pinned results', exact: true })).toHaveCount(0)
      await expect(page.locator('.result-workspace')).toBeFocused()
    } finally { await close() }
  })

  test(`result exploration ${engine}: split live panes keep independent source, sorting, columns and selection`, async () => {
    const { app, page, close } = await launch()
    try {
      await connect(page, engine)
      const first = engine === 'sqlite' ? "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250) SELECT i AS id,'Left '||i AS label FROM n" : "SELECT i AS id,'Left '||i AS label FROM range(1,251) t(i)"
      const second = engine === 'sqlite' ? "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250) SELECT i+1000 AS id,'Right '||i AS label FROM n" : "SELECT i+1000 AS id,'Right '||i AS label FROM range(1,251) t(i)"
      await run(page, `${first}; ${second};`)
      await live(page).getByRole('button', { name: 'Split results', exact: true }).click()
      const comparison = page.getByRole('region', { name: 'Comparison result', exact: true })
      await expect(cell(live(page), 0, 0)).toHaveText('1'); await expect(cell(comparison, 0, 0)).toHaveText('1001')
      await viewEditor(comparison); await comparison.getByRole('button', { name: 'Add sort key', exact: true }).click(); await comparison.getByLabel('Sort 1 direction', { exact: true }).selectOption('desc')
      await comparison.getByLabel('Sort 1 values as', { exact: true }).selectOption('number'); await comparison.getByRole('button', { name: 'Apply locally', exact: true }).click()
      await expect(cell(comparison, 0, 0)).toHaveText('1250'); await expect(cell(live(page), 0, 0)).toHaveText('1')
      await live(page).getByRole('button', { name: 'Columns', exact: true }).click(); const columns = page.getByRole('dialog', { name: 'Column controls', exact: true })
      await columns.getByLabel('Show column 2 label', { exact: true }).uncheck(); await columns.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(live(page).getByRole('columnheader')).toHaveCount(2); await expect(comparison.getByRole('columnheader')).toHaveCount(3)
      await withClipboard(app, async () => {
        await cell(comparison, 0, 0).click(); await page.keyboard.press(`${key}+A`); await copyAs(page, comparison, 'JSON')
        await expect.poll(async () => JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())).rows.length).toBe(250)
        const data = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())); expect(data.rows[0]).toEqual(['1250', 'Right 250']); expect(data.rows.at(-1)).toEqual(['1001', 'Right 1'])
        expect(await live(page).locator('[data-selected=true]').count()).toBe(0)
      })
      expect(await comparison.locator('.grid-row').count()).toBeLessThan(80)
      await comparison.getByRole('button', { name: 'Pin comparison snapshot', exact: true }).click()
      await expect(cell(pinned(page), 0, 0)).toHaveText('1250')
      await run(page, 'SELECT 999 AS only_new_result;'); await expect(cell(live(page), 0, 0)).toHaveText('999'); await expect(cell(pinned(page), 0, 0)).toHaveText('1250')
    } finally { await close() }
  })

  test(`result exploration ${engine}: partial snapshots preserve loaded values through native Stop`, async () => {
    const { page, close } = await launch()
    try {
      await connect(page, engine)
      const long = engine === 'sqlite' ? 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000000000) SELECT sum(i) FROM n' : 'SELECT sum(sin(i)) FROM range(1000000000000) t(i)'
      await enter(page, `SELECT 73 AS retained; ${long};`); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(cell(live(page), 0, 0)).toHaveText('73')
      await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click(); await expect(pinned(page).locator('.result-footer')).toContainText('Partial capture')
      await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText(engine === 'sqlite' ? 'Disconnected' : 'Cancelled')
      await expect(cell(pinned(page), 0, 0)).toHaveText('73'); await expect(pinned(page).locator('.result-footer')).toContainText('Partial capture')
    } finally { await close() }
  })

  test(`result exploration ${engine}: failed execution warning survives cached export before pinning`, async () => {
    const { app, page, directory, close } = await launch()
    try {
      await connect(page, engine); await enter(page, 'SELECT 73 AS retained; SELECT * FROM missing_w3_table;')
      await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Failed')
      await expect(live(page).locator('.result-footer')).toContainText('Partial capture')
      const file = join(directory, 'partial-capture.csv')
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, file)
      await page.getByRole('button', { name: 'Export preview', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
      expect(readFileSync(file, 'utf8')).toContain('73'); await expect(live(page).locator('.result-footer')).toContainText('Partial capture')
      await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click()
      await expect(cell(pinned(page), 0, 0)).toHaveText('73'); await expect(pinned(page).locator('.result-footer')).toContainText('Partial capture')
    } finally { await close() }
  })

  test(`result exploration ${engine}: limited previews never search or filter unfetched rows`, async () => {
    const { page, close } = await launch()
    try {
      await connect(page, engine)
      const sql = engine === 'sqlite' ? 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1205) SELECT i AS id FROM n' : 'SELECT i AS id FROM range(1,1206) t(i)'
      await run(page, sql); await expect(live(page).locator('.result-footer')).toContainText('1,000 rows fetched'); await expect(live(page).locator('.result-footer')).toContainText('Preview limit reached')
      const history = await page.evaluate(() => window.dbCommander.history())
      await viewEditor(live(page)); await live(page).getByRole('button', { name: 'Add filter', exact: true }).click(); await live(page).getByLabel('Filter 1 operator', { exact: true }).selectOption('gt')
      await live(page).getByLabel('Filter 1 values as', { exact: true }).selectOption('number'); await live(page).getByLabel('Filter 1 value', { exact: true }).fill('1000')
      await live(page).getByRole('button', { name: 'Apply locally', exact: true }).click(); await expect(live(page).getByText(/No loaded rows match/)).toBeVisible(); await expect(live(page).locator('.result-footer')).toContainText('0 shown')
      await live(page).getByRole('button', { name: 'Reset view', exact: true }).click(); await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click()
      await expect(pinned(page).locator('.result-footer')).toContainText('Preview limit reached'); await pinned(page).getByRole('button', { name: 'Find', exact: true }).click()
      await pinned(page).getByRole('searchbox', { name: 'Find in loaded rows', exact: true }).fill('1205'); await expect(pinned(page).locator('.result-find-count')).toHaveText('0 matching cells')
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    } finally { await close() }
  })
}

test('result exploration snapshots refuse capacity overflow without eviction or SQL replay', async () => {
  const { page, close } = await launch()
  try {
    await connect(page, 'sqlite'); await run(page, 'SELECT 42 AS retained;')
    const history = await page.evaluate(() => window.dbCommander.history())
    for (let index = 0; index < 12; index++) { await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click(); await expect(page.locator('.result-snapshot-chip')).toHaveCount(index + 1) }
    await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click(); await expect(page.locator('.result-snapshot-error')).toContainText('up to 12 pinned results')
    await expect(page.locator('.result-snapshot-chip')).toHaveCount(12); await expect(cell(live(page), 0, 0)).toHaveText('42'); await expect(cell(pinned(page), 0, 0)).toHaveText('42')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await page.getByRole('button', { name: 'Remove pinned result 1', exact: true }).click(); await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click(); await expect(page.locator('.result-snapshot-chip')).toHaveCount(12)
  } finally { await close() }
})

test('result exploration layouts keep pinned and live panes reachable in dark, light and compact zoom', async ({}, info) => {
  const { app, page, close } = await launch()
  try {
    await connect(page, 'sqlite'); await run(page, "SELECT 42 AS customer_id,'Sample customer' AS customer, NULL AS note;")
    for (const [name, width, height, zoom] of [['desktop', 1440, 940, 1], ['compact', 1024, 700, 1], ['compact-125', 1024, 700, 1.25]] as const) {
      const contentWidth = await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(width,height); w.webContents.setZoomFactor(zoom); return w.getContentSize()[0] }, { width,height,zoom })
      await expect.poll(() => page.evaluate(expected => Math.abs(innerWidth - expected) < 2, contentWidth / zoom)).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).scrollIntoViewIfNeeded(); await expect(live(page).getByRole('button', { name: 'Pin result snapshot', exact: true })).toBeInViewport({ ratio: 1 })
      await cell(live(page), 0, 0).scrollIntoViewIfNeeded(); await expect(cell(live(page), 0, 0)).toBeInViewport({ ratio: 1 }); await settle(page)
      writeFileSync(info.outputPath(`${name}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    }
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1);w.setSize(1440,940) })
    await live(page).getByRole('button', { name: 'Pin result snapshot', exact: true }).click(); await pinned(page).getByRole('textbox', { name: 'Snapshot name', exact: true }).fill('Before changes')
    await live(page).getByRole('button', { name: 'Find', exact: true }).click(); await live(page).getByRole('searchbox', { name: 'Find in loaded rows', exact: true }).fill('customer')
    await page.locator('.main-workspace').evaluate(e => { e.scrollTop=e.scrollHeight }); await page.locator('.result-workspace').evaluate(e => { e.scrollTop=0 }); await settle(page)
    writeFileSync(info.outputPath('split-dark.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1024,700); w.webContents.setZoomFactor(1.25) })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await pinned(page).getByRole('textbox', { name: 'Snapshot name', exact: true }).scrollIntoViewIfNeeded(); await expect(pinned(page).getByRole('textbox', { name: 'Snapshot name', exact: true })).toBeInViewport({ ratio: 1 })
    await cell(pinned(page), 0, 0).scrollIntoViewIfNeeded(); await expect(cell(pinned(page), 0, 0)).toBeInViewport({ ratio: 1 }); await settle(page)
    writeFileSync(info.outputPath('split-compact-125.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1); w.setSize(1440,940) })
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click(); const preferences=page.getByRole('dialog', { name: 'Preferences', exact: true });await preferences.getByLabel('Appearance', { exact: true }).selectOption('light');await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme','light'); await page.locator('.main-workspace').evaluate(e => { e.scrollTop=e.scrollHeight }); await page.locator('.result-workspace').evaluate(e => { e.scrollTop=0 }); await settle(page);writeFileSync(info.outputPath('split-light.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
  } finally { await close() }
})
