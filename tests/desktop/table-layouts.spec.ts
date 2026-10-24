import { tableDataAction } from './table-data-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'

for (const engine of ['sqlite', 'duckdb'] as const) test(`saved table layouts ${engine}: restart, independent tabs, edits and schema changes`, async ({}, testInfo) => {
  test.setTimeout(180000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-table-layouts-')), file = join(directory, 'layouts.db')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined, page: Page
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const window = await app.firstWindow(); await expect(window.getByText('Saved locally', { exact: true })).toBeVisible()
    return window
  }
  async function connect(mode: 'create' | 'read-write' | 'memory') {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Open mode').selectOption(mode)
    if (mode !== 'memory') await form.getByLabel('Database file', { exact: true }).fill(file)
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function run(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function browse() {
    await tableAction(page, 'saved_columns', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
  }
  const columns = () => page.getByRole('dialog', { name: 'Column controls', exact: true })
  const width = () => page.getByRole('separator', { name: 'Resize column 2 label', exact: true })
  async function openColumns() { await page.getByRole('button', { name: 'Columns', exact: true }).click(); await expect(columns()).toBeVisible() }
  async function setWidth(value: number) { await columns().getByLabel('Width column 2', { exact: true }).fill(String(value)); await columns().getByLabel('Width column 2', { exact: true }).press('Tab') }
  async function save() {
    await columns().getByRole('button', { name: /^(Save table layout|Update saved layout)$/ }).click()
    await expect(columns().getByText('Table layout saved.', { exact: true })).toBeVisible()
  }
  async function done() { await columns().getByRole('button', { name: 'Done', exact: true }).click() }
  try {
    page = await launch(); await connect('create')
    await run("CREATE TABLE saved_columns(id INTEGER PRIMARY KEY, label VARCHAR(80), payload VARCHAR(80)); INSERT INTO saved_columns VALUES(1,'original','private row contents')")
    await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
    await browse(); await openColumns()
    await columns().getByLabel('Show column 3 payload', { exact: true }).uncheck()
    await columns().getByLabel('Pin column 2', { exact: true }).check()
    await columns().getByRole('button', { name: 'Move column 2 left', exact: true }).click()
    await setWidth(330); await save(); await done()
    await expect(width()).toHaveAttribute('aria-valuenow', '330')
    const stored = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tableLayouts!
    expect(stored).toHaveLength(1)
    expect(stored[0].layout).toEqual({ order: [1, 0, 2], hidden: [2], pinned: [1], widths: { 1: 330 } })
    expect(JSON.stringify(stored)).not.toContain('private row contents')
    // Unsaved display changes remain tab-local. Another tab gets the saved snapshot.
    await openColumns(); await setWidth(410); await done()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await browse(); await expect(width()).toHaveAttribute('aria-valuenow', '330')
    await openColumns(); await setWidth(360); await save(); await done()
    await page.getByRole('tab', { name: 'saved_columns', exact: true }).first().click()
    await expect(width()).toHaveAttribute('aria-valuenow', '410')
    await tableDataAction(page, 'Edit this page')
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('textbox', { name: 'Row 1 label', exact: true }).fill('unapplied draft')
    await openColumns(); await save(); await done()
    await expect(page.getByRole('textbox', { name: 'Row 1 label', exact: true })).toHaveValue('unapplied draft')
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeEnabled()
    expect(JSON.stringify((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tableLayouts)).not.toContain('unapplied draft')
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-saved-columns.png`) })
    await app!.close(); app = undefined; page = await launch()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await connect('read-write'); await browse()
    await expect(width()).toHaveAttribute('aria-valuenow', '410')
    await expect(page.getByRole('table', { name: 'Table data', exact: true }).getByRole('columnheader')).toHaveCount(3)
    await expect(page.getByRole('table', { name: 'Table data', exact: true }).getByRole('columnheader').nth(1)).toContainText('label')
    await openColumns()
    await columns().getByRole('button', { name: 'Reset columns', exact: true }).click()
    await expect(columns().getByLabel('Width column 2', { exact: true })).toHaveValue('210')
    await columns().getByRole('button', { name: 'Use saved layout', exact: true }).click()
    await expect(columns().getByLabel('Width column 2', { exact: true })).toHaveValue('410'); await done()
    await tableDataAction(page, 'Close data')
    await run('ALTER TABLE saved_columns ADD COLUMN extra INTEGER')
    await browse(); await expect(width()).toHaveAttribute('aria-valuenow', '210')
    await openColumns()
    await expect(columns()).toContainText('saved columns no longer match')
    await expect(columns().getByRole('button', { name: 'Use saved layout', exact: true })).toBeDisabled()
    await expect(columns().getByLabel('Show column 3 payload', { exact: true })).toBeChecked()
    await setWidth(440); await save()
    await columns().getByRole('button', { name: 'Remove saved layout', exact: true }).click()
    await expect(columns()).toContainText('Saved layout removed.')
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tableLayouts).toEqual([])
    await done(); await expect(width()).toHaveAttribute('aria-valuenow', '440')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await browse(); await expect(width()).toHaveAttribute('aria-valuenow', '210')
    await tableDataAction(page, 'Close data')
    await run('SELECT label,payload FROM saved_columns')
    await expect(page.getByRole('cell', { name: 'original', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'private row contents', exact: true })).toBeVisible()
    await openColumns(); await expect(columns().getByRole('button', { name: 'Save table layout', exact: true })).toHaveCount(0); await done()
    // A memory connection must not inherit a preference for a new, unrelated database.
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Disconnected')
    await connect('memory'); await run('CREATE TABLE saved_columns(id INTEGER PRIMARY KEY, label VARCHAR(80))')
    await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
    await browse(); await openColumns()
    await expect(columns().getByRole('button', { name: 'Save table layout', exact: true })).toBeDisabled()
    await expect(columns()).toContainText('In-memory and attached file databases are excluded.'); await done()
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
