import { _electron as electron, test, expect, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'

const key = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-result-workflow-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow()
  await waitForWorkspaceReady(page)
  return { app, page, directory, close: async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } }
}
async function connect(page: Page, engine: 'sqlite' | 'duckdb') {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
  await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Save connection profile').uncheck()
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function enter(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor'), input = editor.locator('textarea.inputarea')
  await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
  await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await expect(editor.locator('.view-lines')).toContainText(sql)
}
async function run(page: Page, sql: string, status = 'Completed') {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText(status)
}
const result = (page: Page, number: number) => page.getByRole('button', { name: `Result ${number}`, exact: true })

for (const engine of ['sqlite', 'duckdb'] as const) {
  test(`result navigation ${engine}: selects rows, preserves empty results and affected counts`, async ({}, info) => {
    const { app, page, close } = await launch()
    try {
      await connect(page, engine)
      await run(page, "CREATE TEMP TABLE report(id INTEGER); INSERT INTO report VALUES(41),(42); SELECT id FROM report WHERE 0=1; SELECT id AS customer_id FROM report; UPDATE report SET id=id;")
      await expect(result(page, 4)).toHaveAttribute('aria-pressed', 'true')
      await expect(result(page, 4)).toContainText('2 rows'); await expect(result(page, 4)).toHaveAttribute('aria-description', /SELECT id AS customer_id/)
      await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
      await expect(page.locator('.result-footer')).toContainText('2 rows fetched')
      await result(page, 3).click(); await expect(page.getByText('Query returned no rows.', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Export preview', exact: true })).toBeEnabled()
      await result(page, 5).click(); await expect(page.locator('.result-footer')).toContainText('2 rows affected')
      await expect(page.locator('.result-footer')).not.toContainText('fetched')
      await expect(page.getByRole('button', { name: 'Export all rows', exact: true })).toBeDisabled()
      await result(page, 4).click()
      for (const [width, height, zoom] of [[1440, 940, 1], [1024, 700, 1], [1024, 700, 1.25]]) {
        await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(width, height); w.webContents.setZoomFactor(zoom) }, { width, height, zoom })
        await expect.poll(() => page.evaluate(expected => Math.abs(innerWidth - expected) < 2, width / zoom)).toBe(true)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await page.getByRole('button', { name: 'Export all rows', exact: true }).scrollIntoViewIfNeeded()
        await expect(page.getByRole('button', { name: 'Export all rows', exact: true })).toBeInViewport({ ratio: 1 })
        await expect(page.getByRole('button', { name: 'Export preview', exact: true })).toBeInViewport({ ratio: 1 })
        await expect(result(page, 4)).toBeInViewport({ ratio: 1 })
        writeFileSync(info.outputPath(`${engine}-results-${width}-${zoom}.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
      }
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1); w.setSize(1440, 940) })
      await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
      await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      writeFileSync(info.outputPath(`${engine}-results-light.png`), await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
    } finally { await close() }
  })

  test(`result navigation ${engine}: full export uses selected source and preview never replays SQL`, async ({}, info) => {
    const { app, page, directory, close } = await launch()
    try {
      await connect(page, engine)
      const select = engine === 'sqlite'
        ? 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1205) SELECT i AS item_id FROM n'
        : 'SELECT i AS item_id FROM range(1,1206) t(i)'
      const script = `CREATE TEMP TABLE once_only(n INTEGER); INSERT INTO once_only VALUES(1); ${select}; SELECT 9999 AS other_result;`
      await run(page, script)
      await expect(result(page, 3)).toHaveAttribute('aria-pressed', 'true')
      await expect(result(page, 3)).toContainText('limited')
      const history = await page.evaluate(() => window.dbCommander.history())
      await enter(page, 'DELETE FROM once_only;')
      const preview = join(directory, 'preview.csv')
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, preview)
      await page.getByRole('button', { name: 'Export preview', exact: true }).click()
      await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
      expect(readFileSync(preview, 'utf8').trim().split('\r\n')).toHaveLength(1001)
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await page.getByRole('button', { name: 'Export all rows', exact: true }).click()
      const review = page.getByRole('dialog', { name: 'Export all rows', exact: true })
      await expect(review.getByLabel('SQL to execute for export')).toHaveValue(new RegExp('^' + select.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';?$'))
      await expect(review.locator('.transfer-source')).toContainText('Result 3')
      await expect(review.getByRole('button', { name: 'Run and export', exact: true })).toBeDisabled()
      const full = join(directory, 'full.json')
      await review.getByLabel('Data format').selectOption('json'); await review.getByLabel('New export file').fill(full)
      await review.getByRole('checkbox').check(); await review.getByLabel('SQL to execute for export').fill(script)
      await expect(review.getByRole('checkbox')).not.toBeChecked()
      await expect(review.getByRole('alert')).toContainText('SELECT')
      await expect(review.getByRole('button', { name: 'Run and export', exact: true })).toBeDisabled()
      expect(existsSync(full)).toBe(false)
      await review.getByLabel('SQL to execute for export').fill(select); await review.getByRole('checkbox').check()
      await page.screenshot({ path: info.outputPath(`${engine}-export-review.png`) })
      await review.getByRole('button', { name: 'Run and export', exact: true }).click()
      await expect(review.getByRole('status')).toHaveText('completed · 1,205 rows')
      const data = JSON.parse(readFileSync(full, 'utf8')); expect(data.rows).toHaveLength(1205); expect(data.rows[0]).toEqual(['1']); expect(data.rows.at(-1)).toEqual(['1205'])
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await review.getByRole('button', { name: 'Close data transfer', exact: true }).click()
      await run(page, 'SELECT count(*) AS writes FROM once_only;'); await expect(page.locator('[data-result-row="0"][data-result-column="0"]')).toHaveText('1')
      writeFileSync(info.outputPath('export-scope.json'), JSON.stringify({ engine, previewRows: 1000, fullRows: data.rows.length, scriptReplayed: false, editorMutationExecuted: false }))
    } finally { await close() }
  })

  test(`result navigation ${engine}: explicit choices survive late completion and partial errors`, async () => {
    const { app, page, close } = await launch()
    try {
      await connect(page, engine)
      for (const messages of [false, true]) {
        await app.evaluate(({ BrowserWindow }) => {
          const web = BrowserWindow.getAllWindows()[0].webContents, send = web.send.bind(web)
          let held: (() => void) | undefined
          web.send = ((channel: string, ...args: unknown[]) => {
            if (channel === 'sql:event' && (args[0] as { type?: string })?.type === 'complete') { held = () => send(channel, ...args); return }
            send(channel, ...args)
          }) as typeof web.send
          ;(globalThis as any).__finishResultTest = () => { if (!held) throw new Error('No held completion.'); web.send = send; held(); delete (globalThis as any).__finishResultTest }
        })
        await enter(page, 'SELECT 11 AS first; SELECT 12 AS second;'); await page.getByRole('button', { name: /^Run SQL/ }).click()
        await expect(result(page, 2)).toBeVisible(); await result(page, 2).click()
        if (messages) await page.getByRole('button', { name: /^Messages/ }).click()
        await app.evaluate(() => (globalThis as any).__finishResultTest())
        await expect(page.locator('.status-text')).toHaveText('Completed')
        if (messages) { await expect(page.getByRole('button', { name: /^Messages/ })).toHaveAttribute('aria-pressed', 'true'); await page.getByRole('button', { name: /^Results/ }).click() }
        await expect(result(page, 2)).toHaveAttribute('aria-pressed', 'true')
      }
      await run(page, 'SELECT 73 AS retained; SELECT missing FROM table_that_does_not_exist;', 'Failed')
      await expect(page.getByRole('cell', { name: '73', exact: true })).toBeVisible()
      await expect(page.locator('.result-footer')).toContainText('1 row fetched')
      const long = engine === 'sqlite' ? 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000000000) SELECT sum(i) FROM n' : 'SELECT sum(sin(i)) FROM range(1000000000000) t(i)'
      await enter(page, `SELECT 73 AS retained; ${long};`); await page.getByRole('button', { name: /^Run SQL/ }).click()
      await expect(page.getByRole('cell', { name: '73', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      // SQLite Stop closes its isolated worker/session; DuckDB interrupts in
      // place. Neither path may discard the previously fetched result.
      await expect(page.locator('.status-text')).toHaveText(engine === 'sqlite' ? 'Disconnected' : 'Cancelled')
      if (engine === 'sqlite') await expect(page.locator('.error-banner')).toContainText('Reconnect explicitly')
      await expect(page.getByRole('cell', { name: '73', exact: true })).toBeVisible()
    } finally { await close() }
  })
}

for (const engine of ['sqlite', 'duckdb'] as const) test(`result navigation ${engine}: selected parameter source requires fresh reviewed values`, async () => {
  const { page, directory, close } = await launch()
  try {
    await connect(page, engine)
    const sql = 'SELECT :value AS label'
    await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
    const parameters = page.getByRole('dialog', { name: 'Query parameters', exact: true })
    await parameters.getByLabel('Value for value', { exact: true }).fill('preview binding')
    await parameters.getByRole('button', { name: 'Run with parameters', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    const before = await page.evaluate(() => window.dbCommander.history())
    await enter(page, 'SELECT 999 AS unrelated_buffer')
    await page.getByRole('button', { name: 'Export all rows', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Export all rows', exact: true })
    await expect(review.getByLabel('SQL to execute for export')).toHaveValue(sql)
    const file = join(directory, 'bound.csv'); await review.getByLabel('New export file').fill(file)
    await review.getByRole('checkbox').check(); await review.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(parameters.getByLabel('Parameterized SQL')).toHaveValue(sql)
    await expect(parameters.getByLabel('Value for value', { exact: true })).toHaveValue('')
    await parameters.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(existsSync(file)).toBe(false); expect(await page.evaluate(() => window.dbCommander.transferJobs())).toEqual([])
    await review.getByRole('button', { name: 'Run and export', exact: true }).click()
    await parameters.getByLabel('Value for value', { exact: true }).fill('fresh export binding')
    await parameters.getByRole('button', { name: 'Export with parameters', exact: true }).click()
    await expect(review.getByRole('status')).toHaveText('completed · 1 rows')
    expect(readFileSync(file, 'utf8')).toContain('fresh export binding')
    expect(readFileSync(file, 'utf8')).not.toContain('preview binding')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
  } finally { await close() }
})
