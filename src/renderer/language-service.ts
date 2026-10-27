import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import LanguageWorker from '../language/worker?worker'
import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import type { CompletionResult } from '../language/completion'
import type { SqlFormattingStyle } from '../shared/editor-settings'
interface Context { engine: DatabaseEngine; schema: SchemaSnapshot | null; style: SqlFormattingStyle; error(message: string): void }
const contexts = new Map<string, Context>()
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cancel: monaco.IDisposable }>()
let worker: Worker | undefined, sequence = 0
let formattingRevision = 0
/** Settings apply across tabs, including requests still pending for inactive models. */
export function invalidateSqlFormatting() { formattingRevision++ }
function stop() {
  worker?.terminate(); worker = undefined
  for (const request of pending.values()) { clearTimeout(request.timer); request.cancel.dispose(); request.reject(new Error('SQL language service stopped responding. Retry with a smaller selection.')) }
  pending.clear()
}
function start() {
  if (worker) return worker
  worker = new LanguageWorker()
  worker.onerror = stop
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id); if (!request) return
    pending.delete(data.id); clearTimeout(request.timer); request.cancel.dispose()
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value)
  }
  for (const [uri, context] of contexts) worker.postMessage({ method: 'context', uri, context: { engine: context.engine, schema: context.schema } })
  return worker
}
function request<T>(method: 'complete' | 'format', model: monaco.editor.ITextModel, token: monaco.CancellationToken, extra: object): Promise<T> {
  if (token.isCancellationRequested) return Promise.reject(new Error('Cancelled'))
  const active = start(), id = ++sequence
  return new Promise((resolve, reject) => {
    const cancel = token.onCancellationRequested(() => {
      const value = pending.get(id); if (!value) return
      clearTimeout(value.timer); pending.delete(id); value.cancel.dispose(); reject(new Error('Cancelled'))
    })
    pending.set(id, { resolve, reject, cancel, timer: setTimeout(stop, 3000) })
    active.postMessage({ method, uri: model.uri.toString(), id, ...extra })
  })
}
export function setSqlContext(uri: string, context: Context) {
  const previous = contexts.get(uri)
  contexts.set(uri, context)
  if (!previous || previous.engine !== context.engine || previous.schema !== context.schema) worker?.postMessage({ method: 'context', uri, context: { engine: context.engine, schema: context.schema } })
}
export function removeSqlContext(uri: string) { contexts.delete(uri); worker?.postMessage({ method: 'dispose', uri }) }
const kinds = { table: monaco.languages.CompletionItemKind.Class, column: monaco.languages.CompletionItemKind.Field, schema: monaco.languages.CompletionItemKind.Module, keyword: monaco.languages.CompletionItemKind.Keyword, function: monaco.languages.CompletionItemKind.Function }
monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', '"', '`', '['],
  async provideCompletionItems(model, position, _context, token) {
    const context = contexts.get(model.uri.toString()), version = model.getVersionId()
    if (!context) return { suggestions: [] }
    try {
      const value = await request<CompletionResult>('complete', model, token, { text: model.getValue(), offset: model.getOffsetAt(position) })
      if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId() || contexts.get(model.uri.toString()) !== context) return { suggestions: [] }
      const a = model.getPositionAt(value.start), b = model.getPositionAt(value.end), range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
      return { suggestions: value.suggestions.map(item => ({ ...item, kind: kinds[item.kind], range })) }
    } catch { return { suggestions: [] } }
  }
})
async function format(model: monaco.editor.ITextModel, range: monaco.Range, token: monaco.CancellationToken) {
  const context = contexts.get(model.uri.toString()), version = model.getVersionId(), revision = formattingRevision
  if (!context) return []
  try {
    const { tabSize, insertSpaces, formatting } = context.style
    const text = await request<string>('format', model, token, { text: model.getValueInRange(range), options: { tabSize, insertSpaces }, formatting })
    if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId() || contexts.get(model.uri.toString()) !== context || revision !== formattingRevision) return []
    return [{ range, text }]
  } catch (error) {
    if (!token.isCancellationRequested && !model.isDisposed() && version === model.getVersionId() && contexts.get(model.uri.toString()) === context && revision === formattingRevision) context.error((error as Error).message)
    return []
  }
}
monaco.languages.registerDocumentFormattingEditProvider('sql', { provideDocumentFormattingEdits: (model, _options, token) => format(model, model.getFullModelRange(), token) })
monaco.languages.registerDocumentRangeFormattingEditProvider('sql', { provideDocumentRangeFormattingEdits: (model, range, _options, token) => format(model, range, token) })
export async function formatEditor(editor: monaco.editor.IStandaloneCodeEditor | null) {
  if (!editor) return
  await editor.getAction(editor.getSelection()?.isEmpty() === false ? 'editor.action.formatSelection' : 'editor.action.formatDocument')?.run()
  editor.focus()
}
