import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableNode } from './explorer-actions'
import { enterWorkspaceSql, resizeWorkspace, waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['sqlite', 'duckdb', 'oracle'] as const) test(`database administration ${engine} reviews native maintenance`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'Native fixture is required')
  const directory = mkdtempSync(resolve(tmpdir(), 'dbcommander-maintenance-'))
  const table = 'A2_' + randomUUID().slice(0, 8).toUpperCase(), index = table + '_IDX'
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(directory, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  const page = await app.firstWindow()
  const dialog = page.getByRole('dialog', { name: /^(Database administration|Table maintenance)$/ })
  const operation = dialog.getByRole('combobox', { name: 'Operation', exact: true })
  const apply = dialog.getByRole('button', { name: 'Apply operation', exact: true })
  async function capture(name: string) {
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return (await window.webContents.capturePage()).resize({ width: window.getContentSize()[0] }).toPNG().toString('base64')
    })
    writeFileSync(info.outputPath(`${engine}-${name}.png`), Buffer.from(png, 'base64'))
  }
  async function run(sql: string) {
    await waitForConnectionIdle(page)
    await enterWorkspaceSql(page, sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await waitForConnectionIdle(page)
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption(engine)
    if (engine === 'oracle') {
      await connection.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_ORACLE_PORT!)
      await connection.getByLabel('Service name', { exact: true }).fill('FREEPDB1')
      await connection.getByLabel('User', { exact: true }).fill('dbcommander')
      await connection.getByLabel('Password', { exact: true }).fill('local-test-only')
    } else {
      await connection.getByLabel('Open mode').selectOption('create')
      await connection.getByLabel('Database file', { exact: true }).fill(join(directory, `local-fixture.${engine}`))
    }
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).toBeHidden()
    if (engine === 'duckdb') await run(`CREATE TABLE ${table}(id int); INSERT INTO ${table} VALUES(42);`)
    else await run(`CREATE TABLE ${table}(id int); INSERT INTO ${table} VALUES(42); CREATE INDEX ${index} ON ${table}(id);`)
    await run(`SELECT id FROM ${table}`)
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    const history = await page.evaluate(() => window.dbCommander.history())

    await resizeWorkspace(app, page, 1440, 900, engine === 'oracle' ? 1.25 : 2)
    const node = engine === 'duckdb' ? page.getByRole('button', { name: 'Switch to database local-fixture', exact: true }) : tableNode(page, table)
    await node.focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: engine === 'duckdb' ? 'Database administration' : `Table maintenance for ${table}`, exact: true }).click()
    await expect(operation).toBeFocused()
    await operation.selectOption(engine === 'duckdb' ? 'checkpoint-database' : engine === 'oracle' ? 'reindex-table' : 'check-table')
    await capture('configure')
    await dialog.getByRole('button', { name: 'Review operation', exact: true }).click()
    const sql = engine === 'duckdb' ? 'CHECKPOINT "local-fixture";' : engine === 'oracle'
      ? `BEGIN\n  EXECUTE IMMEDIATE 'ALTER INDEX "DBCOMMANDER"."${index}" REBUILD';\nEND;`
      : `PRAGMA main.integrity_check('${table}');`
    const confirmation = engine === 'duckdb' ? 'CHECKPOINT DATABASE "local-fixture"' : engine === 'oracle'
      ? `REINDEX TABLE "DBCOMMANDER"."${table}"` : `CHECK TABLE "main"."${table}"`
    await expect(dialog.getByLabel('Reviewed SQL')).toHaveValue(sql)
    await expect(apply).toBeDisabled()
    await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
    await expect(apply).toBeDisabled()
    await dialog.getByLabel('Administration confirmation').fill(confirmation)
    await apply.scrollIntoViewIfNeeded()
    await expect(dialog.locator('#database-administration-target')).toBeInViewport({ ratio: 1 })
    await expect(dialog.locator('#database-administration-target')).toContainText(engine === 'sqlite' ? 'SQLite · main' : engine === 'duckdb' ? 'DuckDB · opened file' : 'Oracle service')
    await capture('confirmation')
    await apply.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name: 'Operation completed', exact: true })).toBeFocused()
    await capture('outcome')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(node).toBeFocused()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
  } finally { try { await app.close() } finally { rmSync(directory, { recursive: true, force: true }) } }
})
