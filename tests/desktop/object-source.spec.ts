import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'
import { waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['sqlite', 'duckdb'] as const) test(`object source ${engine}: compare, review and apply a view`, async ({}, testInfo) => {
  test.setTimeout(120000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-source-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), name = `source_ui_${Date.now()}`
  async function run(sql: string) {
    const editor = page.locator('.monaco-editor'), input = editor.locator('textarea.inputarea')
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await expect(editor).toContainText(sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: 'Refresh schema', exact: true })).toBeEnabled({ timeout: 60000 })
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory, 'data.db'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await run(`CREATE VIEW "${name}" AS SELECT 1 AS id`)
    await page.getByLabel('Filter database objects').fill(name); await page.getByLabel('Object kind', { exact: true }).selectOption('view')
    await tableAction(page, name, 'Object details')
    const inspector = page.getByRole('dialog', { name: 'Object details', exact: true })
    await expect(inspector.getByLabel('Object definition')).toHaveValue(/SELECT 1/i)
    await inspector.getByRole('button', { name: 'Edit object source' }).click()
    const draft = inspector.getByLabel('Edited source'), original = await draft.inputValue()
    expect(original).toMatch(/SELECT 1/i)
    await draft.fill(original.replace(/SELECT 1/i, 'SELECT 2'))
    await inspector.getByRole('button', { name: 'Check current definition' }).click()
    await expect(inspector.getByRole('button', { name: 'Review source SQL' })).toBeEnabled({ timeout: 60000 })
    await expect(draft).toHaveValue(/SELECT 2/i)
    await inspector.getByRole('button', { name: 'Review source SQL' }).click()
    await expect(inspector.getByLabel('Source SQL preview')).toHaveValue(/SELECT 2/i)
    if (engine === 'sqlite') await expect(inspector.getByLabel('Source SQL preview')).toHaveValue(/DROP VIEW/i)
    const heading = inspector.getByRole('heading', { name: 'Review source SQL' }); await expect(heading).toBeFocused(); await expect(heading).toBeInViewport({ ratio: 1 })
    await expect.poll(() => heading.evaluate(element => { const header = element.closest('.object-inspector')?.querySelector('.dialog-heading'); return Boolean(header && element.getBoundingClientRect().top >= header.getBoundingClientRect().bottom) })).toBe(true)
    const apply = inspector.getByRole('button', { name: 'Apply reviewed source' }); await expect(apply).toBeDisabled()
    await inspector.getByLabel('I reviewed this SQL and its target.').check(); await expect(apply).toBeDisabled()
    await inspector.getByLabel('I understand this may change or remove an existing object and its dependencies.').check()
    const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(testInfo.outputPath(`${engine}-source-review.png`), Buffer.from(capture, 'base64'))
    await apply.click(); await expect(inspector.getByText(/Close this dialog, then Commit or Rollback/)).toBeVisible({ timeout: 60000 })
    await inspector.getByRole('button', { name: 'Discard draft and close editor' }).click()
    await inspector.getByRole('button', { name: 'Close object details' }).click()
    await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT id FROM "${name}"`)
    await expect(page.locator('.result-grid-container')).toContainText('2')
    if (engine === 'duckdb') {
      const macro = `${name}_macro`
      await run(`CREATE MACRO "${macro}"(x) AS x + 2`)
      await page.getByLabel('Filter database objects').fill(macro); await page.getByLabel('Object kind', { exact: true }).selectOption('macro')
      await page.getByRole('button', { name: new RegExp(`^Object details ${macro}`) }).click()
      await expect(inspector.getByRole('button', { name: 'Open routine call in new tab' })).toBeEnabled({ timeout: 60000 })
      await expect(inspector.getByLabel('Routine call SQL')).toHaveValue(/:arg1/)
      await inspector.getByRole('button', { name: 'Open routine call in new tab' }).click(); await expect(inspector).not.toBeVisible()
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled(); await page.getByRole('button', { name: /^Run SQL/ }).click()
      const parameters = page.getByRole('dialog', { name: 'Query parameters' })
      await parameters.getByLabel('Type for arg1').selectOption('integer'); await parameters.getByLabel('Value for arg1').fill('10')
      await parameters.getByRole('button', { name: 'Run with parameters' }).click(); await expect(parameters).not.toBeVisible()
      await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.locator('.result-grid-container')).toContainText('12')
      await expect(page.locator('.monaco-editor')).toContainText(':arg1')
    }
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
