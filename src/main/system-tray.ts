import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'

export class SystemTray {
  private tray: Tray | undefined
  private windows = new Map<BrowserWindow, { name: string; hidden: boolean }>()
  private active: BrowserWindow | undefined
  private quitQueued = false
  constructor(private iconPath: string, private templatePath: string) {
    app.on('before-quit', event => {
      if (!this.windows.size) return
      // Finish native Quit cancellation before restoring/closing workspaces.
      // Otherwise macOS can hide a restored window again after its async
      // transaction/save guard keeps it open. The last guarded close triggers
      // window-all-closed, whose Quit is allowed once this map is empty.
      event.preventDefault()
      if (this.quitQueued) return
      this.quitQueued = true
      setImmediate(() => {
        this.quitQueued = false
        for (const window of this.windows.keys()) if (!window.isDestroyed()) {
          this.restore(window)
          window.close()
        }
      })
    })
  }
  get enabled() { return Boolean(this.tray && !this.tray.isDestroyed()) }
  attach(window: BrowserWindow, name: string) {
    const state = { name, hidden: false }
    this.windows.set(window, state)
    window.on('focus', () => { this.active = window })
    window.on('show', () => { state.hidden = false })
    window.on('minimize', () => {
      // A failed/missing tray must never make a workspace unreachable.
      if (!this.enabled) return
      state.hidden = true
      window.hide()
    })
    window.on('closed', () => {
      this.windows.delete(window)
      if (this.active === window) this.active = undefined
      this.updateMenu()
    })
    this.updateMenu()
  }
  restore(window: BrowserWindow) {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
  }
  restoreActive() {
    const window = this.active ?? this.windows.keys().next().value
    if (window) this.restore(window)
  }
  private restoreAll() { for (const window of this.windows.keys()) this.restore(window) }
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return
    if (!enabled) {
      // Restore only windows hidden by this option, preserving ordinary OS hides.
      for (const [window, state] of this.windows) if (state.hidden) this.restore(window)
      this.destroy(); return
    }
    const image = nativeImage.createFromPath(process.platform === 'darwin' ? this.templatePath : this.iconPath)
    if (image.isEmpty()) throw new Error('The system tray icon could not be loaded.')
    const icon = process.platform === 'darwin' ? image : image.resize({ width: 24, height: 24 })
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    const tray = new Tray(icon)
    this.tray = tray
    try {
      tray.setToolTip('Db Commander')
      // macOS opens the context menu on click; Windows/Linux also restore on activation.
      if (process.platform !== 'darwin') tray.on('click', () => this.restoreActive())
      tray.on('double-click', () => this.restoreActive())
      this.updateMenu()
    } catch (error) { this.destroy(); throw error }
  }
  private updateMenu() {
    if (!this.enabled) return
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      { id: 'tray-show', label: 'Show Db Commander', click: () => this.restoreActive() },
      { id: 'tray-show-all', label: 'Show all workspace windows', click: () => this.restoreAll() },
      { type: 'separator' },
      ...[...this.windows].map(([window, state]) => ({ id: `tray-window-${window.id}`, label: state.name, click: () => this.restore(window) })),
      { type: 'separator' },
      { id: 'tray-quit', label: 'Quit Db Commander', click: () => app.quit() }
    ]))
  }
  destroy() { this.tray?.destroy(); this.tray = undefined }
}
