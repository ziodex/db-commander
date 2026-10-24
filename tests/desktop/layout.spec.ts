import { waitForWorkspaceReady } from './workspace-ready'
import { tableAction } from './explorer-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    // macOS constrains a newly created window to the runner's small display.
    // Set the test's initial size explicitly before asserting resize deltas.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
    await waitForWorkspaceReady(page)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1024)
    return { app, page }
  } catch (error) { await forceClose(app); throw error }
}
// Chromium's CDP keyboard API bypasses Electron's menu/before-input-event path.
async function shortcut(app: ElectronApplication, keyCode: string, extra: ('shift' | 'alt')[] = []) {
  const modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> = [process.platform === 'darwin' ? 'meta' : 'control', ...extra]
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, { keyCode, modifiers })
}
async function drag(app: ElectronApplication, page: Page, splitter: Locator, x: number, y: number, cancel = false) {
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  const box = (await splitter.boundingBox())!
  // Native hover events can interrupt a CDP drag with buttons=0 and release
  // pointer capture. Queue the complete gesture through Electron's input path.
  await app.evaluate(({ BrowserWindow }, { startX, startY, x, y, cancel }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY })
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: startX, y: startY })
    for (let step = 1; step <= 8; step++) contents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftbuttondown'], x: Math.round(startX + x * step / 8), y: Math.round(startY + y * step / 8) })
    if (cancel) {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    }
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: startX + x, y: startY + y })
  }, { startX: Math.round(box.x + box.width / 2), startY: Math.round(box.y + box.height / 2), x, y, cancel })
  await expect(splitter).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.body.dataset.resizing)).toBeUndefined()
}
async function size(locator: Locator, axis: 'width' | 'height') { return Math.round((await locator.boundingBox())![axis]) }
async function savedLayout(page: Page) { return page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.layout) }
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function forceClose(app?: ElectronApplication) {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {})
}

