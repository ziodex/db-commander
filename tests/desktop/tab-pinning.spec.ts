import { waitForWorkspaceReady } from './workspace-ready'
import { fileMenu } from './file-menu'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}

test('query tab pinning: group boundaries, close protection, file saves and restart recovery', async ({}, testInfo) => {
  test.setTimeout(120000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-pinning-')), file = join(directory, 'pinned.sql')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow()
    await waitForWorkspaceReady(page)
    await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    // Keep unsaved file buffers in recovery when quitting; never write them implicitly.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox })
    return page
  }
  try {
    let page = await launch()
    const tab = (title: string) => page.getByRole('tab', { name: title, exact: true })
    const order = () => page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    const menu = async (title: string, action: string, nextFocus?: string) => {
      await tab(title).click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: action, exact: true })
      if (!nextFocus) { await item.click(); return }
      // Move focus before a deferred restore. A later keyboard command must
      // still target the newly focused tab when the animation frame settles.
      await item.evaluate((button, nextId) => {
        (button as HTMLButtonElement).click()
        document.getElementById(nextId!)?.focus()
      }, await tab(nextFocus).getAttribute('id'))
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(tab(nextFocus)).toBeFocused()
    }
    await enter(page, 'SELECT first_buffer;')
    await tab('Untitled.sql').focus(); await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Pin tab', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(tab('Untitled.sql')).toHaveAttribute('aria-description', /Pinned/)
    await expect(page.getByRole('button', { name: 'Close Untitled.sql', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'SELECT second_buffer;')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'SELECT third_buffer;')
    await tab('Query 2.sql').click()
    await menu('Query 3.sql', 'Pin tab', 'Query 2.sql')
    await expect.poll(order).toEqual(['Untitled.sql', 'Query 3.sql', 'Query 2.sql'])
    await expect(tab('Query 2.sql')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.monaco-editor')).toContainText('second_buffer')
    await menu('Untitled.sql', 'Move tab to end', 'Query 2.sql')
    await expect.poll(order).toEqual(['Query 3.sql', 'Untitled.sql', 'Query 2.sql'])
    await page.keyboard.press(`${modifier}+Shift+Home`)
    await expect.poll(order).toEqual(['Query 3.sql', 'Untitled.sql', 'Query 2.sql'])
    await tab('Query 2.sql').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move tab left', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await tab('Query 2.sql').dragTo(tab('Query 3.sql'), { targetPosition: { x: 4, y: 12 } })
    await expect.poll(order).toEqual(['Query 3.sql', 'Untitled.sql', 'Query 2.sql'])
    await tab('Untitled.sql').dragTo(tab('Query 3.sql'), { targetPosition: { x: 4, y: 12 } })
    await expect.poll(order).toEqual(['Untitled.sql', 'Query 3.sql', 'Query 2.sql'])
    // Commands pin the active tab, even when the focused context-menu owner was inactive.
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    await page.getByLabel('Search commands').fill('Pin query tab')
    await page.getByRole('dialog', { name: 'Commands' }).getByRole('button', { name: 'Pin query tab', exact: true }).click()
    await expect(page.locator('.query-tab-list .close-tab')).toHaveCount(0)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Close Query 4.sql', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close Query 4.sql', exact: true }).click()
    await page.getByRole('dialog', { name: 'Close query tab' }).getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(tab('Query 4.sql')).toHaveCount(0)
    await menu('Query 3.sql', 'Unpin tab')
    await expect.poll(order).toEqual(['Untitled.sql', 'Query 2.sql', 'Query 3.sql'])
    await tab('Query 3.sql').click()
    await page.getByRole('button', { name: 'Close Query 3.sql', exact: true }).click()
    await page.getByRole('dialog', { name: 'Close query tab' }).getByRole('button', { name: 'Keep tab', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('third_buffer')
    // File association and the stable tab ID survive Save As and dirty recovery.
    await tab('Untitled.sql').click()
    const originalId = await tab('Untitled.sql').getAttribute('id')
    await app!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, file)
    await fileMenu(app!, page, 'Save')
    await expect(tab('pinned.sql')).toHaveAttribute('id', originalId!)
    await expect(tab('pinned.sql')).toHaveAttribute('aria-description', /Pinned/)
    await expect(page.locator('.sql-file-bar')).toContainText('Saved to file')
    expect(readFileSync(file, 'utf8')).toBe('SELECT first_buffer;')
    await enter(page, 'SELECT unsaved_pinned_buffer;')
    await expect(page.locator('.sql-file-bar')).toContainText('Unsaved changes')
    await app!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await page.getByRole('button', { name: 'Open SQL file', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    await expect.poll(order).toEqual(['pinned.sql', 'Query 2.sql', 'Query 3.sql'])
    await expect(page.locator('.monaco-editor')).toContainText('unsaved_pinned_buffer')
    await page.screenshot({ path: testInfo.outputPath('pinned-tabs.png') })
    await app!.close(); app = undefined; page = await launch()
    await expect.poll(order).toEqual(['pinned.sql', 'Query 2.sql', 'Query 3.sql'])
    await expect(tab('pinned.sql')).toHaveAttribute('id', originalId!)
    await expect(tab('pinned.sql')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.monaco-editor')).toContainText('unsaved_pinned_buffer')
    await expect(page.locator('.sql-file-bar')).toContainText('Unsaved changes')
    expect(readFileSync(file, 'utf8')).toBe('SELECT first_buffer;')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    const saved = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(saved?.tabs.map(tab => Boolean(tab.pinned))).toEqual([true, true, false])
    expect(await page.evaluate(() => window.dbCommander.history())).toHaveLength(0)
    await tab('pinned.sql').focus(); await page.keyboard.press('ArrowRight')
    await expect(tab('Query 2.sql')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.monaco-editor')).toContainText('second_buffer')
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    await page.getByLabel('Search commands').fill('Unpin query tab')
    await page.getByRole('dialog', { name: 'Commands' }).getByRole('button', { name: 'Unpin query tab', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Close Query 2.sql', exact: true })).toBeVisible()
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
