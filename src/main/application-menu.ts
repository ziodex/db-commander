import { Menu, type BrowserWindow, type MenuItem, type Input } from 'electron'
import type { ApplicationMenuItem, TitleBarAppearance } from '../shared/application-menu'

export const windowsTitleBar = { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#191a1b', symbolColor: '#cccccc', height: 36 }, autoHideMenuBar: true }

export function applicationMenu(): ApplicationMenuItem[] | null {
  if (process.platform !== 'win32') return null
  function items(menu: Menu, parent = ''): ApplicationMenuItem[] {
    return menu.items.flatMap((item, index) => {
      if (!item.visible || item.type === 'header' || item.type === 'palette') return []
      const path = parent ? `${parent}/${index}` : String(index)
      return [{ path, label: item.label.replace(/&/g, ''), enabled: item.enabled, type: item.type, checked: item.checked,
        accelerator: item.accelerator?.toString().replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl'),
        ...(item.submenu ? { items: items(item.submenu, path) } : {}) }]
    })
  }
  const menu = Menu.getApplicationMenu()
  return menu ? items(menu) : []
}

export function executeApplicationMenu(window: BrowserWindow, path: string): void {
  let menu = Menu.getApplicationMenu(), item: MenuItem | undefined
  for (const index of path.split('/').map(Number)) {
    item = menu?.items[index]
    if (!item || !item.visible || !item.enabled) throw new Error('This menu command is unavailable.')
    menu = item.submenu ?? null
  }
  if (!item || item.submenu || item.type === 'separator' || item.type === 'header' || item.type === 'palette') throw new Error('Choose a menu command.')
  // Use the original item so native roles, checkbox state and owning-window
  // callbacks follow exactly the same path as accelerators and the OS menu.
  item.click({}, window, window.webContents)
}

export function updateTitleBar(window: BrowserWindow, appearance: TitleBarAppearance): void {
  if (process.platform !== 'win32') return
  const light = appearance === 'light'
  window.setTitleBarOverlay({ color: light ? '#ffffff' : '#191a1b', symbolColor: light ? '#243442' : '#cccccc', height: Math.round(36 * window.webContents.getZoomFactor()) })
}

export function installMenuKeys(window: BrowserWindow): void {
  if (process.platform !== 'win32') return
  let altOnly = false
  window.webContents.on('before-input-event', (event, input: Input) => {
    if (input.key === 'Alt' && !input.control && !input.meta) {
      // Cancelling Alt's keydown also suppresses its keyup on Windows. Cancel
      // the release instead, before Electron reveals its separate native menu.
      if (input.type === 'keyDown') { if (!input.isAutoRepeat) altOnly = !input.shift }
      else { event.preventDefault(); if (altOnly) { altOnly = false; window.webContents.send('sql:application-menu-key', null) } }
      return
    }
    if (input.type !== 'keyDown') return
    altOnly = false
    if (input.control || input.meta || input.shift || input.isAutoRepeat) return
    if (input.key === 'F10') { event.preventDefault(); window.webContents.send('sql:application-menu-key', null); return }
    if (input.alt) {
      const index = Menu.getApplicationMenu()?.items.findIndex(item => item.label.replace(/&/g, '').toLowerCase().startsWith(input.key.toLowerCase())) ?? -1
      if (index >= 0) { event.preventDefault(); window.webContents.send('sql:application-menu-key', index) }
    }
  })
}
