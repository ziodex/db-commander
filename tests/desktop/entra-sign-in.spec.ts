import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE } from '../../src/shared/contracts'
import type { EntraAttempt, EntraProgress } from '../../src/shared/entra'
import { WorkspaceStore } from '../../src/storage/store'
import { waitForWorkspaceReady } from './workspace-ready'

const tenant = '6ae9079a-d895-4ff4-8baf-d7a6959c76d6', client = 'bf41c407-e027-4c2a-95b9-6be2635f30bf'

for (const [theme, zoom] of [['dark', 1.25], ['light', 2]] as const) test(`A4 Entra browser workflow ${theme}: input, cancellation, renewal and connection preservation`, async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'dbc-entra-ui-'))
  const tabId = randomUUID(), profileId = randomUUID()
  const seed = new WorkspaceStore(join(root, 'workspace.sqlite'))
  seed.save({ version: 2, activeTabId: tabId, tabs: [{ id: tabId, title: 'Untitled.sql', profile: DEFAULT_PROFILE, sql: '' }],
    profiles: [{ id: profileId, config: { ...DEFAULT_PROFILE, name: 'Saved Entra', engine: 'azure-sql',
      host: 'fixture.database.windows.net', port: 1433, database: 'fixture', tls: 'verify-full', user: '',
      authentication: 'entra-interactive', entra: { tenantId: tenant, clientId: client } } }] })
  seed.close()
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
    // Simulate the identity response at IPC while exercising a real packaged
    // window, physical SQLite session, and the native keyboard controls.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const methods = (ipcMain as unknown as { _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]> })._invokeHandlers
      const original = methods.get('sql:connect')
      if (!original) throw new Error('Expected the normal connection handler.')
      let pending: { id: string; finish: (success: boolean) => void } | undefined
      const notify = (attempt: EntraAttempt, phase: EntraProgress['phase']) =>
        BrowserWindow.getAllWindows()[0].webContents.send('sql:entra-sign-in', { ...attempt, phase })
      function simulate(attempt: EntraAttempt) {
        notify(attempt, 'opening')
        return new Promise<void>((resolve, reject) => {
          pending = { id: attempt.id, finish: success => {
            pending = undefined
            if (success) notify(attempt, 'finishing')
            notify(attempt, 'finished')
            if (success) resolve()
            else reject(new Error('Microsoft Entra sign-in was cancelled.'))
          } }
        })
      }
      ipcMain.removeHandler('sql:connect')
      ipcMain.handle('sql:connect', async (event, config) => ({ ...await original(event, config), entraInteractive: true }))
      ipcMain.removeHandler('sql:connectInteractive')
      ipcMain.handle('sql:connectInteractive', (_event, { config, attempt }) => {
        if (config.authentication !== 'entra-interactive' || config.password || config.accessToken ||
          !config.entra?.tenantId || !config.entra?.clientId) throw new Error('Unexpected credential payload.')
        return simulate(attempt)
      })
      ipcMain.removeHandler('sql:cancelEntraSignIn')
      ipcMain.handle('sql:cancelEntraSignIn', (_event, id) => {
        if (!pending || pending.id !== id) throw new Error('Wrong cancellation authority.')
        pending.finish(false)
      })
      ipcMain.removeHandler('sql:renewEntraSession')
      ipcMain.handle('sql:renewEntraSession', (_event, { attempt }) => simulate(attempt))
      ipcMain.handle('fixture:openedBrowser', (_event, surface: EntraAttempt['surface']) => {
        if (!pending) throw new Error('Expected pending authorization.')
        notify({ id: pending.id, surface }, 'browser')
      })
      ipcMain.handle('fixture:finishRenewal', () => {
        if (!pending) throw new Error('Expected pending renewal.')
        pending.finish(true)
      })
    })
    async function signalFixture(name: 'openedBrowser' | 'finishRenewal', surface: EntraAttempt['surface'] = 'workspace') {
      await app.evaluate(({ ipcMain }, { name, surface }) => {
        const methods = (ipcMain as unknown as { _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]> })._invokeHandlers
        const invoke = methods.get(`fixture:${name}`)
        if (!invoke) throw new Error('Expected the fixture handler.')
        Reflect.apply(invoke, undefined, [undefined, surface])
      }, { name, surface })
    }
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
    const application = form.getByLabel('Application (client) ID'), directory = form.getByLabel('Directory (tenant) ID')
    await application.scrollIntoViewIfNeeded()
    for (const field of [application, directory]) {
      expect(await field.evaluate((element: HTMLInputElement) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await expect(field).toBeInViewport({ ratio: 0.9 })
    }
    await capture('entra-configuration.png')
    const connect = form.getByRole('button', { name: 'Connect', exact: true })
    await connect.focus()
    await page.keyboard.press('Enter')
    const cancel = form.getByRole('button', { name: 'Cancel sign-in', exact: true })
    await expect(form.getByRole('status')).toContainText('Opening your browser')
    await expect(cancel).toBeFocused()
    await signalFixture('openedBrowser', 'dialog')
    await expect(form.getByRole('status')).toHaveText('Finish Microsoft Entra sign-in in your browser.')
    await expect(cancel).toBeInViewport({ ratio: 0.95 })
    await capture('entra-waiting.png')
    await page.keyboard.press('Escape')
    await expect(form.getByRole('alert')).toContainText('sign-in was cancelled')
    await expect(connect).toBeFocused()
    await capture('entra-cancelled.png')
    await page.keyboard.press('Escape')
    await expect(form).toBeHidden()
    await expect(page.getByRole('alert', { name: 'Application error' })).toHaveCount(0)
    await expect(page.locator('.results-region')).toContainText('37')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()

    const originalTab = page.getByRole('tab', { name: 'Untitled.sql', exact: true })
    const savedProfile = page.getByRole('button', { name: 'Open Saved Entra in new tab', exact: true })
    const safety = page.getByLabel('Connection authentication', { exact: true })
    const renewal = safety.getByRole('button', { name: 'Renew sign-in', exact: true })
    const cancelRenewal = safety.getByRole('button', { name: 'Cancel sign-in', exact: true })
    await savedProfile.focus()
    await page.keyboard.press('Enter')
    await expect(cancelRenewal).toBeFocused()
    await signalFixture('openedBrowser')
    await expect(safety.getByRole('status')).toHaveText('Finish Microsoft Entra sign-in in your browser.')
    await capture('entra-saved-waiting.png')
    await page.keyboard.press('Enter')
    const warning = page.getByRole('dialog', { name: 'Connection failed', exact: true })
    await expect(warning.getByRole('alert')).toContainText('sign-in was cancelled')
    await page.keyboard.press('Escape')
    await expect(warning).toBeHidden()
    const otherTab = page.locator('.editor-tabs [role=tab][aria-selected=true]')
    const otherTabId = await otherTab.getAttribute('id')
    expect(otherTabId).not.toBe(await originalTab.getAttribute('id'))
    await originalTab.click()
    await expect(page.locator('.results-region')).toContainText('37')

    await renewal.focus()
    await page.keyboard.press('Enter')
    await expect(cancelRenewal).toBeFocused()
    await signalFixture('openedBrowser')
    await expect(safety.getByRole('status')).toHaveText('Finish Microsoft Entra sign-in in your browser.')
    await expect(cancelRenewal).toBeInViewport({ ratio: 0.95 })
    expect(await cancelRenewal.evaluate(button => {
      const parent = button.parentElement!.getBoundingClientRect(), control = button.getBoundingClientRect()
      return control.bottom <= parent.bottom && control.right <= parent.right
    })).toBe(true)
    await capture('entra-renewal-waiting.png')
    await page.locator(`#${otherTabId}`).click()
    await expect(cancelRenewal).toBeVisible()
    await originalTab.click()
    await cancelRenewal.focus()
    await page.keyboard.press('Enter')
    await expect(safety.getByRole('alert')).toContainText('sign-in was cancelled')
    await expect(renewal).toBeFocused()
    await capture('entra-renewal-cancelled.png')
    await page.keyboard.press('Enter')
    await expect(cancelRenewal).toBeFocused()
    await signalFixture('openedBrowser')
    await signalFixture('finishRenewal')
    await expect(safety.getByRole('status')).toHaveText('Microsoft Entra sign-in renewed for new database connections.')
    await expect(renewal).toBeFocused()
    await expect(page.locator('.results-region')).toContainText('37')
    await expect(input).toBeEditable()
    await capture('entra-renewal-success.png')
    const workspace = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(workspace?.profiles.find(profile => profile.id === profileId)?.config.entra).toEqual({ tenantId: tenant, clientId: client })
    expect(JSON.stringify(workspace)).not.toMatch(/"(accessToken|password|refreshToken)"/)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {})
    await app.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
