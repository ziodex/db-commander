import { profileAction } from './profile-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`connections ${engine}: SSH, folders, favorites, environments and protected tabs`, async ({}, testInfo) => {
  test.setTimeout(180000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(),'dbcommander-profiles-ui-')), env: Record<string,string> = { ...process.env as Record<string,string>, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined, page: Page
  const embedded = ['sqlite','duckdb'].includes(engine), name = 'Protected reporting', key = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function launch() { app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env }); page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible() }
  async function enter(sql: string) { await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape') }
  async function unlock() {
    await page.getByRole('button', { name: 'Unlock connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Unlock protected connection' })
    await dialog.getByLabel('Type connection name').fill('wrong'); await expect(dialog.getByRole('button', { name: 'Unlock this tab', exact: true })).toBeDisabled()
    await dialog.getByLabel('Type connection name').fill(name); await dialog.getByRole('button', { name: 'Unlock this tab', exact: true }).click(); await expect(dialog).not.toBeVisible()
  }
  try {
    await launch(); await page!.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page!.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Connection name', { exact: true }).fill(name)
    await form.getByText('Profile options', { exact: true }).click()
    await form.getByLabel('Profile folder').fill('Team / Reporting'); await form.getByLabel('Environment', { exact: true }).selectOption('production')
    await expect(form.getByLabel('Protect this connection')).toBeChecked(); await expect(form.getByLabel('Protect this connection')).toBeDisabled()
    await form.getByLabel('Favorite profile').check()
    if (embedded) { await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory,'profiles.db')) }
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(String(({ postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, 'azure-sql': 1433, oracle: 2484 } as Record<string,number>)[engine]))
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver','azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
      await form.getByText('SSH tunnel', { exact: true }).click(); await form.getByLabel('Use SSH tunnel').check(); await form.getByLabel('SSH host', { exact: true }).fill('127.0.0.1'); await form.getByLabel('SSH port', { exact: true }).fill(process.env.SQLCOMMANDER_SSH_PORT!)
      await form.getByLabel('SSH user', { exact: true }).fill('tunnel'); await form.getByLabel('SSH host-key fingerprint').fill('SHA256:'+'A'.repeat(43))
      await form.getByLabel('SSH authentication').selectOption('password'); await form.getByLabel('SSH password', { exact: true }).fill('local-ssh-only')
      await form.getByLabel('Database host from SSH server').fill(engine === 'azure-sql' ? 'sqlserver' : engine)
      await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('host key')
      await form.getByLabel('SSH host-key fingerprint').fill(process.env.SQLCOMMANDER_SSH_FINGERPRINT!)
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(page!.getByLabel('Connection safeguards')).toContainText('production'); await expect(page!.getByLabel('Connection safeguards')).toContainText('Protected · Locked')
    if (!embedded) await expect(page!.getByLabel('Connection safeguards')).toContainText('SSH verified')
    await expect(page!.getByRole('button', { name: `Favorite ${name}`, exact: true })).toHaveAttribute('aria-pressed','true')
    await page!.locator('.profile-folder > summary').click(); await expect(page!.getByRole('button', { name: `Open ${name} in new tab`, exact: true })).not.toBeVisible(); await page!.locator('.profile-folder > summary').click()
    await page!.getByRole('button', { name: 'Favorites only', exact: true }).click(); await page!.getByRole('button', { name: `Favorite ${name}`, exact: true }).click(); await expect(page!.getByText('No favorite profiles.', { exact: true })).toBeVisible()
    await page!.getByRole('button', { name: 'Favorites only', exact: true }).click(); await page!.getByRole('button', { name: `Favorite ${name}`, exact: true }).click()
    const sql = engine === 'oracle' ? 'SELECT 42 AS answer FROM dual' : 'SELECT 42 AS answer'
    await enter(sql); await page!.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page!.locator('.error-banner')).toContainText('locked')
    expect(await page!.evaluate(() => window.dbCommander.history())).toHaveLength(0)
    await unlock(); await page!.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page!.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await page!.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page!.locator('.status-text')).toHaveText('Connected')
    await expect(page!.getByLabel('Connection safeguards')).toContainText('Protected · Locked')
    await page!.getByRole('tab', { name: 'Untitled.sql', exact: true }).click(); await expect(page!.getByLabel('Connection safeguards')).toContainText('Unlocked')
    await expect(page!.getByRole('button', { name: 'Begin', exact: true })).toBeEnabled(); await page!.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page!.locator('.transaction-badge')).toHaveText('In transaction')
    await page!.getByRole('button', { name: 'Lock connection', exact: true }).click(); await page!.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page!.locator('.transaction-badge')).toHaveText(engine === 'oracle' ? 'Manual commit mode' : 'Autocommit')
    await page!.screenshot({ path: testInfo.outputPath(`${engine}-protected-profile.png`) })
    await expect(page!.getByText('Saved locally', { exact: true })).toBeVisible()
    const saved = await page!.evaluate(() => window.dbCommander.loadWorkspace())
    expect(saved!.profiles[0].config).toMatchObject({ folder: 'Team / Reporting', favorite: true, environment: 'production' })
    expect(JSON.stringify(saved)).not.toMatch(/local-ssh-only|local-test-only|local-key-passphrase|sshSecrets|unlockedUntil/)
    await app!.close(); app = undefined
    for (const file of readdirSync(directory).filter(file => file.startsWith('workspace.sqlite'))) expect(readFileSync(join(directory,file)).toString('utf8')).not.toMatch(/local-ssh-only|local-test-only|local-key-passphrase/)
    await launch()
    await expect(page!.getByRole('button', { name: `Open ${name} in new tab`, exact: true })).toBeVisible(); await expect(page!.getByRole('button', { name: `Favorite ${name}`, exact: true })).toHaveAttribute('aria-pressed','true')
    await profileAction(page!, `${name}`, 'Edit')
    const edit = page!.getByRole('dialog'); await expect(edit.getByLabel('Profile folder')).toHaveValue('Team / Reporting'); await expect(edit.getByLabel('Environment', { exact: true })).toHaveValue('production')
    if (!embedded) { await expect(edit.getByLabel('SSH password', { exact: true })).toHaveValue(''); await expect(edit.getByLabel('SSH host-key fingerprint')).toHaveValue(process.env.SQLCOMMANDER_SSH_FINGERPRINT!) }
    await edit.getByLabel('Profile folder').fill('Operations'); await edit.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(edit).not.toBeVisible()
    await expect(page!.locator('.profile-folder > summary')).toContainText('Operations')
    if (embedded) { await page!.getByRole('button', { name: `Open ${name} in new tab`, exact: true }).click(); await expect(page!.locator('.status-text')).toHaveText('Connected'); await expect(page!.getByLabel('Connection safeguards')).toContainText('Protected · Locked') }
  } finally { await app?.close(); rmSync(directory,{ recursive: true, force: true }) }
})
