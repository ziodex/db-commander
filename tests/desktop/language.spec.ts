import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'
for (const engine of engineSchema.options) test(`${engine} schema autocomplete and undoable SQL formatting`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-language-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), q = (value: string) => quoteIdentifier(value, engine), name = `editor_${Date.now()}`
  async function enter(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql)
    await page.keyboard.press('Escape')
  }
  async function text() { return page.evaluate(async () => { const workspace = await window.dbCommander.loadWorkspace(); return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql }) }
  async function run(sql: string) {
    await enter(sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) await form.getByLabel('Open mode').selectOption('memory')
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander')
      await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await run(`create table ${q(name)} (${q('id')} integer, ${q('Display Name')} varchar(60)); insert into ${q(name)} values(41,'Editor verified')`)
    if (engine === 'oracle') await run('COMMIT')
    await expect(page.locator('.schema-list')).toContainText(name)
    // Every engine's custom formatting overrides the two-space global default.
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Automatic suggestions').uncheck()
    await preferences.getByRole('tab', { name: 'SQL formatting', exact: true }).click(); await preferences.getByLabel('Formatting settings for', { exact: true }).selectOption(engine)
    await preferences.getByLabel('Use custom formatting', { exact: true }).check()
    await preferences.getByLabel(/Format indent width/).fill('4')
    await preferences.getByLabel(/Inline expression width/).fill('20')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).not.toBeVisible()
    const source = `select c. from ${q(name)} c`
    await enter(source)
    for (let i = 0; i < source.length - 'select c.'.length; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+Space')
    const widget = page.locator('.suggest-widget.visible')
    await expect(widget).toBeVisible()
    await expect(widget.getByText('Display Name', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-completion.png`) })
    await widget.getByText('Display Name', { exact: true }).click()
    await page.keyboard.press('Tab')
    await expect.poll(text).toContain(`c.${q('Display Name')}`)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: 'Editor verified', exact: true })).toBeVisible()
    const sql = `select c.${q('id')},c.${q('Display Name')} from ${q(name)} c where c.${q('id')}=41`
    await enter(sql); const historyCount = await page.evaluate(async () => (await window.dbCommander.history()).length)
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(text).toContain('\n')
    expect(await text()).toMatch(/\n {4}\S/)
    expect(await page.evaluate(async () => (await window.dbCommander.history()).length)).toBe(historyCount)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z'); await expect.poll(text).toBe(sql)
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click(); await expect.poll(text).toContain('\n')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible()
    // Range formatting must leave the other statement byte-for-byte unchanged.
    const first = engine === 'oracle' ? 'select 3 as untouched from dual;' : 'select 3 as untouched;'
    await enter(first + '\n' + sql)
    for (let i = 0; i < sql.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(text).toMatch(new RegExp('^' + first + '\\nselect\\n'))
    await enter('CREATE PROCEDURE unsupported_body')
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('Procedural bodies'); await expect.poll(text).toBe('CREATE PROCEDURE unsupported_body')
    if (['sqlite', 'duckdb'].includes(engine)) {
      await page.getByRole('button', { name: 'New query tab', exact: true }).click()
      await expect(page.locator('.status-text')).toHaveText('Connected'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
      await expect(page.locator('.schema-list')).toContainText(name)
      await enter(source)
      for (let i = 0; i < source.length - 'select c.'.length; i++) await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('Control+Space'); await expect(widget.getByText('Display Name', { exact: true })).toBeVisible()
    }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
