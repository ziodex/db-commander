import { tableDataAction } from './table-data-actions'
import { tableAction } from './explorer-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`browsing ${engine}: server pages, filters, sorting and safe edits across tabs`, async ({}, testInfo) => {
  test.setTimeout(120000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-browse-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), name = `browse_ui_${Date.now()}`, q = (value: string) => quoteIdentifier(value, engine)
  async function run(sql: string) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function loaded(range: string) { await expect(page.locator('.status-text')).toHaveText('Table loaded'); await expect(page.locator('.page-range')).toHaveText(range) }
  async function options() { await page.getByRole('button', { name: /^Filters & sort/ }).click(); return page.getByRole('dialog', { name: 'Table filters and sorting' }) }
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) {
      await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory, 'data.db'))
    } else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const textType = ['sqlserver', 'azure-sql'].includes(engine) ? 'NVARCHAR' : 'VARCHAR'
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY,${q('label')} ${textType}(100),${q('note')} ${textType}(20))`)
    for (let start = 0; start < 205; start += 100) await run(Array.from({ length: Math.min(100, 205 - start) }, (_, index) => {
      const i = start + index
      return `INSERT INTO ${q(name)} VALUES(${i},'${i === 203 ? "100%_[x] O''Brien" : `row ${i}`}',${i % 2 ? "'present'" : 'NULL'})`
    }).join(';'))
    if (engine === 'oracle') await run('COMMIT')
    await tableAction(page, `${name}`, 'Browse data'); await loaded('Rows 1–200')
    await expect(page.getByRole('table', { name: 'Table data', exact: true })).toHaveAttribute('aria-rowcount', '201')
    await page.getByRole('button', { name: 'Next page', exact: true }).click(); await loaded('Rows 201–205')
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled()
    await page.getByLabel('Rows per page', { exact: true }).selectOption('25'); await loaded('Rows 1–25')
    let dialog = await options()
    await dialog.getByRole('button', { name: 'Add sort column', exact: true }).click()
    await dialog.getByLabel('Sort 1 column').selectOption('id'); await dialog.getByLabel('Sort 1 direction').selectOption('desc')
    await dialog.getByRole('button', { name: 'Apply filters and sorting', exact: true }).click(); await loaded('Rows 1–25')
    const firstId = () => page.getByRole('table', { name: 'Table data', exact: true }).getByRole('row').nth(1).getByRole('cell').nth(1)
    await expect(firstId()).toHaveText('204')
    await page.getByRole('button', { name: 'Next page', exact: true }).click(); await loaded('Rows 26–50'); await expect(firstId()).toHaveText('179')
    dialog = await options(); await dialog.getByRole('button', { name: 'Add filter', exact: true }).click()
    await dialog.getByLabel('Filter 1 column').selectOption('label'); await dialog.getByLabel('Filter 1 condition').selectOption('contains'); await dialog.getByLabel('Filter 1 value').fill('%_[x]')
    await page.screenshot({ path: testInfo.outputPath(`${engine}-browse-options.png`) })
    await dialog.getByRole('button', { name: 'Apply filters and sorting', exact: true }).click(); await loaded('Rows 1–1'); await expect(firstId()).toHaveText('203')
    await expect(page.getByRole('cell', { name: "100%_[x] O'Brien", exact: true })).toBeVisible()
    dialog = await options(); await dialog.getByRole('button', { name: 'Clear all', exact: true }).click(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Filters & sort (1/1)', exact: true })).toBeVisible(); await expect(firstId()).toHaveText('203')
    dialog = await options(); await dialog.getByRole('button', { name: 'Clear all', exact: true }).click()
    await dialog.getByRole('button', { name: 'Add filter', exact: true }).click(); await dialog.getByLabel('Filter 1 column').selectOption('id'); await dialog.getByLabel('Filter 1 condition').selectOption('gte'); await dialog.getByLabel('Filter 1 value').fill('200')
    await dialog.getByRole('button', { name: 'Add filter', exact: true }).click(); await dialog.getByLabel('Filter 2 column').selectOption('note'); await dialog.getByLabel('Filter 2 condition').selectOption('is-null')
    await dialog.getByRole('button', { name: 'Apply filters and sorting', exact: true }).click(); await loaded('Rows 1–3'); await expect(firstId()).toHaveText('200')
    // A normal tab reuses the connection. Explicitly reconnect this tab for the concurrency test.
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const reconnect = page.getByRole('dialog')
    if (!['sqlite', 'duckdb'].includes(engine)) await reconnect.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
    await reconnect.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(reconnect).not.toBeVisible()
    await page.getByRole('tab', { name, exact: true }).click(); await expect(firstId()).toHaveText('200'); await expect(page.getByLabel('Rows per page')).toHaveValue('25')
    await tableDataAction(page, 'Edit this page'); await loaded('Rows 1–3')
    await page.getByLabel('Row 1 label', { exact: true }).fill('my draft')
    await expect(page.getByRole('button', { name: /^Filters & sort/ })).toBeDisabled(); await expect(page.getByLabel('Rows per page')).toBeDisabled()
    await page.getByRole('tab', { name: 'Query 3.sql', exact: true }).click(); await run(`UPDATE ${q(name)} SET ${q('label')}='other session' WHERE ${q('id')}=200`)
    if (engine === 'oracle') await run('COMMIT')
    await page.getByRole('tab', { name, exact: true }).click(); await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.error-banner')).toContainText('Concurrency conflict')
    await expect(page.getByLabel('Row 1 label', { exact: true })).toHaveValue('my draft')
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click(); await tableDataAction(page, 'Reload data'); await loaded('Rows 1–3')
    await expect(page.getByLabel('Row 1 label', { exact: true })).toHaveValue('other session')
    await page.getByLabel('Row 1 label', { exact: true }).fill('rollback this')
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('button', { name: /^Filters & sort/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await tableDataAction(page, 'Reload data'); await loaded('Rows 1–3')
    await expect(page.getByLabel('Row 1 label', { exact: true })).toHaveValue('other session')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
    await expect(page.getByRole('button', { name: /^Filters & sort/ })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-paged-edits.png`) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
    await run(`CREATE VIEW ${q(name + '_view')} AS SELECT ${q('id')},${q('label')} FROM ${q(name)}`)
    await tableAction(page, `${name + '_view'}`, 'Browse data'); await loaded('Rows 1–200')
    await expect(page.locator('.browse-notice')).toContainText('No sortable primary key')
    await tableDataAction(page, 'Edit this page'); await expect(page.locator('.error-banner')).toContainText('base table')
    // Failed edit eligibility preserves the previous browse result and permits reload.
    await expect(page.getByRole('table', { name: 'Table data', exact: true })).toBeVisible()
    await tableDataAction(page, 'Reload data'); await loaded('Rows 1–200')
    await run(`DROP VIEW ${q(name + '_view')}`); await run(`DROP TABLE ${q(name)}`)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
