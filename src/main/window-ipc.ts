import { ipcMain, type IpcMainInvokeEvent } from 'electron'

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
/** Invoke channels are registered once, and routed solely by the owning webContents. */
export class WindowIpc {
  private channels = new Set<string>()
  private owners = new Map<number, Map<string, Handler>>()
  attach(id: number, handlers: Map<string, Handler>) { this.owners.set(id, handlers) }
  detach(id: number) { this.owners.delete(id) }
  register(method: string) {
    if (this.channels.has(method)) return
    this.channels.add(method)
    ipcMain.handle(`sql:${method}`, (event, payload) => {
      const handler = this.owners.get(event.sender.id)?.get(method)
      if (!handler) throw new Error('Untrusted IPC sender.')
      return handler(event, payload)
    })
  }
}
