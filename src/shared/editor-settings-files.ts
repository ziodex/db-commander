import { z } from 'zod'
import { editorSettingsSchema } from './editor-settings'

export const EDITOR_SETTINGS_FILE_LIMIT = 64 * 1024
const editorSettingsDocumentSchema = z.object({
  format: z.enum(['dbcommander-editor-settings', 'sqlcommander-editor-settings']).transform(() => 'dbcommander-editor-settings' as const),
  version: z.literal(1),
  settings: editorSettingsSchema
}).strict()
export type EditorSettingsDocument = z.infer<typeof editorSettingsDocumentSchema>
export interface ImportedEditorSettings {
  sourceName: string
  settings: EditorSettingsDocument['settings']
}

/** Imports are strict; disk recovery rules must not silently change a shared style. */
export function parseEditorSettingsDocument(value: unknown): EditorSettingsDocument {
  const parsed = editorSettingsDocumentSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid editor settings file. Choose a version 1 Db Commander editor settings export with valid preferences and no extra fields.')
  return parsed.data
}