test('layout mouse and keyboard resizing, native View commands and panel visibility', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-layout-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' }), results = page.getByRole('region', { name: 'Execution output' })
    const vertical = page.getByRole('separator', { name: 'Resize sidebar' }), horizontal = page.getByRole('separator', { name: 'Resize results' })
    await expect(vertical).toHaveAttribute('aria-orientation', 'vertical'); await expect(horizontal).toHaveAttribute('aria-orientation', 'horizontal')
    expect(await size(sidebar, 'width')).toBe(234); expect(await size(results, 'height')).toBe(320)
    // Native pointer completion precedes React's render of continuous-event updates.
    await drag(app, page, vertical, 90, 0); await expect.poll(() => size(sidebar, 'width')).toBe(324)
    // macOS can cap native window height to the display. Start below the limit
    // so this gesture tests its full delta, independently of clamping.
    await horizontal.focus(); await page.keyboard.press('Home'); expect(await size(results, 'height')).toBe(240)
    await drag(app, page, horizontal, 0, -60); await expect.poll(() => size(results, 'height')).toBe(300)
    await drag(app, page, vertical, 55, 0, true); await expect.poll(() => size(sidebar, 'width')).toBe(324)
    await vertical.focus(); await page.keyboard.press('ArrowRight'); expect(await size(sidebar, 'width')).toBe(334)
    await page.keyboard.press('Shift+ArrowLeft'); expect(await size(sidebar, 'width')).toBe(284)
    await page.keyboard.press('Home'); expect(await size(sidebar, 'width')).toBe(200)
    await page.keyboard.press('End'); expect(await size(sidebar, 'width')).toBe(Number(await vertical.getAttribute('aria-valuemax')))
    await vertical.dblclick(); expect(await size(sidebar, 'width')).toBe(234)
    await horizontal.focus(); await page.keyboard.press('ArrowUp'); expect(await size(results, 'height')).toBe(310)
    await page.keyboard.press('Home'); expect(await size(results, 'height')).toBe(240)
    await page.keyboard.press('End'); expect(await size(results, 'height')).toBe(Number(await horizontal.getAttribute('aria-valuemax')))
    await horizontal.dblclick(); expect(await size(results, 'height')).toBe(320)
    // Real shortcuts must work while Monaco, a splitter, or a result control owns focus.
    await enter(page, 'SELECT layout_keyboard;')
    await shortcut(app, 'B'); await expect(sidebar).toBeHidden(); await expect(vertical).toHaveCount(0)
    await shortcut(app, 'J'); await expect(results).toBeHidden()
    await shortcut(app, 'B'); await expect(sidebar).toBeVisible()
    await shortcut(app, 'J'); await expect(results).toBeVisible()
    await expect(page.locator('.monaco-editor')).toContainText('SELECT layout_keyboard;')
    await horizontal.focus(); await page.keyboard.press('Enter'); await expect(results).toBeHidden()
    await expect(page.getByRole('button', { name: 'Toggle results', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Toggle results', exact: true }).click()
    await page.getByRole('button', { name: 'Maximize results', exact: true }).click(); await expect(page.locator('#query-panel')).toBeHidden()
    await expect(horizontal).toHaveCount(0)
    await shortcut(app, 'J', ['shift']); await expect(page.locator('#query-panel')).toBeVisible()
    expect(await size(results, 'height')).toBe(320)
    await page.getByRole('button', { name: 'Hide results', exact: true }).click(); await expect(results).toBeHidden()
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click(); await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Query history', exact: true }).click(); await expect(sidebar).toBeVisible()
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    await page.getByRole('button', { name: 'Reset layout (Cmd/Ctrl+Alt+0)', exact: true }).click()
    await expect(results).toBeVisible(); expect(await size(sidebar, 'width')).toBe(234)
    const menu = await app.evaluate(({ Menu }) => ['toggle-sidebar', 'toggle-results', 'maximize-results', 'reset-layout'].map(id => {
      const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
      return { id: item.id, accelerator: item.accelerator }
    }))
    expect(menu.map(item => item.accelerator)).toEqual(['CommandOrControl+B', 'CommandOrControl+J', 'CommandOrControl+Shift+J', 'CommandOrControl+Alt+0'])
    // Supply the native menu's window argument. CDP interaction need not give
    // the application OS focus, and a menu must retain its original target.
    await app.evaluate(({ Menu, BrowserWindow }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('toggle-sidebar')!; item.click(item, BrowserWindow.getAllWindows()[0], {} as any) })
    await expect(sidebar).toBeHidden()
    await shortcut(app, '0', ['alt']); await expect(sidebar).toBeVisible()
    await expect.poll(() => savedLayout(page)).toEqual({ sidebarVisible: true, sidebarWidth: 234, resultsVisible: true, resultsHeight: 320, resultsMaximized: false })
    await page.screenshot({ path: testInfo.outputPath('layout-controls.png') })
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})

test('layout persists through immediate quit and renderer recovery and fits smaller windows', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-layout-recovery-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    const originalBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    await enter(page, '-- preserve buffer and layout\nSELECT 42;')
    await page.getByRole('separator', { name: 'Resize sidebar' }).focus(); await page.keyboard.press('End')
    // Widening the sidebar can wrap the toolbar. Wait for ResizeObserver to
    // update the results limit before choosing the maximum preferred height.
    await expect.poll(() => page.evaluate(() => {
      const panes = document.querySelector<HTMLElement>('.query-panes')!
      const splitter = document.querySelector<HTMLElement>('[aria-label="Resize results"]')!
      return Number(splitter.getAttribute('aria-valuemax')) === Math.floor(panes.clientHeight - splitter.offsetHeight - 160)
    })).toBe(true)
    await page.getByRole('separator', { name: 'Resize results' }).focus(); await page.keyboard.press('End')
    const preferred = { sidebarWidth: await size(page.locator('.sidebar'), 'width'), resultsHeight: await size(page.locator('.results-region'), 'height') }
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'Toggle results', exact: true }).click()
    await app.close(); app = undefined // Quit must flush changes before the debounce runs.
    launched = await launch(directory); app = launched.app; page = launched.page
    await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('.results-region')).toBeHidden()
    await expect(page.locator('.monaco-editor')).toContainText('preserve buffer and layout')
    expect(await savedLayout(page)).toMatchObject({ ...preferred, sidebarVisible: false, resultsVisible: false })
    await shortcut(app, 'B'); await shortcut(app, 'J')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
    await expect.poll(() => size(page.locator('.sidebar'), 'width')).toBeLessThan(preferred.sidebarWidth)
    // Shrinking width may also unwrap the toolbar, leaving enough vertical room
    // for the preferred height. Assert the actual available-height clamp.
    await expect.poll(async () => await size(page.locator('.results-region'), 'height') - Math.min(preferred.resultsHeight, Number(await page.getByRole('separator', { name: 'Resize results' }).getAttribute('aria-valuemax')))).toBe(0)
    expect(await size(page.locator('.editor-region'), 'height')).toBeGreaterThanOrEqual(160)
    expect(await size(page.locator('.results-region'), 'height')).toBeGreaterThanOrEqual(240)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true)
    expect(await savedLayout(page)).toMatchObject(preferred)
    await drag(app, page, page.getByRole('separator', { name: 'Resize sidebar' }), -60, 0, true)
    await drag(app, page, page.getByRole('separator', { name: 'Resize results' }), 0, 60, true)
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect(await savedLayout(page)).toMatchObject(preferred)
    await page.screenshot({ path: testInfo.outputPath('layout-small-window.png') })
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), originalBounds)
    await expect.poll(() => size(page.locator('.sidebar'), 'width')).toBe(preferred.sidebarWidth)
    await expect.poll(() => size(page.locator('.results-region'), 'height')).toBe(preferred.resultsHeight)
    await shortcut(app, 'B'); await shortcut(app, 'J', ['shift'])
    await expect.poll(() => savedLayout(page)).toMatchObject({ sidebarVisible: false, resultsVisible: true, resultsMaximized: true })
    const newWindow = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await newWindow
    await waitForWorkspaceReady(page)
    await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('#query-panel')).toBeHidden()
    await expect(page.getByRole('region', { name: 'Execution output' })).toBeVisible()
    await page.getByRole('button', { name: 'Restore editor and results', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('preserve buffer and layout')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})

