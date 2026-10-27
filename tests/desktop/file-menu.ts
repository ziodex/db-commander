import { expect, type ElectronApplication, type Page } from '@playwright/test'

/** Use the application menu on every platform; file actions no longer live in the tab strip. */
export async function fileMenu(app: ElectronApplication, page: Page, label: string) {
  await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
  const owner = await app.browserWindow(page), id = await owner.evaluate(window => window.id)
  await app.evaluate(({ BrowserWindow, Menu }, { id, label }) => {
    const window = BrowserWindow.fromId(id)!
    const item = Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === label)
    if (!item || !item.enabled) throw new Error(`File menu command unavailable: ${label}`)
    item.click({}, window, window.webContents)
  }, { id, label })
}
