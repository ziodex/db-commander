import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PasswordVault } from '../../src/credentials/vault'

for (const engine of ['mariadb', 'azure-sql'] as const) test(`saved server connections ${engine}: separate profiles, remembered passwords, failed reconnect and restart`, async ({}, info) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Select the real local MariaDB/TDS fixture with the driver runner.')
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-saved-${engine}-`)), ids = new Set<string>(), vault = new PasswordVault(directory)
  const prefix = engine === 'mariadb' ? 'MARIADB' : 'SQLSERVER', password = engine === 'mariadb' ? 'local-test-only' : 'Local-Test-Only!2026'
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined, page: Page, failed = false
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  }
  async function configure(name: string) {
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Connection name', { exact: true }).fill(name)
    await form.getByLabel('Host', { exact: true }).fill('localhost'); await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
    await form.getByLabel('Database', { exact: true }).fill('dbcommander'); await form.getByLabel('User', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill(password)
    await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8'))
    await form.getByLabel('Remember password', { exact: true }).check()
  }
  async function connect() {
    const form = page.getByRole('dialog'); await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Connection settings', exact: true })).toBeEnabled()
    for (const profile of (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles) ids.add(profile.id)
  }
  async function run(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
  }
  try {
    await launch()
    await page!.getByRole('button', { name: 'Connect database', exact: true }).click(); await configure('First saved server'); await connect()
    await run('SELECT 9223372036854775807 AS exact_value;')
    await expect(page!.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    const first = (await page!.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles[0]
    await page!.getByRole('button', { name: 'New connection', exact: true }).click(); await configure('Second saved server'); await connect()
    const second = (await page!.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles
    expect(second).toHaveLength(2); expect(second[0]).toEqual(first)
    await page!.getByRole('button', { name: 'Connection settings', exact: true }).click()
    let form = page!.getByRole('dialog')
    await form.getByLabel('Connection name', { exact: true }).fill('Third saved server')
    await expect(form).toContainText('A new saved connection will be added')
    await form.getByLabel('Password', { exact: true }).fill(password); await connect()
    const saved = (await page!.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles
    expect(saved).toHaveLength(3); expect(saved.slice(0, 2)).toEqual(second)
    expect(saved.every(profile => profile.credential === 'os-store')).toBe(true)
    for (const name of ['First saved server', 'Second saved server', 'Third saved server']) await expect(page!.getByRole('button', { name: `Open ${name} in new tab`, exact: true })).toBeVisible()
    await page!.getByRole('button', { name: 'Open First saved server in new tab', exact: true }).click()
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue(''); await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked(); await connect()
    await run('SELECT 9223372036854775807 AS exact_value;')
    await expect(page!.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    // A bad session-only attempt cannot replace the working saved credential.
    await page!.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page!.getByRole('button', { name: 'Connect database', exact: true }).click()
    await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked()
    const wrong = 'deliberately-wrong-profile-password'
    await form.getByLabel('Password', { exact: true }).fill(wrong); await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form.getByRole('alert')).toBeVisible({ timeout: 30_000 }); await expect(form.getByRole('alert')).not.toContainText(wrong)
    expect((await page!.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles).toEqual(saved)
    await form.getByLabel('Password', { exact: true }).fill(''); await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked(); await connect()
    const beforeRestart = (await page!.evaluate(() => window.dbCommander.loadWorkspace()))!, history = await page!.evaluate(() => window.dbCommander.history())
    expect(beforeRestart.profiles).toEqual(saved); expect(beforeRestart.tabs.find(tab => tab.id === beforeRestart.activeTabId)?.profileId).toBe(first.id)
    await page!.screenshot({ path: info.outputPath(`${engine}-saved-connections.png`) })
    await app!.close(); app = undefined
    for (const name of readdirSync(directory).filter(name => name.startsWith('workspace.sqlite'))) {
      const bytes = readFileSync(join(directory, name))
      for (const secret of [password, wrong]) { expect(bytes.includes(Buffer.from(secret))).toBe(false); expect(bytes.includes(Buffer.from(secret, 'utf16le'))).toBe(false) }
    }
    await launch()
    form = page!.getByRole('dialog')
    const recovered = await page!.evaluate(() => window.dbCommander.loadWorkspace())
    expect(recovered?.profiles).toEqual(saved); expect(recovered?.tabs).toEqual(beforeRestart.tabs)
    await expect(page!.getByRole('button', { name: /^Run SQL/ })).toBeDisabled(); expect(await page!.evaluate(() => window.dbCommander.history())).toEqual(history)
    await page!.getByRole('button', { name: 'Open Second saved server in new tab', exact: true }).click()
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue(''); await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked(); await connect()
    await run('SELECT 9223372036854775807 AS exact_value;'); await expect(page!.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    expect((await page!.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles).toEqual(saved)
    writeFileSync(info.outputPath(`${engine}-saved-connections.json`), JSON.stringify({ engine, server: engine === 'azure-sql' ? 'local SQL Server TDS fixture; not the Azure service' : 'native MariaDB fixture', profileCount: 3, originalIdsRetained: true, storedPasswordReconnect: true, failedPasswordDidNotReplaceSecret: true, restartedWithoutReplay: true, postRestartReconnect: true }, null, 2))
  } catch (error) { failed = true; throw error }
  finally {
    let cleanupError: unknown
    try {
      if (app) await app.evaluate(async ({ app }, { service, ids }) => {
        const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json'), { AsyncEntry } = require('@napi-rs/keyring')
        for (const id of ids) await new AsyncEntry(service, id, { linux: { store: 'secret-service' } }).deleteCredential()
      }, { service: vault.service, ids: [...ids] })
    } catch (error) { cleanupError = error }
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
    if (cleanupError) { if (failed) console.error('Test credential cleanup also failed:', String(cleanupError)); else throw cleanupError }
  }
})