test('layout preserves DuckDB results, running queries, grid drafts and transactions', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-layout-data-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('duckdb'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await run(page, "CREATE TABLE layout_data(id INTEGER PRIMARY KEY, label VARCHAR); INSERT INTO layout_data VALUES(1,'original');")
    await run(page, 'SELECT * FROM layout_data;')
    await expect(page.getByRole('cell', { name: 'original', exact: true })).toBeVisible()
    await page.getByRole('cell', { name: 'original', exact: true }).focus(); await shortcut(app, 'J')
    await expect(page.locator('.results-region')).toBeHidden(); await expect(page.getByRole('button', { name: 'Toggle results', exact: true })).toBeFocused()
    await shortcut(app, 'J'); await expect(page.getByRole('cell', { name: 'original', exact: true })).toBeVisible()
    await tableAction(page, 'layout_data', 'Edit data')
    await page.getByLabel('Row 1 label', { exact: true }).fill('staged survives hiding')
    await shortcut(app, 'J'); await expect(page.locator('.results-region')).toBeHidden()
    await shortcut(app, 'B'); await expect(page.locator('.sidebar')).toBeHidden()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Connected')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await shortcut(app, 'J', ['shift'])
    await expect(page.getByLabel('Row 1 label', { exact: true })).toHaveValue('staged survives hiding')
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await shortcut(app, 'J'); await expect(page.locator('.results-region')).toBeHidden()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await shortcut(app, 'J'); await shortcut(app, 'B')
    await run(page, 'SELECT label FROM layout_data;'); await expect(page.getByRole('cell', { name: 'original', exact: true })).toBeVisible()
    await enter(page, 'SELECT sum(sin(i)) FROM range(1000000000) AS t(i);')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Running')
    await shortcut(app, 'J'); await expect(page.locator('.results-region')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await shortcut(app, 'J')
    await run(page, 'SELECT i FROM range(1000) AS t(i);')
    const grid = page.getByRole('table', { name: 'Query results' })
    await grid.evaluate(element => { element.scrollTop = 8000 })
    await page.getByRole('button', { name: 'Maximize results', exact: true }).click()
    await expect.poll(() => grid.getByRole('row').count()).toBeGreaterThan(20)
    await page.getByRole('button', { name: 'Restore editor and results', exact: true }).click()
    expect(await grid.evaluate(element => element.scrollTop)).toBeGreaterThan(7000)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('SELECT i FROM range(1000) AS t(i);')
    await expect.poll(() => page.locator('.monaco-editor').evaluate(element => Math.abs(element.clientWidth - document.getElementById('query-panel')!.clientWidth))).toBeLessThan(2)
    await page.screenshot({ path: testInfo.outputPath('layout-retained-results.png') })
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})
