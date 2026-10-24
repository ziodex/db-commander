import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await ready(page)
    // Observe real native tray instances/menu callbacks without exposing a test IPC API.
    await app.evaluate(({ Tray }) => {
      const original = Tray.prototype.setContextMenu
      Tray.prototype.setContextMenu = function(menu) {
        Object.assign(globalThis, { observedTray: this, observedTrayMenu: menu })
        return original.call(this, menu)
      }
    })
    return { app, page }
  } catch (error) { await close(app); throw error }
}
async function ready(page: Page) {
  await waitForWorkspaceReady(page)
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
}
async function close(app?: ElectronApplication) {
  if (!app) return
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const within = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([stopped.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  // A failed Playwright close can have already disconnected its main-process
  // debugger. Keep teardown bounded and retain ownership of this launch only.
  void app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  if (await within(3000)) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (!await within(5000)) throw new Error('The owned tray test application did not exit; its profile is retained.')
}
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').first().click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)).toBe(sql)
}
async function toggle(app: ElectronApplication, enabled: boolean) {
  await app.evaluate(({ Menu, BrowserWindow }, enabled) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!
    if (item.checked !== enabled) item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as any)
  }, enabled)
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!.enabled)).toBe(true)
}
async function checked(app: ElectronApplication) { return app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!.checked) }
async function trayCommand(app: ElectronApplication, id: string) {
  await app.evaluate(({ BrowserWindow }, id) => {
    const item = (globalThis as any).observedTrayMenu.getMenuItemById(id)
    item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {})
  }, id)
}

test('system tray is opt-in, restores buffers and sessions, and persists across restart', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-tray-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    expect(await checked(app)).toBe(false)
    let native = await app.browserWindow(page)
    await native.evaluate(window => window.minimize())
    await expect.poll(() => native.evaluate(window => window.isMinimized())).toBe(true)
    await native.evaluate(window => { window.restore(); window.show() })
    await toggle(app, true); expect(await checked(app)).toBe(true)
    expect(JSON.parse(readFileSync(join(directory, 'desktop-settings.json'), 'utf8'))).toEqual({ minimizeToTray: true })
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const sql = 'create temp table tray_data(n integer); insert into tray_data values(42); select n from tray_data;'
    await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    const history = await page.evaluate(() => window.dbCommander.history())
    await native.evaluate(window => window.minimize())
    await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
    await trayCommand(app, 'tray-show')
    await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await enter(page, 'select n from tray_data;'); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('restored-workspace.png') })
    await test.step('Quit through the tray before restarting the persisted workspace', async () => {
      await Promise.all([app!.waitForEvent('close', { timeout: 10000 }), trayCommand(app!, 'tray-quit')])
    }); app = undefined
    launched = await test.step('Restart the same profile', () => launch(directory))
    app = launched.app; page = launched.page; native = await app.browserWindow(page)
    expect(await checked(app)).toBe(true)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe('select n from tray_data;')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
    await app.evaluate(({ app }) => app.emit('activate'))
    await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
    await toggle(app, false); expect(await checked(app)).toBe(false)
    await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isMinimized())).toBe(true)
    await native.evaluate(window => window.restore())
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

test('system tray restores individual workspaces, survives renderer recovery and closes normally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-tray-windows-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const primary = launched.page
    await toggle(app, true); expect(await checked(app)).toBe(true)
    const created = app.waitForEvent('window'); await primary.evaluate(() => window.dbCommander.createWorkspaceWindow('Tray analysis'))
    let secondary = await created; await ready(secondary)
    await enter(primary, 'select primary_tray_buffer;'); await enter(secondary, 'select secondary_tray_buffer;')
    const first = await app.browserWindow(primary); let second = await app.browserWindow(secondary)
    await first.evaluate(window => window.minimize()); await second.evaluate(window => window.minimize())
    await expect.poll(() => first.evaluate(window => window.isVisible())).toBe(false); await expect.poll(() => second.evaluate(window => window.isVisible())).toBe(false)
    const secondId = await second.evaluate(window => window.id)
    await trayCommand(app, `tray-window-${secondId}`)
    await expect.poll(() => second.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    expect(await first.evaluate(window => window.isVisible())).toBe(false)
    await trayCommand(app, 'tray-show-all'); await expect.poll(() => first.evaluate(window => window.isVisible())).toBe(true)
    // The replacement renderer/window must get the same minimize behavior and one menu entry.
    const recovered = app.waitForEvent('window'); await second.evaluate(window => window.webContents.forcefullyCrashRenderer())
    secondary = await recovered; await ready(secondary); second = await app.browserWindow(secondary)
    await expect(secondary.locator('.error-banner')).toContainText('recovered')
    const newId = await second.evaluate(window => window.id)
    const ids = await app.evaluate(() => (globalThis as any).observedTrayMenu.items.map((item: any) => item.id))
    expect(ids).not.toContain(`tray-window-${secondId}`); expect(ids).toContain(`tray-window-${newId}`)
    await second.evaluate(window => window.minimize()); await expect.poll(() => second.evaluate(window => window.isVisible())).toBe(false)
    await trayCommand(app, `tray-window-${newId}`)
    await second.evaluate(window => window.close()); await expect.poll(() => secondary.isClosed()).toBe(true)
    expect(primary.isClosed()).toBe(false)
    const exited = app.waitForEvent('close'); await trayCommand(app, 'tray-quit'); await exited; app = undefined
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

test('system tray quit honors transaction cancellation and failed preference writes keep windows reachable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-tray-guards-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args: any[]) => { (globalThis as any).lastTrayPrompt = args.at(-1); return { response: 0, checkboxChecked: false } } })
    mkdirSync(join(directory, 'desktop-settings.json'))
    await toggle(app, true); expect(await checked(app)).toBe(false)
    expect(await app.evaluate(() => (globalThis as any).observedTray.isDestroyed())).toBe(true)
    expect(await app.evaluate(() => (globalThis as any).lastTrayPrompt.message)).toContain('not changed')
    rmSync(join(directory, 'desktop-settings.json'), { recursive: true })
    await toggle(app, true); expect(await checked(app)).toBe(true)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await enter(page, 'begin; create table tray_transaction(n integer); insert into tray_transaction values(7);')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const native = await app.browserWindow(page); await native.evaluate(window => window.minimize())
    await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
    // A failed disable retains both the preference and a working restore menu.
    rmSync(join(directory, 'desktop-settings.json')); mkdirSync(join(directory, 'desktop-settings.json'))
    await toggle(app, false); expect(await checked(app)).toBe(true)
    expect(await app.evaluate(() => (globalThis as any).observedTray.isDestroyed())).toBe(false)
    await trayCommand(app, 'tray-quit')
    await expect.poll(() => app!.evaluate(() => (globalThis as any).lastTrayPrompt.title)).toBe('Close database sessions?')
    await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    // OS/application-menu Quit also makes a hidden window's guard reachable.
    await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
    await app.evaluate(({ app }) => { (globalThis as any).lastTrayPrompt = undefined; app.quit() })
    await expect.poll(() => app!.evaluate(() => (globalThis as any).lastTrayPrompt?.title)).toBe('Close database sessions?')
    await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
    await enter(page, 'select n from tray_transaction;'); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    const exited = app.waitForEvent('close'); await trayCommand(app, 'tray-quit'); await exited; app = undefined
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})
