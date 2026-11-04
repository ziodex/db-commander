import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { engineNames } from '../../src/shared/database-engines'
import { tableNode } from './explorer-actions'
import { enterWorkspaceSql, waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['mysql', 'mariadb'] as const) test(`database administration ${engine} reviews lifecycle and InnoDB maintenance`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'MySQL-family fixture is required')
  const directory = mkdtempSync(resolve(tmpdir(), 'dbcommander-mysql-administration-'))
  const prefix = `SQLCOMMANDER_${engine.toUpperCase()}`
  const config: ConnectionConfig = {
    engine, name: `${engineNames[engine]} administration fixture`, host: 'localhost', port: Number(process.env[`${prefix}_PORT`]),
    database: 'dbcommander', user: 'root', password: 'local-root-test-only', tls: 'verify-full',
    ca: readFileSync(process.env[`${prefix}_CA`]!, 'utf8')
  }
  const database = 'a2_' + randomUUID().slice(0, 8), table = `${database}_table`
  const fixture = await openMysqlTransport(config)
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await fixture.query(`CREATE TABLE ${table}(id int PRIMARY KEY, val int, INDEX idx_val(val)) ENGINE=InnoDB`)
    await fixture.query(`INSERT INTO ${table} VALUES (1, 7)`)
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const desktop = app = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }),
      env: env as Record<string, string>
    })
    const page = await desktop.firstWindow()
    const dialog = page.getByRole('dialog', { name: /^(Database administration|Table maintenance)$/ })
    const operation = dialog.getByRole('combobox', { name: 'Operation', exact: true })
    const apply = dialog.getByRole('button', { name: 'Apply operation', exact: true })
    const databaseNode = (name: string) => page.getByRole('button', { name: `Switch to database ${name}`, exact: true })
    const exists = async () => (await fixture.bound('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY ?', [database])).rows.length === 1
    async function capture(name: string) {
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return (await window.webContents.capturePage()).resize({ width: window.getContentSize()[0] }).toPNG().toString('base64')
      })
      writeFileSync(info.outputPath(`${engine}-${name}.png`), Buffer.from(png, 'base64'))
    }
    async function open(target: Locator, command: string) {
      await waitForConnectionIdle(page)
      await target.focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: command, exact: true }).click()
      await expect(operation).toBeFocused()
    }
    async function confirm(sql: string, confirmation: string, scope: string) {
      await expect(dialog.getByLabel('Reviewed SQL')).toHaveValue(sql)
      await expect(apply).toBeDisabled()
      await dialog.getByLabel('Administration confirmation').fill(confirmation)
      await expect(apply).toBeDisabled()
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await apply.scrollIntoViewIfNeeded()
      await expect(dialog.locator('#database-administration-target')).toBeInViewport({ ratio: 1 })
      await expect(dialog.locator('#database-administration-target')).toContainText(scope)
    }
    async function finish() {
      await apply.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Operation completed', exact: true })).toBeFocused()
    }
    async function dismiss() {
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }

    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption(engine)
    await connection.getByLabel('Port', { exact: true }).fill(String(config.port))
    await connection.getByLabel('Database', { exact: true }).fill(config.database)
    await connection.getByLabel('User', { exact: true }).fill(config.user)
    await connection.getByLabel('Password', { exact: true }).fill(config.password)
    await connection.getByText('Custom CA certificate', { exact: true }).click()
    await connection.getByLabel('CA certificate PEM').fill(config.ca!)
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).toBeHidden()
    await waitForConnectionIdle(page)
    await enterWorkspaceSql(page, 'SELECT 42 AS retained;')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await waitForConnectionIdle(page)
    const history = await page.evaluate(() => window.dbCommander.history())

    await open(databaseNode(config.database), 'Database administration')
    await expect(operation.locator('option')).toHaveText(['Create database'])
    await expect(dialog).toContainText('has no native database rename operation')
    await dialog.getByLabel('New database name', { exact: true }).fill(database)
    await dialog.getByRole('button', { name: 'Review operation', exact: true }).click()
    const quoted = '`' + database + '`'
    const scope = `${engineNames[engine]} server`
    await confirm(`CREATE DATABASE ${quoted};`, `CREATE DATABASE ${quoted}`, scope)
    expect(await exists()).toBe(false)
    await capture('create-confirmation')
    await finish()
    expect(await exists()).toBe(true)
    await dismiss()

    await fixture.query(`CREATE TABLE ${database}.items(id int PRIMARY KEY) ENGINE=InnoDB`)
    await fixture.query(`INSERT INTO ${database}.items VALUES (1)`)
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(512)
    await open(databaseNode(database), 'Database administration')
    await expect(operation.locator('option')).toHaveText(['Create database', 'Drop database'])
    await operation.selectOption('drop-database')
    await dialog.getByRole('button', { name: 'Review operation', exact: true }).click()
    if (engine === 'mariadb') await expect(dialog).toContainText('can leave a partial drop')
    await expect(dialog).toContainText('Grants can remain')
    await confirm(`DROP DATABASE ${quoted};`, `DROP DATABASE ${quoted}`, scope)
    await expect(dialog.locator('#database-administration-target')).toContainText('Permanently deletes data')
    await capture('drop-confirmation-200')
    await finish()
    expect(await exists()).toBe(false)
    await dismiss()

    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1280, 880)
      window.webContents.setZoomFactor(1)
    })
    await page.getByLabel('Filter database objects').fill(table)
    await expect(tableNode(page, table)).toHaveCount(1)
    await open(tableNode(page, table), `Table maintenance for ${table}`)
    await expect(operation.locator('option')).toHaveText(['Update table statistics', 'Optimize table and indexes', 'Check table integrity'])
    await operation.selectOption('optimize-table')
    await dialog.getByRole('button', { name: 'Review operation', exact: true }).click()
    await expect(dialog).toContainText('require additional disk space')
    const target = '`dbcommander`.`' + table + '`'
    await confirm(`OPTIMIZE TABLE ${target};`, `OPTIMIZE TABLE ${target}`, 'Database · dbcommander')
    await capture('optimize-confirmation')
    await finish()
    await expect(dialog).toContainText('server reported OK')
    await capture('optimize-outcome')
    await dismiss()
    expect(await fixture.query(`SELECT val FROM ${table}`)).toEqual([['7']])
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    try {
      await fixture.query(`DROP DATABASE IF EXISTS ${database}`)
      await fixture.query(`DROP TABLE IF EXISTS ${table}`)
    } finally { await fixture.end().catch(() => fixture.destroy()); rmSync(directory, { recursive: true, force: true }) }
  }
})
