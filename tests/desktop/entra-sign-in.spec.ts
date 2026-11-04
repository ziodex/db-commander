import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'

const tenant = '6ae9079a-d895-4ff4-8baf-d7a6959c76d6', client = 'bf41c407-e027-4c2a-95b9-6be2635f30bf'

for (const [theme, zoom] of [['dark', 1.25], ['light', 2]] as const) test(`A4 Entra browser workflow ${theme}: input, sign-in cancellation and connection preservation`, async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'dbc-entra-ui-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: root }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  const page = await app.firstWindow()
  async function capture(name: string) {
    const data = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      return (await contents.capturePage()).toPNG().toString('base64')
    })
    const file = info.outputPath(name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden()
    const input = page.locator('.monaco-editor').first().locator('textarea.inputarea')
    await input.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText('SELECT 37 AS retained_result')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.locator('.results-region')).toContainText('37')

    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    await page.getByRole('dialog').getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(theme)
    await page.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await app.evaluate(({ BrowserWindow }, factor) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1100, 780)
      window.webContents.setZoomFactor(factor)
    }, zoom)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1100 / zoom))

    // Only the Entra IPC response is simulated. The initial database, workspace,
    // connection dialog, renderer and cancellation control are the actual app.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const methods = (ipcMain as unknown as { _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]> })._invokeHandlers
      const original = methods.get('sql:connect')
      if (!original) throw new Error('Expected the normal connection handler.')
      let finish: (() => void) | undefined
      const notify = (waiting: boolean) => BrowserWindow.getAllWindows()[0].webContents.send('sql:entra-sign-in', waiting)
      ipcMain.removeHandler('sql:connect')
      ipcMain.handle('sql:connect', (event, config) => {
        if (config.authentication !== 'entra-interactive') return original(event, config)
        if (config.password || config.accessToken || !config.entra?.tenantId || !config.entra?.clientId) throw new Error('Unexpected credential payload.')
        notify(true)
        return new Promise((_resolve, reject) => {
          finish = () => { notify(false); reject(new Error('Microsoft Entra sign-in was cancelled.')) }
        })
      })
      ipcMain.removeHandler('sql:cancelEntraSignIn')
      ipcMain.handle('sql:cancelEntraSignIn', () => { finish?.(); finish = undefined })
    })
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    await page.getByRole('button', { name: 'Connect to a database', exact: true }).click()
    form = page.getByRole('dialog', { name: 'Connect to SQLite', exact: true })
    await form.getByLabel('Database engine').selectOption('azure-sql')
    form = page.getByRole('dialog', { name: 'Connect to Azure SQL', exact: true })
    await form.getByLabel('Authentication', { exact: true }).selectOption('entra-interactive')
    await form.getByLabel('Host', { exact: true }).fill('fixture.database.windows.net')
    await form.getByLabel('Database', { exact: true }).fill('fixture')
    await form.getByLabel('Directory (tenant) ID').fill(tenant)
    await form.getByLabel('Application (client) ID').fill(client)
    await expect(form.getByLabel('Password', { exact: true })).toHaveCount(0)
    await expect(form.getByLabel('Access token', { exact: true })).toHaveCount(0)
    await expect(form.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport({ ratio: 0.95 })
    await capture('entra-configuration.png')
    await form.getByRole('button', { name: 'Connect', exact: true }).press('Enter')
    await expect(form.getByRole('status')).toContainText('Finish Microsoft Entra sign-in in your browser')
    const cancel = form.getByRole('button', { name: 'Cancel sign-in', exact: true })
    await expect(cancel).toBeInViewport({ ratio: 0.95 })
    await capture('entra-waiting.png')
    await cancel.press('Enter')
    await expect(form.getByRole('alert')).toContainText('sign-in was cancelled')
    await expect(form.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    await capture('entra-cancelled.png')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(form).toBeHidden()
    await expect(page.locator('.results-region')).toContainText('37')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    expect(JSON.stringify(await page.evaluate(() => window.dbCommander.loadWorkspace()))).not.toContain(tenant)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {})
    await app.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
