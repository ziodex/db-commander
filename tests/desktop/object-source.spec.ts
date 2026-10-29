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

test('object source review remains reachable across themes and zoom', async ({}, testInfo) => {
  test.setTimeout(180000)
  const selected = (process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',')
  test.skip(!selected.includes('sqlite') && !selected.includes('duckdb'), 'An embedded engine is required')
  const engine = selected.includes('sqlite') ? 'sqlite' : 'duckdb'
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-source-layout-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow()
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption(engine); await connection.getByLabel('Open mode').selectOption('create')
    await connection.getByLabel('Database file').fill(join(directory, 'data.db'))
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).toBeHidden()
    const editor = page.locator('.monaco-editor'), input = editor.locator('textarea.inputarea'), run = page.getByRole('button', { name: /^Run SQL/ })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
    await expect(run).toBeEnabled(); await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText('CREATE VIEW source_layout AS SELECT 1 AS id'); await page.keyboard.press('Escape')
    await expect(editor).toContainText('CREATE VIEW source_layout'); await run.click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: 'Refresh schema', exact: true })).toBeEnabled({ timeout: 60000 })
    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click(); await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await settings.getByLabel('Appearance', { exact: true }).selectOption(theme); await settings.getByRole('button', { name: 'Apply settings', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const { width, height, zoom, name } of [
        { width: 1440, height: 940, zoom: 1, name: 'wide' },
        { width: 1024, height: 700, zoom: 1.25, name: 'compact-125' },
        { width: 1024, height: 700, zoom: 2, name: 'compact-200' }
      ]) {
        await app.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(value.width, value.height); window.webContents.setZoomFactor(value.zoom) }, { width, height, zoom })
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(width / zoom))
        await page.getByLabel('Filter database objects').fill('source_layout'); await page.getByLabel('Object kind', { exact: true }).selectOption('view')
        await tableAction(page, 'source_layout', 'Object details')
        const dialog = page.getByRole('dialog', { name: 'Object details', exact: true })
        await expect(dialog.getByRole('button', { name: 'Close object details' })).toBeInViewport({ ratio: 1 })
        await dialog.getByRole('button', { name: 'Edit object source' }).click()
        const draft = dialog.getByLabel('Edited source'); await draft.fill((await draft.inputValue()).replace(/SELECT 1/i, 'SELECT 2'))
        const editHeading = dialog.getByRole('heading', { name: 'Edit source', exact: true })
        await editHeading.evaluate(element => {
          element.scrollIntoView({ block: 'start' })
          const dialog = element.closest('.object-inspector'), header = dialog?.querySelector('.dialog-heading')
          if (dialog && header) dialog.scrollBy(0, element.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 8)
        })
        await expect(editHeading).toBeInViewport({ ratio: 1 })
        const capture = async (stage: string) => {
          const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
          writeFileSync(testInfo.outputPath(`source-${stage}-${theme}-${name}.png`), Buffer.from(image, 'base64'))
        }
        await capture('edit')
        await dialog.getByRole('button', { name: 'Review source SQL' }).click()
        const heading = dialog.getByRole('heading', { name: 'Review source SQL' }), preview = dialog.getByLabel('Source SQL preview')
        await expect(heading).toBeFocused(); await expect(heading).toBeInViewport({ ratio: 1 })
        await expect.poll(() => heading.evaluate(element => { const header = element.closest('.object-inspector')?.querySelector('.dialog-heading'); return Boolean(header && element.getBoundingClientRect().top >= header.getBoundingClientRect().bottom) })).toBe(true)
        await expect(preview).toHaveValue(/SELECT 2/i); await capture('review')
        const confirm = dialog.getByLabel('I reviewed this SQL and its target.'), destructive = dialog.getByLabel('I understand this may change or remove an existing object and its dependencies.'), apply = dialog.getByRole('button', { name: 'Apply reviewed source' })
        await expect(apply).toBeDisabled(); await confirm.check(); await expect(confirm).toBeInViewport({ ratio: 1 }); await expect(apply).toBeDisabled()
        await destructive.check(); await expect(destructive).toBeInViewport({ ratio: 1 }); await apply.scrollIntoViewIfNeeded(); await expect(apply).toBeInViewport({ ratio: 1 }); await expect(apply).toBeEnabled()
        await dialog.getByRole('button', { name: 'Discard draft and close editor' }).click(); await dialog.getByRole('button', { name: 'Close object details' }).click()
      }
    }
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
