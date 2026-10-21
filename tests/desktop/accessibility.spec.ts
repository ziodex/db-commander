import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-keyboard-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    return { app, page, directory }
  } catch (error) { await close(app, directory); throw error }
}
async function close(app: ElectronApplication, directory: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true })
}
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test('keyboard focus stays in the connection dialog and returns to its trigger', async ({}, testInfo) => {
  const { app, page, directory } = await launch()
  try {
    await page.setViewportSize({ width: 1024, height: 700 })
    const trigger = page.getByRole('button', { name: 'Connect database', exact: true })
    await trigger.focus(); await page.keyboard.press('Enter')
    const form = page.getByRole('dialog')
    const first = form.getByRole('button', { name: 'Close connection dialog' })
    // Initial native-engine discovery can temporarily disable the final action.
    // Exercise the enabled form's wrapping once that readiness phase settles.
    await expect(form.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    await first.focus(); await page.keyboard.press('Shift+Tab')
    await expect(form.getByRole('button', { name: 'Connect', exact: true })).toBeFocused()
    await page.keyboard.press('Tab'); await expect(first).toBeFocused()
    await expect(first).toBeInViewport(); await expect(form.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport()
    const before = await page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs.length)
    await page.keyboard.press(`${modifier}+t`)
    expect(await page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs.length)).toBe(before)
    await page.screenshot({ path: testInfo.outputPath('keyboard-connection-dialog.png') })
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0); await expect(trigger).toBeFocused()
  } finally { await close(app, directory) }
})

test('keyboard focus stays in close and delete confirmations without changing saved work', async () => {
  const { app, page, directory } = await launch()
  try {
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    const trigger = page.getByRole('button', { name: 'Close Query 2.sql', exact: true })
    await trigger.focus(); await page.keyboard.press('Enter')
    let dialog = page.getByRole('dialog', { name: 'Close query tab', exact: true })
    await expect(dialog.getByRole('button', { name: 'Keep tab', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Close tab', exact: true })).toBeFocused()
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Keep tab', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Connection name').fill('Keyboard fixture')
    await form.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(form).toHaveCount(0)
    const actions = page.getByRole('button', { name: 'Actions for Keyboard fixture', exact: true })
    await actions.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End')
    const deletion = page.getByRole('menuitem', { name: 'Delete profile Keyboard fixture', exact: true })
    await deletion.focus(); await page.keyboard.press('Enter')
    dialog = page.getByRole('dialog', { name: 'Delete saved profile', exact: true })
    await expect(dialog.getByRole('button', { name: 'Keep profile', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Delete profile', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(actions).toBeFocused()
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles.map(profile => profile.config.name)).toEqual(['Keyboard fixture'])
  } finally { await close(app, directory) }
})

test('keyboard focus follows menu commands into dialogs and back without running SQL', async () => {
  const { app, page, directory } = await launch()
  try {
    const tools = page.getByRole('button', { name: 'Query tools', exact: true })
    await tools.focus(); await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Query tools', exact: true })
    await page.keyboard.press('End'); await page.keyboard.press('Home')
    await expect(menu.locator('[role=menuitem]:not(:disabled)').first()).toBeFocused()
    await page.keyboard.press('Escape'); await expect(tools).toBeFocused()
    const commands = page.getByRole('button', { name: 'Commands', exact: true })
    await commands.focus(); await page.keyboard.press('Enter')
    const palette = page.getByRole('dialog', { name: 'Commands', exact: true })
    await page.keyboard.press(`${modifier}+k`); await expect(palette).toHaveCount(0); await expect(commands).toBeFocused()
    await commands.press('Enter')
    await palette.getByLabel('Search commands').fill('Editor settings'); await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Editor settings', exact: true })
    await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await app.evaluate(({ dialog, BrowserWindow }) => {
      ;(globalThis as any).__backgroundFileDialogs = 0
      dialog.showSaveDialog = async () => { (globalThis as any).__backgroundFileDialogs++; return { canceled: true, filePath: '' } }
      const nativeWindow = BrowserWindow.getAllWindows()[0]; nativeWindow.focus()
      const contents = nativeWindow.webContents, modifiers: Electron.KeyboardInputEvent['modifiers'] = [process.platform === 'darwin' ? 'meta' : 'control']
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers })
    })
    await page.waitForTimeout(100)
    expect(await app.evaluate(() => (globalThis as any).__backgroundFileDialogs)).toBe(0)
    await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0); await expect(commands).toBeFocused()
    await commands.press('Enter'); await page.getByLabel('Search commands').fill('Database backup and restore'); await page.keyboard.press('Enter')
    const backup = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await expect(backup.getByRole('button', { name: 'Close backup dialog' })).toBeFocused()
    await page.keyboard.press('Tab'); await expect(backup.getByRole('button', { name: 'Close backup dialog' })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(backup).toHaveCount(0); await expect(commands).toBeFocused()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app, directory) }
})
