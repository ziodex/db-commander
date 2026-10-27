import { waitForWorkspaceReady } from './workspace-ready'
import { tableAction, tableNode } from './explorer-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const engine of ['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql']) test(`${engine} server browsing and safe database switching`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-databases-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow(), target = "team's data", tsql = ['sqlserver', 'azure-sql'].includes(engine)
  const query = engine === 'postgres' ? 'SELECT current_database() AS context' : tsql ? 'SELECT DB_NAME() AS context' : 'SELECT DATABASE() AS context'
  async function enter(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  }
  async function run(sql: string) {
    await enter(sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  const button = (name: string) => page.getByRole('button', { name: `Switch to database ${name}`, exact: true })
  async function select(name: string) {
    await button(name).click()
    const dialog = page.getByRole('dialog', { name: 'Switch database', exact: true })
    await expect(dialog).toContainText('Temporary tables and session settings will be lost')
    await dialog.getByRole('button', { name: 'Switch database', exact: true }).click()
    await expect(dialog).not.toBeVisible(); await expect(page.locator('.target-label')).toHaveText(name)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'), prefix = engine === 'postgres' ? 'PG' : tsql ? 'SQLSERVER' : engine.toUpperCase()
    await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Connection name').fill('Server profile')
    await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
    await form.getByLabel('Database', { exact: true }).fill('')
    await form.getByLabel('User', { exact: true }).fill('browser_user')
    await form.getByLabel('Password', { exact: true }).fill(tsql ? 'Local-Test-Only!2026' : 'local-test-only')
    await form.getByText('Custom CA certificate', { exact: true }).click()
    await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(button(target)).toBeEnabled(); await expect(button('private_database')).toHaveCount(0)
    await run(query)
    await select(target)
    await expect(page.locator('.results-empty')).toBeVisible()
    await expect(page.locator('.monaco-editor')).toContainText(query)
    await expect(tableNode(page, 'switch_marker')).toBeVisible()
    await expect(tableNode(page, 'customers')).toHaveCount(0)
    await run('SELECT label FROM switch_marker'); await expect(page.getByRole('cell', { name: 'target database', exact: true })).toBeVisible()
    await tableAction(page, 'switch_marker', 'Edit data')
    await page.getByLabel('Row 1 label', { exact: true }).fill('draft')
    await expect(button('dbcommander')).toBeDisabled()
    await expect(page.locator('.database-explorer')).toContainText('staged table edits')
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(button('dbcommander')).toBeDisabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(button('dbcommander')).toBeEnabled()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.locator('.target-label')).toHaveText(target)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await run(query)
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await select('dbcommander')
    await expect(tableNode(page, 'customers')).toBeVisible()
    await expect(tableNode(page, 'switch_marker')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.locator('.target-label')).toHaveText(target)
    await expect(page.getByRole('cell', { name: target, exact: true })).toBeVisible()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const saved = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(saved?.profiles[0].config.database).toBe('')
    expect(saved?.tabs.map(tab => tab.profile.database)).toEqual(['dbcommander', target])
    await page.screenshot({ path: testInfo.outputPath('database-browser.png') })
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
