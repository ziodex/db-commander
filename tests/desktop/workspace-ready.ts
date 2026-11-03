import { expect, type Page } from '@playwright/test'

/** Native workspace initialization can outlast ordinary UI assertions on hosted
 * Windows runners. Keep this allowance at startup, not on later UI actions. */
export async function waitForWorkspaceReady(page: Page) {
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 30000 })
}

export async function waitForConnectionIdle(page: Page) {
  // The next catalog search is pending before it reserves the connection.
  await expect(page.locator('.catalog-results').getByRole('status')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}

export async function enterWorkspaceSql(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor'), input = editor.locator('textarea.inputarea')
  await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  // Monaco virtualizes wrapped lines; the native keystrokes must reach the
  // complete persisted buffer, including lines outside its current viewport.
  await expect.poll(async () => { const value = await page.evaluate(() => window.dbCommander.loadWorkspace()); return value?.tabs.find(tab => tab.id === value.activeTabId)?.sql }).toBe(sql)
}
