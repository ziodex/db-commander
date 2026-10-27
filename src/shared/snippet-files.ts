import { z } from 'zod'
import { snippetSchema, type SnippetInput } from './query-library'

export const SNIPPET_FILE_LIMIT = 32 * 1024 * 1024
const portableSnippetSchema = snippetSchema.omit({ id: true }).strict()
const snippetDocumentSchema = z.object({
  format: z.enum(['dbcommander-snippets', 'sqlcommander-snippets']).transform(() => 'dbcommander-snippets' as const), version: z.literal(1),
  snippets: z.array(portableSnippetSchema).min(1).max(200)
}).strict().superRefine((doc, ctx) => {
  if (doc.snippets.reduce((n, s) => n + s.sql.length, 0) > 5_000_000) ctx.addIssue({ code: 'custom', message: 'Snippets exceed the 5,000,000-character SQL budget.' })
})
export type SnippetDocument = z.infer<typeof snippetDocumentSchema>
export type PortableSnippet = z.infer<typeof portableSnippetSchema>
const unique = <T>(items: T[]) => new Set(items).size === items.length
export const snippetExportSchema = z.array(z.string().uuid()).min(1).max(200).refine(unique, 'Choose each snippet only once.')
export const snippetImportSchema = z.object({
  reviewId: z.string().uuid(), selected: z.array(z.number().int().min(0).max(199)).min(1).max(200).refine(unique, 'Choose each snippet only once.'),
  duplicates: z.enum(['skip', 'copy'])
}).strict()
export type SnippetImportRequest = z.infer<typeof snippetImportSchema>
export interface SnippetImportPreview {
  reviewId: string; expiresAt: number; sourceName: string; snippets: PortableSnippet[]
  existing: { name: string; engine?: SnippetInput['engine'] }[]
}
export interface SnippetImportResult { imported: number; skipped: number }
const key = (s: { name: string; engine?: SnippetInput['engine'] }) => JSON.stringify([s.engine ?? '', s.name.normalize('NFC').toLowerCase()])

/** Both the review and storage use this deterministic, non-destructive policy. */
export function planSnippetImport(snippets: PortableSnippet[], existing: SnippetImportPreview['existing'], selected: number[], duplicates: SnippetImportRequest['duplicates']) {
  const chosen = new Set(selected), used = new Set(existing.map(key))
  return snippets.flatMap((snippet, index) => {
    if (!chosen.has(index)) return []
    const duplicate = used.has(key(snippet))
    let name = snippet.name
    if (duplicate && duplicates === 'copy') {
      let suffix = 2
      do {
        const tail = ` (imported ${suffix++})`
        name = snippet.name.slice(0, 100 - tail.length).replace(/[\uD800-\uDBFF]$/, '') + tail
      } while (used.has(key({ ...snippet, name })))
    }
    const skip = duplicate && duplicates === 'skip'
    if (!skip) used.add(key({ ...snippet, name }))
    return [{ index, snippet: { ...snippet, name }, skip, renamed: name !== snippet.name }]
  })
}
export function parseSnippetDocument(value: unknown): SnippetDocument {
  const result = snippetDocumentSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid snippet file: ' + result.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'document'}: ${i.message}`).join(' '))
  return result.data
}
