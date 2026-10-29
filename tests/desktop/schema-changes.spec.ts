import { waitForWorkspaceReady } from './workspace-ready'
import { databaseAction } from './workspace-actions'
import { tableAction, tableNode } from './explorer-actions'
import { verifyMigrationExport } from './migration-export'
import { openSeparateQueryTab } from './separate-query-tab'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'
import { transactionalDdl } from '../../src/shared/schema-changes'

for (const engine of engineSchema.options) test(`schema changes ${engine}: review, alteration, transaction decisions and destructive confirmation`, async ({}, testInfo) => {
  test.setTimeout(240000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-schema-ui-')), env: Record<string,string|undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string,string> })
  const page = await app.firstWindow(), name = `schema_ui_${Date.now()}`, transactional = transactionalDdl(engine), q = (value: string) => quoteIdentifier(value,engine)
  const editor = page.getByRole('dialog', { name: 'Schema changes', exact: true })
  // Oracle reviews and apply-time revalidation share a bounded 45-second catalog
  // inspection. Allow it to finish on hosted runners before asserting the result.
  const metadataTimeout = engine === 'oracle' ? 60000 : 5000
  async function run(sql: string) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function review() { await editor.getByRole('button', { name: 'Review SQL', exact: true }).click(); await expect(editor.getByLabel('Schema SQL preview')).toBeVisible({ timeout: metadataTimeout }) }
  async function approve() {
    await editor.getByLabel('I reviewed this SQL and its target.', { exact: true }).check()
    if (!transactional) {
      await expect(editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true })).toBeDisabled()
      await editor.getByLabel('I understand this DDL commits immediately and cannot be rolled back.', { exact: true }).check()
    }
  }
  async function apply() {
    await editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true }).click()
    await expect(editor.getByRole('status')).toHaveText(transactional ? /Close this dialog, then Commit or Rollback/ : /completed and committed/, { timeout: metadataTimeout })
  }
  async function settle(commit = true) {
    await editor.getByRole('button', { name: 'Close schema changes', exact: true }).click()
    if (transactional) {
      await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
      await page.getByRole('button', { name: commit ? 'Commit' : 'Rollback', exact: true }).click()
      await expect(page.locator('.status-text')).toHaveText('Completed')
    }
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function create() {
    await databaseAction(page, 'Schema changes')
    await editor.getByLabel('New object name').fill(name)
    await review(); await approve(); await apply()
  }
  try {
    await waitForWorkspaceReady(page)
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
    await run(engine === 'oracle' ? 'SELECT 42 AS preserved FROM dual' : 'SELECT 42 AS preserved')
    const buffer = await page.locator('.monaco-editor').innerText(), history = await page.evaluate(() => window.dbCommander.history())
    await databaseAction(page, 'Schema changes')
    await editor.getByLabel('New object name').fill(name+'_draft')
    await editor.getByLabel('Column 1 default kind').selectOption('expression')
    await editor.getByLabel('Column 1 default expression').fill('1 + 2')
    await review()
    await expect(editor.getByLabel('Schema SQL preview')).toHaveValue(transactional ? /^BEGIN/ : /^CREATE TABLE/)
    await expect(editor.getByLabel('Schema SQL preview')).toHaveValue(/DEFAULT \(1 \+ 2\)/)
    await page.screenshot({ path: testInfo.outputPath(`${engine}-schema-expression-review.png`) })
    await expect(editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true })).toBeDisabled()
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length)
    await editor.getByLabel('Column 1 default expression').fill('1); DROP TABLE important; --')
    await expect(editor.getByLabel('Schema SQL preview')).toHaveCount(0)
    await editor.getByRole('button', { name: 'Review SQL', exact: true }).click()
    await expect(editor.getByRole('alert')).toContainText(/unbalanced|statement separators/)
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length)
    await editor.getByLabel('Column 1 default expression').fill('1 + 2')
    await review()
    await editor.getByLabel('New object name').fill(name)
    await expect(editor.getByLabel('Schema SQL preview')).toHaveCount(0)
    await review()
    await expect(editor.getByLabel('Schema SQL preview')).not.toHaveValue(new RegExp(name+'_draft'))
    const preview = await editor.getByLabel('Schema SQL preview').inputValue(), file = join(directory,'review.sql')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
    await editor.getByRole('button', { name: 'Save SQL', exact: true }).click(); await expect(editor.getByRole('status')).toHaveText('SQL saved.'); expect(readFileSync(file,'utf8')).toBe(preview)
    await verifyMigrationExport(app,page,engine,directory,testInfo,'change')
    await page.keyboard.press('Escape'); await expect(editor).not.toBeVisible()
    await expect(tableNode(page, `${name}`)).toHaveCount(0)
    await create()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-schema-review.png`) })
    await expect(editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true })).toBeDisabled()
    await editor.getByRole('button', { name: 'Close schema changes', exact: true }).click()
    await expect.poll(() => page.locator('.monaco-editor').innerText()).toBe(buffer)
    await expect(page.locator('.results-region')).toContainText('42')
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length+1)
    if (transactional) {
      await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
      await expect(tableNode(page, `${name}`)).toHaveCount(0)
      await create(); await settle()
    }
    await page.getByLabel('Filter database objects').fill(name)
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await tableAction(page, `${name}`, 'Alter table')
    await expect(editor.getByRole('button', { name: 'Review SQL', exact: true })).toBeDisabled(); await expect(editor.getByRole('alert')).toContainText('Commit or roll back')
    await editor.getByRole('button', { name: 'Close schema changes', exact: true }).click()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await tableAction(page, `${name}`, 'Alter table')
    await editor.getByLabel('Column 1 name').fill('new_value'); await editor.getByLabel('Column 1 nullable').check()
    if (engine === 'sqlite') {
      await expect(editor.getByText('SQLite cannot add a column with an expression default.', { exact: false })).toBeVisible()
      await editor.getByLabel('Column 1 default kind').selectOption('expression')
      await editor.getByLabel('Column 1 default expression').fill('4 + 5')
      await editor.getByRole('button', { name: 'Review SQL', exact: true }).click()
      await expect(editor.getByRole('alert')).toContainText('SQLite cannot add a column with an expression default')
      await editor.getByLabel('Column 1 default kind').selectOption('none')
    }
    await review(); await expect(editor.getByLabel('Schema SQL preview')).toHaveValue(/ALTER TABLE/); await approve(); await apply(); await settle()
    await tableAction(page, `${name}`, 'Object details')
    const details = page.getByRole('dialog', { name: 'Object details', exact: true })
    await expect(details.getByRole('table', { name: 'Columns', exact: true })).toContainText('new_value')
    await details.getByRole('button', { name: 'Close object details', exact: true }).click()
    if (engine === 'postgres') {
      await openSeparateQueryTab(page, 'local-test-only')
      await run(`BEGIN; LOCK TABLE public.${q(name)} IN SHARE MODE`)
      await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
      await tableAction(page, `${name}`, 'Alter table')
      await editor.getByLabel('Column 1 name').fill('cancelled_column'); await editor.getByLabel('Column 1 nullable').check()
      await review(); await approve(); await editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true }).click()
      await editor.getByRole('button', { name: 'Cancel schema change', exact: true }).click()
      await expect(editor.getByRole('alert').filter({ hasText: /rolled back|No schema SQL was executed/ })).toBeVisible()
      await editor.getByRole('button', { name: 'Close schema changes', exact: true }).click()
      await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
      await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
      await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    }
    await tableAction(page, `${name}`, 'Alter table')
    await editor.getByLabel('Schema operation').selectOption('drop-table'); await review(); await approve()
    await verifyMigrationExport(app,page,engine,directory,testInfo,'change',true)
    await expect(editor.getByRole('button', { name: 'Apply reviewed SQL', exact: true })).toBeDisabled()
    await editor.getByLabel('I understand this can remove data or database safeguards.', { exact: true }).check()
    await apply(); await settle()
    await expect(tableNode(page, `${name}`)).toHaveCount(0)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory,{ recursive: true, force: true }) }
})
