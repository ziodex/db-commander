import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { queryTool } from './workspace-actions'

for (const engine of engineSchema.options) test(`snippet files ${engine}: reviewed import, portable export and explicit execution`, async ({}, testInfo) => {
  test.setTimeout(90000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-snippets-ui-')), userData = join(directory, 'profile')
  const env: Record<string, string> = { ...process.env, SQLCOMMANDER_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const from = engine === 'oracle' ? ' FROM dual' : '', q = (s: string) => quoteIdentifier(s, engine)

  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) await form.getByLabel('Open mode').selectOption('memory')
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled({ timeout: 30000 })
    async function enter(sql: string) { await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape') }
    await enter(`SELECT 42 AS ${q('previous')}${from}`); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    const apiHistory = () => page.evaluate(() => window.dbCommander.history())
    const before = await apiHistory(), sql = `SELECT :id AS ${q('answer')}${from}`
    const saved = await page.evaluate(async ({ sql, engine }) => window.dbCommander.saveSnippet({ name: 'Lookup Ω', description: 'Portable lookup', engine, sql, favorite: true }), { sql, engine })
    const other = await page.evaluate(() => window.dbCommander.saveSnippet({ name: 'Another snippet', description: '', sql: 'SELECT 1', favorite: false }))
    await queryTool(page, 'Query library')
    const library = page.getByRole('dialog', { name: 'Query library', exact: true }), review = page.getByRole('dialog', { name: 'Import snippets', exact: true })
    await library.getByRole('button', { name: 'Snippets', exact: true }).click()
    await library.locator('.library-list button').filter({ hasText: 'Lookup Ω' }).click()
    // Export saved content, preserving unsaved edits in the snippet editor.
    await library.getByLabel('Snippet SQL', { exact: true }).fill('SELECT unsaved_draft')
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
    await library.getByRole('button', { name: 'Export saved snippet', exact: true }).click()
    await expect(library.getByRole('button', { name: 'Export saved snippet', exact: true })).toBeEnabled()
    const file = join(directory, 'snippets.json'); writeFileSync(file, 'original')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
    await library.getByRole('button', { name: 'Export saved snippet', exact: true }).click()
    await expect(library.getByRole('alert')).toContainText('already exists'); expect(readFileSync(file, 'utf8')).toBe('original')
    rmSync(file)
    await library.getByRole('button', { name: 'Export saved snippet', exact: true }).click(); await expect(library.getByRole('status')).toHaveText('Snippet exported.')
    const exported = JSON.parse(readFileSync(file, 'utf8'))
    expect(exported).toEqual({ format: 'dbcommander-snippets', version: 1, snippets: [{ name: saved.name, description: saved.description, engine, sql, favorite: true }] })
    await expect(library.getByLabel('Snippet SQL', { exact: true })).toHaveValue('SELECT unsaved_draft')
    await library.getByLabel('Search snippets').fill('Lookup Ω'); await expect(library.locator('.library-list button')).toHaveCount(1)
    const filtered = join(directory, 'filtered.json')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, filtered)
    await library.getByRole('button', { name: 'Export listed snippets', exact: true }).click(); await expect(library.getByRole('status')).toHaveText('1 snippets exported.')
    expect(JSON.parse(readFileSync(filtered, 'utf8'))).toEqual(exported)
    await page.evaluate(async ids => { for (const id of ids) await window.dbCommander.deleteSnippet(id) }, [saved.id, other.id])
    const importFile = join(directory, 'incoming.json')
    const incoming = { ...exported, snippets: [...exported.snippets, { name: 'Never execute', description: '', engine, sql: 'DELETE FROM must_never_execute', favorite: false }, { ...exported.snippets[0], sql: 'SELECT duplicate_should_be_skipped' }] }
    writeFileSync(importFile, JSON.stringify(incoming))
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await library.getByRole('button', { name: 'Import snippets', exact: true }).click(); await expect(library.getByRole('button', { name: 'Import snippets', exact: true })).toBeEnabled()
    await expect(review).not.toBeVisible()
    async function choose(path: string) { await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path); await library.getByRole('button', { name: 'Import snippets', exact: true }).click() }
    await choose(importFile); await expect(review.getByLabel('SQL to import')).toHaveValue(sql)
    await expect(review).toContainText('2 to import · 1 duplicates skipped')
    await page.keyboard.press('Escape'); await expect(review).not.toBeVisible(); await expect(library).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.snippets())).toEqual([])
    await choose(importFile)
    await review.getByRole('checkbox', { name: 'Import snippet 2: Never execute', exact: true }).uncheck()
    await expect(review).toContainText('1 to import · 1 duplicates skipped')
    await page.screenshot({ path: testInfo.outputPath(`${engine}-snippet-import.png`) })
    // The reviewed snapshot is authoritative even if the source file changes.
    writeFileSync(importFile, '{invalid after review')
    await review.getByRole('button', { name: 'Import selected snippets', exact: true }).click()
    await expect(review).not.toBeVisible(); await expect(library.getByRole('status')).toHaveText('1 snippets imported. 1 duplicates skipped.')
    await expect(library.getByLabel('Snippet SQL', { exact: true })).toHaveValue('SELECT unsaved_draft')
    const imported = (await page.evaluate(() => window.dbCommander.snippets()))[0]
    expect(imported.id).not.toBe(saved.id); expect(imported).toMatchObject(exported.snippets[0])
    await choose(file); await expect(review).toContainText('0 to import · 1 duplicates skipped')
    await review.getByRole('button', { name: 'Import selected snippets', exact: true }).click(); await expect(library.getByRole('status')).toHaveText('0 snippets imported. 1 duplicates skipped.')
    await choose(file); await review.getByLabel('Duplicate snippets').selectOption('copy')
    await expect(review).toContainText('Import as Lookup Ω (imported 2)')
    await review.getByRole('button', { name: 'Import selected snippets', exact: true }).click(); await expect(library.getByRole('status')).toHaveText('1 snippets imported. 0 duplicates skipped.')
    expect(await apiHistory()).toEqual(before)
    await choose(file)
    await page.evaluate(() => window.dbCommander.saveSnippet({ name: 'Concurrent change', description: '', sql: 'SELECT 1', favorite: false }))
    await review.getByRole('button', { name: 'Import selected snippets', exact: true }).click(); await expect(review.getByRole('alert')).toContainText('changed after this review')
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    writeFileSync(importFile, JSON.stringify({ ...exported, version: 999 }))
    await choose(importFile); await expect(library.getByRole('alert')).toContainText('Invalid snippet file'); await expect(review).not.toBeVisible()
    expect(await apiHistory()).toEqual(before)
    await library.getByRole('button', { name: 'Close query library', exact: true }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    // Only opening and explicitly running an imported snippet executes its SQL.
    await queryTool(page, 'Query library'); await library.getByRole('button', { name: 'Snippets', exact: true }).click()
    await library.locator('.library-list button').filter({ hasText: 'Lookup Ω (imported 2)' }).click()
    await library.getByRole('button', { name: 'Open snippet in new tab', exact: true }).click(); await expect(library).not.toBeVisible()
    expect(await apiHistory()).toEqual(before)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    const parameters = page.getByRole('dialog', { name: 'Query parameters', exact: true })
    await parameters.getByLabel('Type for id').selectOption('integer'); await parameters.getByLabel('Value for id').fill('9223372036854775807')
    await parameters.getByRole('button', { name: 'Run with parameters', exact: true }).click()
    await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    expect((await apiHistory()).length).toBe(before.length + 1)
    expect(readFileSync(file, 'utf8')).not.toContain('9223372036854775807')
    const retained = await page.evaluate(() => window.dbCommander.snippets())
    await app.evaluate(({ app }) => app.exit()); await app.close()
    const restarted = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
    try { const restored = await restarted.firstWindow(); await waitForWorkspaceReady(restored); expect(await restored.evaluate(() => window.dbCommander.snippets())).toEqual(retained) }
    finally { await restarted.evaluate(({ app }) => app.exit()); await restarted.close() }
    expect(existsSync(file)).toBe(true)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
