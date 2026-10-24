import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'
import { tableNode } from './explorer-actions'

for (const engine of engineSchema.options) test(`data comparison ${engine}: bounded keys, review, filters and preserved tabs`, async ({}, testInfo) => {
  test.setTimeout(180000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-data-compare-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string,string> }), page = await app.firstWindow()
  const embedded = ['sqlite', 'duckdb'].includes(engine), prefix = 'dc_ui_' + Date.now(), source = prefix + '_source', target = prefix + '_target'
  const schema = engine === 'postgres' ? 'public' : ['sqlserver', 'azure-sql'].includes(engine) ? 'dbo' : engine === 'oracle' ? 'DBCOMMANDER' : ['mysql', 'mariadb'].includes(engine) ? 'dbcommander' : 'main'
  const q = (name: string) => quoteIdentifier(name, engine), full = (name: string) => `${q(schema)}.${q(name)}`
  async function run(sql: string) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  const dialog = page.getByRole('dialog', { name: 'Compare table data', exact: true })
  async function open() { await tableNode(page, target).click({ button: 'right' }); await page.getByRole('menuitem', { name: `Compare data ${target}`, exact: true }).click(); await expect(dialog).toBeVisible() }
  async function compare() { await dialog.getByRole('button', { name: 'Compare data', exact: true }).click() }
  try {
    await waitForWorkspaceReady(page); await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (embedded) { await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory, 'comparison.db')) }
    else {
      const key = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${key}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const definition = `(${q('id')} INTEGER PRIMARY KEY, ${q('tenant')} VARCHAR(30), ${q('label')} VARCHAR(100), ${q('note')} VARCHAR(30))`
    await run(`CREATE TABLE ${full(source)} ${definition}`)
    for (const value of ["(1,'dup','same',NULL)", "(2,'dup','old',NULL)", "(3,'dup','source',NULL)"]) await run(`INSERT INTO ${full(source)} VALUES ${value}`)
    if (engine === 'oracle') await run('COMMIT'); await run(engine === 'oracle' ? 'SELECT 42 FROM dual' : 'SELECT 42')
    const sourceBuffer = await page.locator('.monaco-editor').innerText()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await run(`CREATE TABLE ${full(target)} ${definition}`)
    for (const value of ["(4,'dup','target',NULL)", "(2,'dup','new',NULL)", "(1,'dup','same',NULL)"]) await run(`INSERT INTO ${full(target)} VALUES ${value}`)
    if (engine === 'oracle') await run('COMMIT'); await page.getByLabel('Filter database objects').fill(prefix)
    await run(engine === 'oracle' ? 'SAVEPOINT UI_GUARD' : ['sqlserver','azure-sql'].includes(engine) ? 'BEGIN TRANSACTION' : 'BEGIN')
    await open(); await expect(dialog.getByRole('button', { name: 'Compare data', exact: true })).toBeDisabled(); await expect(dialog.getByRole('alert')).toContainText('commit or roll back')
    await dialog.getByRole('button', { name: 'Close data comparison' }).click(); await run('ROLLBACK'); await open()
    const sourceValue = await dialog.getByLabel('Source table', { exact: true }).locator('option').filter({ hasText: source }).getAttribute('value')
    await dialog.getByLabel('Source table', { exact: true }).selectOption(sourceValue!)
    const before = (await page.evaluate(() => window.dbCommander.history())).length
    await dialog.getByLabel('Maximum rows per side').fill('2'); await compare(); await expect(dialog.getByRole('alert')).toContainText('No partial comparison', { timeout: 60000 }); await expect(dialog.locator('.data-counts')).toHaveCount(0)
    await dialog.getByLabel('Maximum rows per side').fill('3'); await compare(); await expect(dialog.getByRole('status')).toHaveText('Compared 3 source and 3 target rows. No data changed.', { timeout: 60000 })
    await expect(dialog.locator('.data-counts')).toHaveText('1 source-only · 1 target-only · 1 changed · 1 matching')
    await dialog.getByRole('button', { name: /· changed · label/ }).click(); await expect(dialog.getByRole('region', { name: 'Row comparison' })).toContainText('old'); await expect(dialog.getByRole('region', { name: 'Row comparison' })).toContainText('new')
    const path = join(directory, 'comparison.json')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, path)
    await dialog.getByRole('button', { name: 'Save comparison report', exact: true }).click(); await expect(dialog.getByRole('status')).toHaveText('Data comparison report saved.')
    const report = JSON.parse(readFileSync(path, 'utf8')); expect(report.counts).toEqual({ 'source-only': 1, 'target-only': 1, changed: 1, matching: 1 }); expect(report.request.target.table.name).toBe(target)
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(before)
    await page.screenshot({ path: testInfo.outputPath('data-comparison.png') })
    if (engine === 'duckdb') {
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(800, 600); window.setSize(960, 720) })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(960)
      const bounds = await dialog.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(960); expect(bounds!.height).toBeLessThanOrEqual(720)
      await dialog.getByRole('button', { name: 'Save comparison report', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('data-comparison-small.png') })
    }
    await dialog.getByLabel('Key columns', { exact: true }).selectOption('tenant'); await expect(dialog.locator('.data-counts')).toHaveCount(0); await compare(); await expect(dialog.getByRole('alert')).toContainText('not unique', { timeout: 60000 })
    await dialog.getByLabel('Key columns', { exact: true }).selectOption('note'); await compare(); await expect(dialog.getByRole('alert')).toContainText('NULL', { timeout: 60000 })
    await dialog.getByLabel('Key columns', { exact: true }).selectOption(['id', 'tenant']); await dialog.getByLabel('Comparison columns', { exact: true }).selectOption('label')
    for (const side of ['Source', 'Target']) { await dialog.getByRole('button', { name: `Add ${side.toLowerCase()} filter` }).click(); await dialog.getByLabel(`${side} filter 1 column`).selectOption('id'); await dialog.getByLabel(`${side} filter 1 value`).fill('2') }
    await compare(); await expect(dialog.getByRole('status')).toHaveText('Compared 1 source and 1 target rows. No data changed.', { timeout: 60000 }); await expect(dialog.locator('.data-counts')).toHaveText('0 source-only · 0 target-only · 1 changed · 0 matching')
    await dialog.getByLabel('Search captured rows').fill('not present'); await expect(dialog.getByText('No rows match this display filter.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Close data comparison' }).click(); await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect.poll(() => page.locator('.monaco-editor').innerText()).toBe(sourceBuffer); await expect(page.locator('.results-region')).toContainText('42')
    await run(`DROP TABLE ${full(source)}`); await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click(); await run(`DROP TABLE ${full(target)}`)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
