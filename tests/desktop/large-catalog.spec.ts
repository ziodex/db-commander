import { _electron as electron, test, expect } from '@playwright/test'
import { DuckDBInstance } from '@duckdb/node-api'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { catalogSeed, catalogTable, LARGE_CATALOG_TABLES } from '../fixtures/large-catalog'
import { tableAction, tableNode } from './explorer-actions'

for (const engine of ['sqlite', 'duckdb'] as const) test(`large catalog ${engine}: bounded explorer, details, filtering and editor response`, async ({}, testInfo) => {
  test.setTimeout(120000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-large-catalog-')), path = join(directory, 'catalog.db')
  // Seed a private file before the app opens it; never open a second descriptor
  // to an active DuckDB file (POSIX locks are process scoped).
  try {
    if (engine === 'sqlite') {
      const db = new DatabaseSync(path)
      try { db.exec(catalogSeed(0, LARGE_CATALOG_TABLES)) } finally { db.close() }
    } else {
      const db = await DuckDBInstance.create(path), client = await db.connect()
      try { await client.runAndReadAll(catalogSeed(0, LARGE_CATALOG_TABLES)) } finally { client.closeSync(); db.closeSync() }
    }
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(), timings: Record<string, number> = {}, last = catalogTable(LARGE_CATALOG_TABLES - 1), key = process.platform === 'darwin' ? 'Meta' : 'Control'
    const refresh = page.getByRole('button', { name: 'Refresh schema', exact: true }), filter = page.getByLabel('Filter database objects')
    const sqlText = () => page.evaluate(async () => { const workspace = await window.dbCommander.loadWorkspace(); return workspace!.tabs.find(tab => tab.id === workspace!.activeTabId)!.sql })
    try {
      await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Connect database', exact: true }).click()
      const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
      await form.getByLabel('Open mode').selectOption('read-write'); await form.getByLabel('Database file').fill(path)
      let start = performance.now(); await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(form).not.toBeVisible(); await expect(refresh).toBeEnabled()
      await expect(tableNode(page, last)).toHaveCount(1); timings.connect = performance.now() - start
      await expect(page.getByText('Schema preview limit reached; some objects or columns are omitted.', { exact: true })).toBeVisible()
      await expect(page.getByText('Catalog limit reached (2,000 objects). Some objects are omitted.', { exact: true })).toBeVisible()
      expect(await page.locator('.schema-object').count()).toBe(LARGE_CATALOG_TABLES)
      const buffer = 'SELECT 42 AS preserved; -- large catalog'
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(buffer); await page.keyboard.press('Escape')
      await expect.poll(sqlText).toBe(buffer)
      const history = await page.evaluate(() => window.dbCommander.history())
      start = performance.now(); await refresh.click(); await expect(refresh).toBeEnabled(); await expect(tableNode(page, last)).toHaveCount(1); timings.refresh = performance.now() - start
      for (let n = 0; n < 3; n++) {
        start = performance.now(); await filter.fill(last); await expect(page.locator('.schema-object')).toHaveCount(1); timings[`filter${n}`] = performance.now() - start
        await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(LARGE_CATALOG_TABLES)
      }
      await filter.fill(last)
      start = performance.now(); await tableAction(page, last, 'Object details'); timings.inspect = performance.now() - start
      const detail = page.getByRole('dialog', { name: 'Object details', exact: true })
      await expect(detail.getByLabel('Object definition')).toHaveValue(new RegExp(last))
      await expect(detail.getByRole('table', { name: 'Columns', exact: true }).getByRole('row')).toHaveCount(9)
      await page.screenshot({ path: testInfo.outputPath(`${engine}-large-catalog-details.png`) })
      await detail.getByRole('button', { name: 'Close object details', exact: true }).click()
      expect(await sqlText()).toBe(buffer); expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(LARGE_CATALOG_TABLES)
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+End`)
      start = performance.now(); await page.keyboard.type(' typing verified', { delay: 10 }); await expect.poll(sqlText).toBe(buffer + ' typing verified'); timings.typing = performance.now() - start
      const source = `SELECT c. FROM ${catalogTable(0)} c`
      await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(source); await page.keyboard.press('Escape')
      await page.keyboard.press('Home'); for (let n = 0; n < 'SELECT c.'.length; n++) await page.keyboard.press('ArrowRight')
      start = performance.now(); await page.keyboard.press('Control+Space')
      await expect(page.locator('.suggest-widget.visible').getByText('label', { exact: true })).toBeVisible(); timings.completion = performance.now() - start
      await page.keyboard.press('Escape'); expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await page.screenshot({ path: testInfo.outputPath(`${engine}-large-catalog-explorer.png`) })
      expect(timings.connect).toBeLessThan(10000); expect(timings.refresh).toBeLessThan(10000); expect(timings.inspect).toBeLessThan(5000)
      for (const name of ['filter0','filter1','filter2','typing','completion']) expect(timings[name], name).toBeLessThan(2000)
    } finally {
      writeFileSync(testInfo.outputPath('large-catalog.json'), JSON.stringify({ engine, tables: LARGE_CATALOG_TABLES, timings }, null, 2))
      await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {})
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
