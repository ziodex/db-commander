import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeGeneratedFile } from './generated-file'
import { editorSettingsSchema, type EditorSettings } from '../shared/editor-settings'
import { engineSchema } from '../shared/database-engines'
import type { DatabaseEngine } from '../shared/contracts'

const locationSchema = z.object({ engine: engineSchema, purpose: z.enum(['backup', 'restore', 'target', 'tools']), directory: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\u0000-\u001f]/.test(value)) }).strict()
type BackupLocation = z.infer<typeof locationSchema>
const schema = z.object({ minimizeToTray: z.boolean(), preferences: editorSettingsSchema.optional(), backupLocations: z.array(locationSchema).max(32).optional() }).strict()
const FILE_LIMIT = 64 * 1024

/** Application behavior is shared by windows, not included in editor exports. */
export class DesktopSettings {
  minimizeToTray = false
  preferences: EditorSettings | undefined
  private backupLocations: BackupLocation[] | undefined
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
        this.backupLocations = settings.backupLocations
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
  backupDirectory(engine: DatabaseEngine, purpose: BackupLocation['purpose']) { return this.backupLocations?.find(value => value.engine === engine && value.purpose === purpose)?.directory }
  rememberBackupDirectory(engine: DatabaseEngine, purpose: BackupLocation['purpose'], directory: string) {
    const next = locationSchema.parse({ engine, purpose, directory })
    return this.save(() => ({ backupLocations: [...(this.backupLocations ?? []).filter(value => value.engine !== engine || value.purpose !== purpose), next] }))
  }
  private save(patch: Partial<z.infer<typeof schema>> | (() => Partial<z.infer<typeof schema>>)) {
    const operation = this.saving.catch(() => {}).then(async () => {
      // Serialize tray and preference changes so one window cannot lose another's save.
      // A damaged file must not be replaced with defaults. Allow retry after repair.
      if (this.loadError) await this.load()
      const settings = schema.parse({ minimizeToTray: this.minimizeToTray, preferences: this.preferences, backupLocations: this.backupLocations, ...(typeof patch === 'function' ? patch() : patch) })
      const json = JSON.stringify(settings)
      if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error('Desktop settings exceed the saved settings limit. Shorten a remembered folder path.')
      await writeGeneratedFile(this.file, json, { replace: true })
      this.minimizeToTray = settings.minimizeToTray
      this.preferences = settings.preferences
      this.backupLocations = settings.backupLocations
    })
    this.saving = operation
    return operation
  }
}
