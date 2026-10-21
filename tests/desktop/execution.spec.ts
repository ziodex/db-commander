import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`execution ${engine}: current SQL, scripts, parameters and error navigation`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-execution-')), env: Record<string, string> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const tds = ['sqlserver', 'azure-sql'].includes(engine), from = engine === 'oracle' ? ' FROM dual' : '', separator = tds ? '\nGO\n' : ';\n'
  const currentLabel = tds ? 'Run current batch' : 'Run current statement', failureLabel = tds ? 'Go to failed batch' : 'Go to failed statement'
  async function enter(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  }
  async function persisted() { return page.evaluate(async () => { const workspace = await window.dbCommander.loadWorkspace(); return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql }) }
  async function menu(label: string) { await page.getByRole('button', { name: 'Query tools', exact: true }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  async function complete() { await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled() }
  async function history() { return page.evaluate(async () => (await window.dbCommander.history()).length) }
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) await form.getByLabel('Open mode').selectOption('memory')
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander')
      await form.getByLabel('Password', { exact: true }).fill(tds ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    // Connection completes before the initial catalog load; shortcuts correctly
    // refuse to run while that operation still owns the session.
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled({ timeout: 30000 })
    // Leave the cursor at the end of the second statement, including its terminator.
    const first = `SELECT 11${from}`, second = tds ? 'DECLARE @answer INT=42; SELECT @answer;' : `SELECT 42${from};`
    await enter(first + separator + second)
    await page.keyboard.press(`${modifier}+Shift+Enter`); await complete()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await expect(page.locator('.result-tabs button')).toHaveCount(0)
    // Explicit script execution ignores the editor selection.
    await page.keyboard.press('Shift+ArrowLeft'); await menu('Run entire script'); await complete()
    await expect(page.locator('.result-tabs button')).toHaveCount(2)
    // The right-click menu executes the highlighted range without adjacent SQL.
    const selected = `SELECT 73${from}`
    await enter(first + separator + selected)
    for (let i = 0; i < selected.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.locator('.view-line').filter({ hasText: selected }).click({ button: 'right', position: { x: 20, y: 10 } })
    await page.screenshot({ path: testInfo.outputPath(`${engine}-selection-menu.png`) })
    // Monaco installs menu mouse-up handlers after 100 ms to prevent the
    // opening right-click from accidentally executing the first action.
    await page.getByRole('menuitem', { name: 'Run selected SQL', exact: true }).click({ delay: 150 }); await complete()
    await expect(page.getByRole('cell', { name: '73', exact: true })).toBeVisible(); await expect(page.locator('.result-tabs button')).toHaveCount(0)
    await page.getByRole('button', { name: 'Query history', exact: true }).click()
    const latest = (await page.evaluate(() => window.dbCommander.history()))[0]
    const timestamp = await page.evaluate(startedAt => new Date(startedAt).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), latest.startedAt)
    await expect(page.locator('.history-list time').first()).toHaveText(timestamp)
    await expect(page.locator('.history-list time').first()).toHaveAttribute('datetime', latest.startedAt)
    await page.screenshot({ path: testInfo.outputPath(`${engine}-history-date.png`) })
    await page.getByRole('button', { name: 'Database explorer', exact: true }).click()
    // Whitespace is still an explicit selection, never permission to run the script.
    const beforeBlank = await history()
    await enter(`SELECT 999${from}\n   `)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.locator('.view-line').last().click({ button: 'right', position: { x: 9, y: 10 } })
    await page.getByRole('menuitem', { name: 'Run selected SQL', exact: true }).click({ delay: 150 })
    await expect(page.getByRole('menuitem', { name: 'Run selected SQL', exact: true })).not.toBeVisible()
    // Current mode supports the bound-parameter prompt without including adjacent SQL.
    await enter(first + separator + `SELECT :answer${from}`); await menu(currentLabel)
    const parameters = page.getByRole('dialog', { name: 'Query parameters' })
    await expect(parameters.getByLabel('Parameterized SQL')).toHaveValue(`SELECT :answer${from}`)
    await parameters.getByLabel('Type for answer').selectOption('integer'); await parameters.getByLabel('Value for answer').fill('81')
    await parameters.getByRole('button', { name: 'Run with parameters' }).click(); await complete()
    await expect(page.getByRole('cell', { name: '81', exact: true })).toBeVisible()
    expect(await history()).toBe(beforeBlank + 1)
    // The failed unit is navigable without running it again; edits disable the link.
    const missing = `SELECT * FROM missing_execution_${Date.now()}`, failing = `SELECT ${tds ? 'N' : ''}'😀'${from}${separator}  ${missing}`
    await enter(failing); await menu('Run entire script'); await expect(page.locator('.status-text')).toHaveText('Failed')
    const link = page.getByRole('button', { name: failureLabel, exact: true }); await expect(link).toBeEnabled()
    const count = await history(); await link.click(); await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused(); expect(await history()).toBe(count)
    // Replacing the selected range proves that navigation selected only the failed unit.
    await page.keyboard.insertText('x'); await page.keyboard.press('Escape')
    await expect.poll(persisted).toBe(failing.replace(missing, 'x'))
    await expect(page.getByRole('button', { name: 'SQL changed since execution', exact: true })).toBeDisabled()
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(persisted).toBe(failing); await expect(link).toBeEnabled()
    const original = page.getByRole('tab', { selected: true }); const originalId = await original.getAttribute('id')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await expect(page.locator('.sql-error-link')).not.toBeVisible()
    await page.locator(`[id="${originalId}"]`).click(); await expect(link).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-error-navigation.png`) })
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
