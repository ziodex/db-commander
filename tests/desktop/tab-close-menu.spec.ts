import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('bulk tab closing uses the context tab, protects pinned and busy tabs, and releases shared connections once', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-close-menu-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  const page = await app.firstWindow()
  const tab = (name: string) => page.getByRole('tab', { name, exact: true })
  const tabs = page.getByRole('tablist', { name: 'Query tabs', exact: true }).getByRole('tab')
  async function menu(name: string, action: string) {
    await tab(name).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Query tab actions', exact: true }).getByRole('menuitem', { name: action, exact: true }).click()
  }
  const newTab = () => page.getByRole('button', { name: 'New query tab', exact: true }).click()
  try {
    await waitForWorkspaceReady(page)
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('sql:disconnect')
      ;(globalThis as any).disconnectCalls = 0
      ipcMain.removeHandler('sql:disconnect')
      ipcMain.handle('sql:disconnect', (event, request) => { (globalThis as any).disconnectCalls++; return original(event, request) })
      const save = (ipcMain as any)._invokeHandlers.get('sql:saveWorkspace')
      const catalog = (ipcMain as any)._invokeHandlers.get('sql:catalogPage')
      const batch = { active: false, savedIntermediate: false, resumeSave() {}, resumeCatalog() {} }
      const saveGate = new Promise<void>(resolve => { batch.resumeSave = resolve })
      const catalogGate = new Promise<void>(resolve => { batch.resumeCatalog = resolve })
      ;(globalThis as any).closeBatch = batch
      ipcMain.removeHandler('sql:saveWorkspace')
      ipcMain.handle('sql:saveWorkspace', async (event, workspace) => {
        const saved = await save(event, workspace)
        if (batch.active && workspace.tabs.length === 2 && workspace.tabs.some((tab: { title: string }) => tab.title === 'Query 3.sql')) {
          batch.savedIntermediate = true
          await saveGate
        }
        return saved
      })
      ipcMain.removeHandler('sql:catalogPage')
      ipcMain.handle('sql:catalogPage', async (event, request) => {
        if (batch.active) await catalogGate
        return catalog(event, request)
      })
    })
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('duckdb')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden(); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    const originalId = await tab('Untitled.sql').getAttribute('id')
    await menu('Untitled.sql', 'Pin tab')
    await newTab(); await newTab(); await newTab()
    await expect(tab('Query 4.sql')).toHaveAttribute('aria-selected', 'true')
    await tab('Query 2.sql').focus(); await page.keyboard.press('Shift+F10')
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('tab-menu-connected.png'), screenshot, 'base64')
    await page.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Close query tabs', exact: true })
    await expect(confirmation).toContainText('Close 2 query tabs?')
    await confirmation.getByRole('button', { name: 'Keep tabs', exact: true }).click()
    await expect(tabs).toHaveCount(4)
    await menu('Query 2.sql', 'Close other tabs')
    await confirmation.getByRole('button', { name: 'Close tabs', exact: true }).click()
    await expect(tabs).toHaveCount(2); await expect(confirmation).toBeHidden()
    await expect(tab('Query 2.sql')).toHaveAttribute('aria-selected', 'true')
    await expect(tab('Untitled.sql')).toHaveAttribute('aria-description', /Pinned/)
    expect(await app.evaluate(() => (globalThis as any).disconnectCalls)).toBe(0)
    await newTab()
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await menu('Untitled.sql', 'Close all tabs')
    await expect(page.getByText(/Query 2.sql: Commit or roll back/)).toBeVisible()
    await expect(tabs).toHaveCount(3); await expect(confirmation).toBeHidden()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByRole('tab', { name: 'Tabs', exact: true }).click()
    await preferences.getByRole('checkbox', { name: 'Confirm before closing a tab', exact: true }).uncheck()
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).toBeHidden()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await app.evaluate(() => { (globalThis as any).closeBatch.active = true })
    await menu('Untitled.sql', 'Close all tabs')
    // Hold the real save acknowledgement after the first release. A catalog
    // read from the intermediate tab would keep the next release blocked.
    await expect.poll(() => app.evaluate(() => (globalThis as any).closeBatch.savedIntermediate)).toBe(true)
    await expect(tab('Query 3.sql')).toHaveAttribute('aria-selected', 'true')
    await app.evaluate(() => (globalThis as any).closeBatch.resumeSave())
    await expect(tabs).toHaveCount(1); await expect(page.getByRole('dialog')).toHaveCount(0)
    await app.evaluate(() => (globalThis as any).closeBatch.resumeCatalog())
    await expect(tab('Untitled.sql')).toHaveAttribute('id', originalId!)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    expect(await app.evaluate(() => (globalThis as any).disconnectCalls)).toBe(0)
    await tab('Untitled.sql').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Close all tabs', exact: true })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Close other tabs', exact: true })).toBeDisabled()
    await page.getByRole('menuitem', { name: 'Unpin tab', exact: true }).click()
    await menu('Untitled.sql', 'Close all tabs')
    await expect(tab('Untitled.sql')).not.toHaveAttribute('id', originalId!)
    await expect(tabs).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await app.evaluate(() => (globalThis as any).disconnectCalls)).toBe(1)
    await expect(tab('Untitled.sql').locator('small')).toHaveText('No connection')
    await expect(tab('Untitled.sql')).toHaveAttribute('aria-description', /No connection/)
    await expect(page.locator('.statusbar .dialect-label')).toHaveText('SQL')
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.reload()
    await expect(tab('Untitled.sql').locator('small')).toHaveText('No connection')
    await expect(page.locator('.statusbar .dialect-label')).toHaveText('SQL')
    const emptyWorkbench = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('empty-workbench.png'), emptyWorkbench, 'base64')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
