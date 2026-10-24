import { tableAction, tableNode } from './explorer-actions'
import { openSeparateQueryTab } from './separate-query-tab'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`${engine} staged grid edits, transactions, conflicts and selected SQL`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-grid-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), q = (value: string) => quoteIdentifier(value, engine), name = `grid_ui_${Date.now()}`
  async function enter(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  }
  async function run(sql: string) {
    await enter(sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function edit() {
    await tableAction(page, `${name}`, 'Edit data')
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(page.getByRole('table', { name: 'Editable table data' })).toBeVisible()
  }
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
      await form.getByLabel('User', { exact: true }).fill('dbcommander')
      await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const textType = ['sqlserver', 'azure-sql'].includes(engine) ? 'NVARCHAR' : 'VARCHAR'
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY,${q('name')} ${textType}(60),${q('note')} ${textType}(60)); INSERT INTO ${q(name)} VALUES(1,'Original',NULL); INSERT INTO ${q(name)} VALUES(2,'Delete me',NULL)`)
    if (engine === 'oracle') await run('COMMIT')
    await expect(tableNode(page, `${name}`)).toBeVisible()
    // Conflict detection needs a genuinely separate writer, opened before drafts.
    await openSeparateQueryTab(page, ['sqlite', 'duckdb'].includes(engine) ? undefined : ['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await edit(); await page.getByLabel('Row 1 name', { exact: true }).fill('Rolled back')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.error-banner')).toContainText('staged table edits')
    await page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click(); await expect(page.locator('.error-banner')).toContainText('staged table edits')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Rolled back')
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await edit(); await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Original')
    await page.getByLabel('Row 1 name', { exact: true }).fill("O'Brien Ω")
    await page.getByRole('button', { name: 'Delete row 2', exact: true }).click()
    await page.getByRole('button', { name: 'Insert row', exact: true }).click()
    await page.getByLabel('Row 3 id', { exact: true }).fill('3'); await page.getByLabel('Row 3 name', { exact: true }).fill('Inserted')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Close data', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-staged-grid.png`) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await edit(); await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue("O'Brien Ω")
    await expect(page.getByLabel('Row 2 name', { exact: true })).toHaveValue('Inserted')
    await page.getByLabel('Row 1 name', { exact: true }).fill('Local draft')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await run(`UPDATE ${q(name)} SET ${q('name')}='Other session' WHERE ${q('id')}=1`)
    if (engine === 'oracle') await run('COMMIT')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.error-banner')).toContainText('Concurrency conflict')
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Local draft')
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click(); await page.getByRole('button', { name: 'Reload data', exact: true }).click()
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Other session')
    // Selected execution must not execute the unselected DELETE before it.
    const selected = `SELECT ${q('id')} FROM ${q(name)} ORDER BY ${q('id')}`
    await enter(`DELETE FROM ${q(name)};\n${selected}`)
    for (let i = 0; i < selected.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByRole('cell', { name: '3', exact: true })).toBeVisible()
    await expect(page.locator('[role=cell][title="1"]')).toBeVisible()
    await run(`DROP TABLE ${q(name)}`)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {})
    await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
