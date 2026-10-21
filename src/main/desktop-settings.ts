import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeGeneratedFile } from './generated-file'

const schema = z.object({ minimizeToTray: z.boolean() }).strict()

/** Application behavior is shared by windows, not included in editor exports. */
export class DesktopSettings {
  minimizeToTray = false
  private loadError: Error | undefined
  private readonly file: string
  constructor(root: string) { this.file = join(root, 'desktop-settings.json') }
  async load() {
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid desktop settings file.')
        const data = Buffer.alloc(4097)
        let length = 0
        while (length < data.length) {
          const { bytesRead } = await file.read(data, length, data.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > 4096) throw new Error('Desktop settings file is too large.')
        this.minimizeToTray = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)))).minimizeToTray
      } finally { await file.close() }
      this.loadError = undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loadError = undefined; return }
      this.loadError = new Error('Cannot read desktop settings. Repair desktop-settings.json before changing this option. Your saved settings have been kept.')
      throw this.loadError
    }
  }
  async setMinimizeToTray(enabled: boolean) {
    // A damaged file must not be replaced with defaults. Allow retry after repair.
    if (this.loadError) await this.load()
    await writeGeneratedFile(this.file, JSON.stringify(schema.parse({ minimizeToTray: enabled })), { replace: true })
    this.minimizeToTray = enabled
  }
}
