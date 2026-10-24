import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function menuKey(app: ElectronApplication, keyCode: string, modifiers: ('alt' | 'control')[] = []) {
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: keyCode === 'Alt' ? ['alt'] : modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, { keyCode, modifiers })
}

test('Windows title bar integrates application menus, native roles and accessible navigation', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Windows uses the integrated title bar; other platforms keep their native menus.')
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-titlebar-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await waitForWorkspaceReady(page)
    const bar = page.getByRole('menubar', { name: 'Application menu' })
    await expect(bar.getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Window', 'Help'])
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
    await expect(page.locator('.titlebar')).toHaveCSS('height', '36px')
    await expect(page.locator('.titlebar')).toHaveCSS('-webkit-app-region', 'drag')
    await expect(bar).toHaveCSS('-webkit-app-region', 'no-drag')

    const editor = page.getByRole('textbox', { name: 'SQL editor' })
    await editor.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('SELECT original_titlebar_sql;')
    await bar.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await page.screenshot({ path: info.outputPath('titlebar-edit-menu.png') })
    await page.getByRole('menu', { name: 'Edit', exact: true }).getByRole('menuitem', { name: /^Select All$/i }).click()
    await page.keyboard.insertText('SELECT replaced_by_native_select_all;')
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())!.tabs[0].sql)).toBe('SELECT replaced_by_native_select_all;')

    await editor.focus(); await menuKey(app, 'F10')
    await expect(bar.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menu', { name: 'File', exact: true })).toBeVisible()
    await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menu', { name: 'Edit', exact: true })).toBeVisible()
    await bar.getByRole('menuitem', { name: 'View', exact: true }).hover()
    await expect(page.getByRole('menu', { name: 'View', exact: true })).toBeVisible()
    await page.keyboard.press('Escape'); await expect(editor).toBeFocused()
    await menuKey(app, 'Alt'); await expect(bar.getByRole('menuitem', { name: 'View', exact: true })).toBeFocused()
    await menuKey(app, 'Alt'); await expect(editor).toBeFocused()
    await menuKey(app, 'f', ['alt']); await expect(page.getByRole('menu', { name: 'File', exact: true })).toBeVisible()
    await page.getByRole('menu', { name: 'File', exact: true }).getByRole('menuitem', { name: 'Recent SQL files…', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Recent SQL files', exact: true })).toBeVisible(); await page.keyboard.press('Escape')

    await bar.getByRole('menuitem', { name: 'View', exact: true }).click()
    await page.getByRole('menu', { name: 'View', exact: true }).getByRole('menuitem', { name: 'Toggle sidebar', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden()
    await menuKey(app, 'b', ['control']); await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)

    await bar.getByRole('menuitem', { name: 'Window', exact: true }).click()
    const traySetting = page.getByRole('menuitemcheckbox', { name: 'Minimize to system tray', exact: true })
    await expect(traySetting).not.toBeChecked(); await traySetting.click()
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!.enabled)).toBe(true)
    await bar.getByRole('menuitem', { name: 'Window', exact: true }).click()
    await expect(traySetting).toBeChecked(); await traySetting.click()

    // State is read from the real menu each time, including dynamically disabled commands.
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('check-for-updates')!.enabled = false })
    await bar.getByRole('menuitem', { name: 'Help', exact: true }).click()
    await expect(page.getByRole('menu', { name: 'Help', exact: true }).getByRole('menuitem')).toBeDisabled()
    const blocked = await page.evaluate(async () => {
      const menus = (await window.dbCommander.applicationMenu())!
      try { await window.dbCommander.executeApplicationMenu(menus.find(item => item.label === 'Help')!.items![0].path); return false } catch { return true }
    })
    expect(blocked).toBe(true); await page.keyboard.press('Escape')
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('check-for-updates')!.enabled = true })

    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await settings.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await settings.getByRole('button', { name: 'Apply settings', exact: true }).click()
      for (const [width, height, zoom] of [[1440, 940, 1], [1024, 700, 1], [1440, 940, 2], [1024, 700, 2]]) {
        await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, height); window.webContents.setZoomFactor(zoom) }, { width, height, zoom })
        for (const name of ['Workspace', 'Toggle sidebar', 'Toggle results', 'Commands']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
        await expect.poll(() => page.locator('.titlebar').evaluate(element => {
          const bar = element.getBoundingClientRect(), controls = (navigator as any).windowControlsOverlay.getTitlebarAreaRect()
          const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
          return { overflow: document.documentElement.scrollWidth > innerWidth, overlap: buttons.some(button => button.right > controls.right || button.left < controls.left), height: Math.round(bar.height), controlsHeight: Math.round(controls.height) }
        })).toEqual({ overflow: false, overlap: false, height: 36, controlsHeight: 36 })
        if (zoom === 2) {
          await bar.getByRole('menuitem', { name: 'Application menu', exact: true }).click()
          await page.getByRole('menu', { name: 'Application menu', exact: true }).getByRole('menuitem', { name: 'File', exact: true }).click()
          await expect(page.getByRole('menu', { name: 'File', exact: true })).toBeVisible()
          await page.screenshot({ path: info.outputPath(`titlebar-menu-${theme}-${width}-${zoom}x.png`) })
          await page.getByRole('menuitem', { name: 'Back to application menu', exact: true }).click()
          await expect(page.getByRole('menu', { name: 'Application menu', exact: true })).toBeVisible()
          await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
        }
        const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
        writeFileSync(info.outputPath(`titlebar-${theme}-${width}-${zoom}x.png`), screenshot, 'base64')
      }
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 940) })
    }
    const fullscreenCommand = await page.evaluate(async () => (await window.dbCommander.applicationMenu())!.find(item => item.label === 'View')!.items!.find(item => item.label === 'Toggle Full Screen')!.path)
    await page.evaluate(path => window.dbCommander.executeApplicationMenu(path), fullscreenCommand)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true)
    for (const name of ['Workspace', 'Toggle sidebar', 'Toggle results', 'Commands']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(path => window.dbCommander.executeApplicationMenu(path), fullscreenCommand)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false)
    // Renderer requests target their owning workspace even when another window has focus.
    const secondWindow = app.waitForEvent('window')
    await page.evaluate(() => window.dbCommander.createWorkspaceWindow('Menu targeting'))
    const secondPage = await secondWindow
    await waitForWorkspaceReady(secondPage)
    await page.evaluate(async () => {
      const file = (await window.dbCommander.applicationMenu())!.find(item => item.label === 'File')!
      await window.dbCommander.executeApplicationMenu(file.items!.find(item => item.label === 'Recent SQL files…')!.path)
    })
    await expect(page.getByRole('dialog', { name: 'Recent SQL files', exact: true })).toBeVisible()
    await expect(secondPage.getByRole('dialog', { name: 'Recent SQL files', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
