import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'

test('SQL Server uses Windows Authentication through the connection dialog and saved profiles', async ({}, info) => {
  test.skip(process.platform !== 'win32' || process.env.SQLCOMMANDER_WINDOWS_AUTH_TEST !== '1', 'Requires a SQL Server login for the current Windows account.')
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-windows-auth-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Database engine').selectOption('sqlserver')
    await dialog.getByLabel('Connection name').fill('Windows authentication test')
    await dialog.getByLabel('Host', { exact: true }).fill(process.env.SQLCOMMANDER_WINDOWS_AUTH_HOST ?? 'localhost')
    await dialog.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_WINDOWS_AUTH_PORT ?? '1433')
    await dialog.getByLabel('Database', { exact: true }).fill('master')
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0)
    await expect(dialog.getByLabel('User', { exact: true })).toHaveCount(0)
    await dialog.getByLabel('Transport security').selectOption('disable')
    await page.screenshot({ path: info.outputPath('windows-authentication.png') })
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText('Connection successful. Test connection closed.', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const sql = "SELECT auth_scheme AS windows_auth_scheme FROM sys.dm_exec_connections WHERE session_id=@@SPID;"
    await page.locator('.monaco-editor').click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(sql)
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: /^(NTLM|KERBEROS)$/ })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles.length).toBe(1)
    const workspace = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    expect(workspace.profiles[0].config).toMatchObject({ authentication: 'windows', user: '' })
    expect(workspace.profiles[0].credential).toBeUndefined()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    const connected = await page.evaluate(async () => {
      const profile = (await window.dbCommander.loadWorkspace())!.profiles[0]
      const session = await window.dbCommander.connect({ ...profile.config, password: '' })
      await window.dbCommander.disconnect(session.id)
      return Boolean(session.user)
    })
    expect(connected).toBe(true)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
