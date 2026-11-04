import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import pg from 'pg'
import { tableNode } from './explorer-actions'
import { enterWorkspaceSql, waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

test('database administration PostgreSQL reviews lifecycle and table maintenance with native scope', async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('postgres'), 'PostgreSQL fixture is required')
  const directory = mkdtempSync(resolve(tmpdir(), 'dbcommander-administration-'))
  const suffix = randomUUID().slice(0, 8), database = `a2_${suffix}`, renamed = `${database}_renamed`, table = `${database}_table`
  const ca = readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'), port = Number(process.env.SQLCOMMANDER_PG_PORT)
  const fixture = new pg.Client({ host: 'localhost', port, database: 'dbcommander', user: 'dbcommander', password: 'local-test-only', ssl: { ca } })
  await fixture.connect()
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await fixture.query(`CREATE TABLE public.${table}(id int primary key); INSERT INTO public.${table} SELECT generate_series(1, 128)`)
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const desktop = app = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }),
      env: env as Record<string, string>
    })
    const page = await desktop.firstWindow()
    const dialog = page.getByRole('dialog', { name: /^(Database administration|Table maintenance)$/ })
    const apply = dialog.getByRole('button', { name: 'Apply operation', exact: true })
    const choose = dialog.getByRole('combobox', { name: 'Operation', exact: true })
    const review = dialog.getByRole('button', { name: 'Review operation', exact: true })
    const databaseNode = (name: string) => page.getByRole('button', { name: `Switch to database ${name}`, exact: true })
    const exists = async (name: string) => (await fixture.query('SELECT oid FROM pg_database WHERE datname = $1', [name])).rowCount === 1
    async function capture(name: string) {
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return (await window.webContents.capturePage()).resize({ width: window.getContentSize()[0] }).toPNG().toString('base64')
      })
      writeFileSync(info.outputPath(`${name}.png`), Buffer.from(png, 'base64'))
    }
    async function open(target: Locator, item = 'Database administration') {
      await waitForConnectionIdle(page)
      await target.focus()
      await page.keyboard.press('Shift+F10')
      const command = page.getByRole('menuitem', { name: item, exact: true })
      await command.focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible()
      await expect(choose).toBeFocused()
    }
    async function confirm(expected: string, sql: string) {
      await expect(dialog.getByLabel('Reviewed SQL')).toHaveValue(sql)
      await expect(apply).toBeDisabled()
      const confirmation = dialog.getByRole('textbox', { name: 'Administration confirmation' })
      await expect(confirmation).toHaveAccessibleDescription(`Type ${expected} to confirm`)
      await confirmation.fill(expected)
      await expect(apply).toBeDisabled()
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await apply.scrollIntoViewIfNeeded()
      await expect(apply).toBeInViewport({ ratio: 1 })
      await expect(dialog.locator('#database-administration-target')).toBeInViewport({ ratio: 1 })
      await expect(dialog.locator('#database-administration-target')).toContainText(expected.startsWith('ANALYZE TABLE') ? 'Database · dbcommander' : 'PostgreSQL cluster')
      await expect(apply).toBeEnabled()
    }
    async function execute() {
      await apply.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Operation completed' })).toBeFocused()
    }
    async function dismiss() {
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }

    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('postgres')
    await connection.getByLabel('Port', { exact: true }).fill(String(port))
    await connection.getByLabel('Database', { exact: true }).fill('dbcommander')
    await connection.getByLabel('User', { exact: true }).fill('dbcommander')
    await connection.getByLabel('Password', { exact: true }).fill('local-test-only')
    await connection.getByText('Custom CA certificate', { exact: true }).click()
    await connection.getByLabel('CA certificate PEM').fill(ca)
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).toBeHidden()
    await waitForConnectionIdle(page)
    const sql = 'SELECT 42 AS retained;'
    await enterWorkspaceSql(page, sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await waitForConnectionIdle(page)
    const history = await page.evaluate(() => window.dbCommander.history())

    const current = databaseNode('dbcommander')
    await open(current)
    await expect(choose.locator('option')).toHaveText(['Create database'])
    await capture('postgres-create-configure')
    await dialog.getByLabel('New database name').fill('postgres')
    await review.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('alert')).toBeFocused()
    await expect(dialog.getByRole('alert')).toContainText('non-system database name')
    await capture('postgres-preflight-blocked')
    await dialog.getByLabel('New database name').fill(database)
    await review.click()
    await expect(dialog.getByRole('heading', { name: 'Review create database', exact: true })).toBeFocused()
    await expect(dialog).toContainText('outside a transaction block')
    expect(await exists(database)).toBe(false)
    await confirm(`CREATE DATABASE "${database}"`, `CREATE DATABASE "${database}" TEMPLATE template0;`)
    await capture('postgres-create-confirmation')
    await execute()
    expect(await exists(database)).toBe(true)
    await capture('postgres-create-result')
    await dismiss()
    await expect(current).toBeFocused()

    await open(databaseNode(database))
    await expect(choose).toHaveValue('rename-database')
    await dialog.getByLabel('New database name').fill(renamed)
    await review.click()
    await expect(dialog.getByRole('heading', { name: 'Review rename database' })).toBeFocused()
    await confirm(`RENAME DATABASE "${database}" TO "${renamed}"`, `ALTER DATABASE "${database}" RENAME TO "${renamed}";`)
    await execute()
    expect(await exists(database)).toBe(false)
    expect(await exists(renamed)).toBe(true)
    await dismiss()
    await expect(page.getByRole('button', { name: 'Refresh databases', exact: true })).toBeFocused()

    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(512)
    await open(databaseNode(renamed))
    await choose.selectOption('drop-database')
    await review.click()
    await expect(dialog.getByRole('heading', { name: 'Review drop database' })).toBeFocused()
    await expect(dialog).toContainText('Permanently removes the database and its data')
    await capture('postgres-drop-review-dark-200')
    await confirm(`DROP DATABASE "${renamed}"`, `DROP DATABASE "${renamed}";`)
    await expect(dialog.locator('#database-administration-target')).toContainText('Permanently deletes data')
    await capture('postgres-drop-confirmation-dark-200')
    await execute()
    expect(await exists(renamed)).toBe(false)
    await dismiss()
    await expect(page.getByRole('button', { name: 'Refresh databases', exact: true })).toBeFocused()

    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(1.25)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(819)
    await page.getByLabel('Filter database objects').fill(table)
    await expect(tableNode(page, table)).toHaveCount(1)
    await open(tableNode(page, table), `Table maintenance for ${table}`)
    await expect(choose).toHaveValue('analyze-table')
    await capture('postgres-maintenance-configure')
    await review.click()
    await expect(dialog.getByRole('heading', { name: 'Review update table statistics' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Back to operation', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(choose).toBeFocused()
    await review.click()
    await expect(dialog.getByRole('heading', { name: 'Review update table statistics' })).toBeFocused()
    await confirm(`ANALYZE TABLE "public"."${table}"`, `ANALYZE "public"."${table}";`)
    await execute()
    await capture('postgres-maintenance-result')
    await dismiss()
    expect((await fixture.query('SELECT attname FROM pg_stats WHERE schemaname = $1 AND tablename = $2', ['public', table])).rows).toEqual([{ attname: 'id' }])
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    try {
      await fixture.query(`DROP DATABASE IF EXISTS ${database}`)
      await fixture.query(`DROP DATABASE IF EXISTS ${renamed}`)
      await fixture.query(`DROP TABLE IF EXISTS public.${table}`)
    } finally { await fixture.end(); rmSync(directory, { recursive: true, force: true }) }
  }
})
