import { z } from 'zod'
import { engineSchema, type DatabaseEngine } from './database-engines'
import { editorShortcutsSchema } from './editor-shortcuts'

export const sqlFormattingSchema = z.object({
  expressionWidth: z.number().int().min(20).max(200),
  linesBetweenQueries: z.number().int().min(0).max(3)
}).strict()
export type SqlFormattingSettings = z.infer<typeof sqlFormattingSchema>
export const DEFAULT_SQL_FORMATTING: SqlFormattingSettings = { expressionWidth: 50, linesBetweenQueries: 1 }

const sqlFormattingStyleSchema = z.object({
  tabSize: z.number().int().min(1).max(8),
  insertSpaces: z.boolean(),
  formatting: sqlFormattingSchema
}).strict()
export type SqlFormattingStyle = z.infer<typeof sqlFormattingStyleSchema>

const globalEditorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(32),
  wordWrap: z.boolean(),
  lineNumbers: z.enum(['on', 'relative', 'off']),
  minimap: z.boolean(),
  automaticSuggestions: z.boolean(),
  ...sqlFormattingStyleSchema.shape
}).strict()
export const editorSettingsSchema = globalEditorSettingsSchema.extend({
  appearance: z.enum(['dark', 'light', 'system']).optional(),
  shortcuts: editorShortcutsSchema.optional(),
  engineFormatting: z.partialRecord(engineSchema, sqlFormattingStyleSchema).optional()
})
export type EditorSettings = z.infer<typeof editorSettingsSchema>
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13, wordWrap: true, lineNumbers: 'on', minimap: false,
  automaticSuggestions: true, tabSize: 2, insertSpaces: true,
  formatting: DEFAULT_SQL_FORMATTING
}

/** Overrides affect explicit formatting only. Typed indentation stays global. */
export function resolveSqlFormatting(settings: EditorSettings, engine: DatabaseEngine): SqlFormattingStyle {
  const style = settings.engineFormatting?.[engine] ?? settings
  return { tabSize: style.tabSize, insertSpaces: style.insertSpaces, formatting: { ...style.formatting } }
}

/** Tolerant disk recovery only; IPC and saves still require the strict schema. */
export function recoverEditorSettings(input: unknown): EditorSettings {
  const complete = editorSettingsSchema.safeParse(input)
  if (complete.success) return complete.data
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const { engineFormatting, appearance, shortcuts, ...global } = input as Record<string, unknown>
    const parsed = globalEditorSettingsSchema.safeParse(global)
    if (parsed.success) {
      const recovered: NonNullable<EditorSettings['engineFormatting']> = {}
      if (engineFormatting && typeof engineFormatting === 'object' && !Array.isArray(engineFormatting)) {
        for (const engine of engineSchema.options) {
          if (!Object.hasOwn(engineFormatting, engine)) continue
          const style = sqlFormattingStyleSchema.safeParse((engineFormatting as Record<string, unknown>)[engine])
          if (style.success) recovered[engine] = style.data
        }
      }
      const theme = editorSettingsSchema.shape.appearance.safeParse(appearance), keys = editorShortcutsSchema.safeParse(shortcuts)
      return { ...parsed.data, ...(theme.success && theme.data ? { appearance: theme.data } : {}), ...(keys.success ? { shortcuts: keys.data } : {}), ...(Object.keys(recovered).length ? { engineFormatting: recovered } : {}) }
    }
  }
  return editorSettingsSchema.parse(DEFAULT_EDITOR_SETTINGS)
}
