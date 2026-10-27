import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeGeneratedFile } from './generated-file'
import { editorSettingsSchema, type EditorSettings } from '../shared/editor-settings'

const schema = z.object({ minimizeToTray: z.boolean(), preferences: editorSettingsSchema.optional() }).strict()
const FILE_LIMIT = 64 * 1024

/** Application behavior is shared by windows, not included in editor exports. */
export class DesktopSettings {
  minimizeToTray = false
  preferences: EditorSettings | undefined
  private saving: Promise<void> = Promise.resolve()
  private loadError: Error | undefined
  private readonly file: string
  constructor(root: string) { this.file = join(root, 'desktop-settings.json') }
  async load() {
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error('Invalid desktop settings file.')
        const data = Buffer.alloc(FILE_LIMIT + 1)
        let length = 0
        while (length < data.length) {
          const { bytesRead } = await file.read(data, length, data.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > FILE_LIMIT) throw new Error('Desktop settings file is too large.')
        const settings = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))))
        this.minimizeToTray = settings.minimizeToTray
        this.preferences = settings.preferences
      } finally { await file.close() }
      this.loadError = undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loadError = undefined; return }
      this.loadError = new Error('Cannot read desktop settings. Repair desktop-settings.json before changing this option. Your saved settings have been kept.')
      throw this.loadError
    }
  }
  setMinimizeToTray(enabled: boolean) { return this.save({ minimizeToTray: enabled }) }
  setPreferences(preferences: EditorSettings) { return this.save({ preferences: editorSettingsSchema.parse(preferences) }) }
  private save(patch: Partial<z.infer<typeof schema>>) {
    const operation = this.saving.catch(() => {}).then(async () => {
      // Serialize tray and preference changes so one window cannot lose another's save.
      // A damaged file must not be replaced with defaults. Allow retry after repair.
      if (this.loadError) await this.load()
      const settings = schema.parse({ minimizeToTray: this.minimizeToTray, preferences: this.preferences, ...patch })
      await writeGeneratedFile(this.file, JSON.stringify(settings), { replace: true })
      this.minimizeToTray = settings.minimizeToTray
      this.preferences = settings.preferences
    })
    this.saving = operation
    return operation
  }
}
