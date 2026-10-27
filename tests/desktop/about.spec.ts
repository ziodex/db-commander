import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'

test('Help About shows the running application version and restores the workbench', async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-about-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await waitForWorkspaceReady(page)
    const version = await app.evaluate(({ app }) => app.getVersion())
    async function openAbout() {
      if (process.platform === 'win32') {
        await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Help', exact: true }).click()
        await page.getByRole('menu', { name: 'Help', exact: true }).getByRole('menuitem', { name: 'About Db Commander', exact: true }).click()
      } else await app.evaluate(({ Menu, BrowserWindow }) => Menu.getApplicationMenu()!.getMenuItemById('about-db-commander')!.click({}, BrowserWindow.getAllWindows()[0], BrowserWindow.getAllWindows()[0].webContents))
    }
    await openAbout()
    const dialog = page.getByRole('dialog', { name: 'About Db Commander', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(`Version ${version}`, { exact: true })).toBeVisible()
    await expect(dialog.getByText(/open-source desktop SQL workbench/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.screenshot({ path: info.outputPath('about-dark.png') })
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible()
    await openAbout(); await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible()
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
