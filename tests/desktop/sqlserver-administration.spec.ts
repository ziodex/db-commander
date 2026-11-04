import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Connection, Request, TYPES } from 'tedious'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { engineNames } from '../../src/shared/database-engines'
import { tableNode } from './explorer-actions'
import { enterWorkspaceSql, waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['sqlserver', 'azure-sql'] as const) test(`database administration ${engine} shows master and table scope`, async ({}, info) => {
  test.setTimeout(120_000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlserver'), 'Local TDS fixture is required')
  const profile = mkdtempSync(resolve(tmpdir(), 'dbcommander-sqlserver-administration-'))
  const config: ConnectionConfig = {
    engine, name: `${engineNames[engine]} administration fixture`, host: 'localhost',
    port: Number(process.env.SQLCOMMANDER_SQLSERVER_PORT), database: 'dbcommander',
    user: 'sa', password: 'Local-SA-Only!2026', tls: 'verify-full',
    ca: readFileSync(process.env.SQLCOMMANDER_SQLSERVER_CA!, 'utf8')
  }
  const database = 'a2_' + randomUUID().slice(0, 8), table = `${database}_table`
  const target = `[dbo].[${table}]`
  async function connect(database: string) {
    const client = new Connection({
      server: config.host, authentication: { type: 'default', options: { userName: config.user, password: config.password! } },
      options: { port: config.port, database, encrypt: true, trustServerCertificate: false, cryptoCredentialsDetails: { ca: config.ca }, requestTimeout: 10_000 }
    })
    client.on('error', () => {})
    await new Promise<void>((ok, fail) => client.connect(error => error ? fail(error) : ok()))
    return client
  }
  function query(client: Connection, sql: string, name?: string) {
    return new Promise<number>((ok, fail) => {
      let rows = 0
      const request = new Request(sql, error => error ? fail(error) : ok(rows))
      request.on('row', () => { rows++ })
      if (name !== undefined) { request.addParameter('name', TYPES.NVarChar, name); client.execSql(request) }
      else client.execSqlBatch(request)
    })
  }
  const fixture = await connect(config.database)
  const master = await connect('master')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  const exists = async () => await query(master, 'SELECT name FROM sys.databases WHERE name=@name', database) > 0
  try {
    await query(fixture, `CREATE TABLE ${target}(id int PRIMARY KEY); INSERT INTO ${target} VALUES (1),(2)`)
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: profile }
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
    async function capture(name: string) {
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return (await window.webContents.capturePage()).resize({ width: window.getContentSize()[0] }).toPNG().toString('base64')
      })
      writeFileSync(info.outputPath(`${engine}-${name}.png`), Buffer.from(png, 'base64'))
    }
    async function open(node: Locator, command: string) {
      await waitForConnectionIdle(page)
      await node.focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: command, exact: true }).click()
      await expect(operation).toBeFocused()
    }
    async function approve(sql: string, confirmation: string, scope: string) {
      await expect(dialog.getByLabel('Reviewed SQL')).toHaveValue(sql)
      await expect(apply).toBeDisabled()
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await expect(apply).toBeDisabled()
      await dialog.getByLabel('Administration confirmation').fill(confirmation)
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
    const review = () => dialog.getByRole('button', { name: 'Review operation', exact: true }).click()
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
    if (engine === 'azure-sql') await expect(dialog).toContainText('Reviewed rename and drop are unavailable')
    await dialog.getByLabel('New database name', { exact: true }).fill(database)
    await review()
    await expect(dialog).toContainText('in master')
    const scope = 'SQL Server instance'
    await approve(`CREATE DATABASE [${database}];`, `CREATE DATABASE [${database}]`, scope)
    expect(await exists()).toBe(false)
    await capture('create-confirmation')
    await finish()
    expect(await exists()).toBe(true)
    await dismiss()

    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 900)
      window.webContents.setZoomFactor(2)
    })
    if (engine === 'sqlserver') {
      await open(databaseNode(database), 'Database administration')
      await operation.selectOption('drop-database')
      await review()
      await approve(`DROP DATABASE [${database}];`, `DROP DATABASE [${database}]`, scope)
      await expect(dialog.locator('#database-administration-target')).toContainText('Permanently deletes data')
      await capture('drop-confirmation-200')
      await finish()
      expect(await exists()).toBe(false)
      await dismiss()
    }
    await open(tableNode(page, table), `Table maintenance for ${table}`)
    await operation.selectOption('reindex-table')
    await review()
    await approve(`ALTER INDEX ALL ON ${target} REBUILD;`, `REINDEX TABLE ${target}`, `Database · ${config.database}`)
    await capture('rebuild-confirmation-200')
    await finish()
    await capture('rebuild-outcome-200')
    await dismiss()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
  } finally {
    try { await app?.close() }
    finally {
      try {
        await query(fixture, `DROP TABLE IF EXISTS ${target}`)
        if (await exists()) await query(master, `DROP DATABASE [${database}]`)
      } finally { fixture.close(); master.close(); rmSync(profile, { recursive: true, force: true }) }
    }
  }
})
