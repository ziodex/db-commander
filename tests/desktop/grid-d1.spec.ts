import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'
import { withClipboard } from './clipboard-fixture'

test('D1 stages duplicate, spreadsheet paste, large values and SQL preview from a fresh query source', async ({}, info) => {
  test.setTimeout(120000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-d1-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function run(sql: string) {
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await run("CREATE TABLE d1 (id INTEGER PRIMARY KEY, name TEXT, note TEXT); INSERT INTO d1 VALUES (1,'one','first'),(2,'two','second');")
    await run('SELECT * FROM main.d1')
    await page.getByRole('button', { name: 'Edit source table', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Open source table for editing' })
    await expect(review).toContainText('fresh page'); await expect(review).toContainText('will not run again')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    writeFileSync(info.outputPath('d1-source-dark.png'), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()))
    await review.getByRole('button', { name: 'Open table' }).click(); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('button', { name: 'Close data', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Query results' })).toBeVisible()
    await page.getByRole('button', { name: 'Edit source table', exact: true }).click()
    await page.getByRole('dialog', { name: 'Open source table for editing' }).getByRole('button', { name: 'Open table' }).click()
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('button', { name: 'Duplicate row 1' }).click()
    await expect(page.getByLabel('Row 3 name', { exact: true })).toHaveValue('one')
    await withClipboard(app, async () => {
      await app.evaluate(({ clipboard }) => clipboard.writeText('alpha\t"line 1\nline 2"\nbeta\ttail'))
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
      await page.getByLabel('Row 1 name', { exact: true }).click(); await page.keyboard.press(`${modifier}+V`)
      await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('alpha')
      await expect(page.getByLabel('Row 1 note', { exact: true })).toHaveValue('line 1\nline 2')
      await expect(page.getByLabel('Row 2 name', { exact: true })).toHaveValue('beta')
    })
    await page.getByRole('button', { name: 'Edit full value in row 3 note' }).click()
    const value = page.getByRole('dialog', { name: 'Edit full cell value' }), large = 'Ω'.repeat(20_000) + '\nfull value'
    await value.getByLabel('Full cell value').fill(large); await value.getByRole('button', { name: 'Stage value' }).click()
    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await preferences.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const zoom of [1, 1.25, 2]) {
        if (zoom === 2) { await page.getByRole('button', { name: 'Maximize results', exact: true }).click(); await expect(page.locator('#query-panel')).toBeHidden() }
        const contentWidth = await app.evaluate(({ BrowserWindow }, factor) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 700); window.webContents.setZoomFactor(factor); return window.getContentSize()[0] }, zoom)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeCloseTo(contentWidth / zoom, 0)
        if (zoom === 2) await page.getByRole('button', { name: 'Apply edits', exact: true }).scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        writeFileSync(info.outputPath(`d1-grid-${theme}-${zoom}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()))
        writeFileSync(info.outputPath(`d1-geometry-${theme}-${zoom}.json`), JSON.stringify(await page.evaluate(() => Object.fromEntries(['#query-panel', '#execution-output', '.grid-edit-toolbar', '.grid-scroll', '.grid-edit-toolbar .primary-button'].map(selector => { const element = document.querySelector(selector)!; const rect = element.getBoundingClientRect(); return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, hidden: element.hasAttribute('hidden') }] }))), null, 2))
        await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Close data', exact: true })).toBeInViewport()
        expect(await page.getByRole('table', { name: 'Editable table data' }).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(184)
        if (zoom === 2) {
          await page.getByRole('table', { name: 'Editable table data' }).scrollIntoViewIfNeeded()
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          writeFileSync(info.outputPath(`d1-rows-${theme}-${zoom}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()))
          await expect(page.getByRole('table', { name: 'Editable table data' })).toBeInViewport()
        }
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
      await page.getByRole('button', { name: 'Restore editor and results', exact: true }).click()
      await page.getByRole('button', { name: 'Review SQL' }).click()
      const themedPreview = page.getByRole('dialog', { name: 'Review table edit SQL' })
      await expect(themedPreview).toBeVisible()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      writeFileSync(info.outputPath(`d1-review-${theme}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()))
      await themedPreview.getByRole('button', { name: 'Close preview' }).click()
      await page.getByRole('button', { name: 'Edit full value in row 1 note' }).click()
      const themedValue = page.getByRole('dialog', { name: 'Edit full cell value' }); await expect(themedValue).toBeVisible()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      writeFileSync(info.outputPath(`d1-value-${theme}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG()))
      await themedValue.getByRole('button', { name: 'Cancel' }).click()
    }
    await page.getByRole('button', { name: 'Review SQL' }).click()
    const sql = page.getByRole('dialog', { name: 'Review table edit SQL' })
    await expect(sql).toContainText('UPDATE'); await expect(sql).toContainText('INSERT'); await expect(sql).not.toContainText('alpha'); await expect(sql).toContainText('bound')
    for (const zoom of [1, 1.25, 2]) {
      await app.evaluate(({ BrowserWindow }, factor) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 700); window.webContents.setZoomFactor(factor) }, zoom)
      await expect(sql).toBeInViewport()
      writeFileSync(info.outputPath(`d1-review-${zoom}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    await sql.getByRole('button', { name: 'Close preview' }).click()
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await page.getByRole('button', { name: 'Reload data', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await expect(page.getByLabel('Row 3 note', { exact: true })).toHaveValue(large)
    await page.getByRole('button', { name: 'Close data', exact: true }).click()
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('D1 edits native binary bytes as hexadecimal without treating them as SQL', async () => {
  test.setTimeout(60000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-d1-binary-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText("CREATE TABLE binary_test(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO binary_test VALUES (1,from_hex('00ff')); SELECT * FROM main.binary_test;"); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.getByRole('button', { name: 'Edit source table', exact: true }).click()
    await page.getByRole('dialog', { name: 'Open source table for editing' }).getByRole('button', { name: 'Open table' }).click()
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('button', { name: 'Edit full value in row 1 payload' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit full cell value' }), input = editor.getByLabel('Full cell value')
    await expect(editor).toContainText('hexadecimal byte pairs'); await expect(input).toHaveValue(/00ff/i)
    await input.fill('abc'); await expect(editor.getByRole('alert')).toContainText('complete hexadecimal'); await expect(editor.getByRole('button', { name: 'Stage value' })).toBeDisabled()
    await input.fill('00ff2780'); await editor.getByRole('button', { name: 'Stage value' }).click()
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await page.getByRole('button', { name: 'Reload data', exact: true }).click(); await expect(page.getByLabel('Row 1 payload', { exact: true })).toHaveValue(/00ff2780/i)
    await page.getByRole('button', { name: 'Inspect row 1 payload' }).click()
    const inspector = page.getByRole('dialog', { name: 'Value inspector' })
    await inspector.getByLabel('Value format').selectOption('hex'); await expect(inspector).toContainText('Database binary bytes')
    await expect(inspector.getByLabel('Inspected value')).toHaveValue(/00 ff 27 80/i)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
