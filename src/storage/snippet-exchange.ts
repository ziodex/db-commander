import { randomUUID } from 'node:crypto'
import { parseSnippetDocument, snippetExportSchema, snippetImportSchema, type SnippetDocument, type SnippetImportPreview, type SnippetImportRequest } from '../shared/snippet-files'
import type { WorkspaceStore } from './store'

/** One bounded, expiring review per application. No paths, SQL execution or credentials. */
export class SnippetExchange {
  private pending?: { preview: SnippetImportPreview; revision: string }
  constructor(private store: WorkspaceStore, private now = Date.now) {}
  export(ids: string[]): SnippetDocument {
    const all = this.store.snippets()
    return parseSnippetDocument({ format: 'dbcommander-snippets', version: 1, snippets: snippetExportSchema.parse(ids).map(id => {
      const value = all.find(s => s.id === id)
      if (!value) throw new Error('A selected snippet no longer exists. Refresh the list before exporting.')
      const { name, description, engine, sql, favorite } = value
      return { name, description, engine, sql, favorite }
    }) })
  }
  review(value: unknown): SnippetImportPreview {
    this.pending = undefined
    const document = parseSnippetDocument(value)
    const preview = { reviewId: randomUUID(), expiresAt: this.now() + 10 * 60_000, sourceName: '', snippets: document.snippets, existing: this.store.snippets().map(({ name, engine }) => ({ name, engine })) }
    this.pending = { preview, revision: this.store.snippetRevision() }
    return structuredClone(preview)
  }
  discard(id: string) { if (this.pending?.preview.reviewId === id) this.pending = undefined }
  apply(input: SnippetImportRequest) {
    const request = snippetImportSchema.parse(input), pending = this.pending
    if (!pending || pending.preview.reviewId !== request.reviewId || this.now() >= pending.preview.expiresAt) { this.pending = undefined; throw new Error('This snippet review expired. Choose the file again.') }
    if (request.selected.some(i => i >= pending.preview.snippets.length)) throw new Error('Choose only snippets in this review.')
    const result = this.store.importSnippets(pending.preview.snippets, request.selected, request.duplicates, pending.revision)
    this.pending = undefined
    return result
  }
}
