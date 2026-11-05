import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import LanguageWorker from '../language/worker?worker'
import type { SchemaSnapshot } from '../shared/contracts'
import type { CompletionResult } from '../language/completion'
import type { SqlDiagnostic } from '../language/diagnostics'
import type { routineSignatures, SqlNavigation, SqlRename } from '../language/navigation'
import { ANALYSIS_LIMIT, sqlTokens, symbol, type AnalysisDialect, type SourceRange } from '../language/syntax'
import type { SqlFormattingStyle } from '../shared/editor-settings'
interface Context extends AnalysisDialect { schema: SchemaSnapshot | null; style: SqlFormattingStyle; error(message: string): void }
type Method = 'complete' | 'format' | 'diagnostics' | 'navigate' | 'rename' | 'signature'
const analysisContext = ({ engine, schema, ansiQuotes, noBackslashEscapes }: Context) => ({ engine, schema, ansiQuotes, noBackslashEscapes })
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
  for (const [uri, context] of contexts) worker.postMessage({ method: 'context', uri, context: analysisContext(context) })
  return worker
}
function request<T>(method: Method, model: monaco.editor.ITextModel, token: monaco.CancellationToken, extra: object): Promise<T> {
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
  if (!previous || previous.engine !== context.engine || previous.schema !== context.schema ||
      previous.noBackslashEscapes !== context.noBackslashEscapes || previous.ansiQuotes !== context.ansiQuotes) {
    worker?.postMessage({ method: 'context', uri, context: analysisContext(context) })
  }
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

export function sqlRange(model: monaco.editor.ITextModel, { start, end }: SourceRange) {
  const a = model.getPositionAt(start), b = model.getPositionAt(end)
  return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
}

function modelSnapshot(model: monaco.editor.ITextModel) {
  const uri = model.uri.toString(), context = contexts.get(uri), version = model.getVersionId()
  return { context, current: () => Boolean(context) && !model.isDisposed() && version === model.getVersionId() && contexts.get(uri) === context }
}

async function navigation(model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) {
  const snapshot = modelSnapshot(model)
  if (!snapshot.context || model.getValueLength() > ANALYSIS_LIMIT) return
  try {
    const result = await request<SqlNavigation>('navigate', model, token, { text: model.getValue(), offset: model.getOffsetAt(position) })
    if (snapshot.current() && !token.isCancellationRequested) return result
  } catch { /* Unsupported or obsolete analysis. */ }
}

monaco.languages.registerDefinitionProvider('sql', {
  async provideDefinition(model, position, token) {
    const result = await navigation(model, position, token)
    if (result?.definition) return { uri: model.uri, range: sqlRange(model, result.definition) }
  }
})
monaco.languages.registerReferenceProvider('sql', {
  async provideReferences(model, position, context, token) {
    const result = await navigation(model, position, token)
    if (!result) return []
    const ranges = context.includeDeclaration && result.definition ? [result.definition, ...result.references] : result.references
    return ranges.map(range => ({ uri: model.uri, range: sqlRange(model, range) }))
  }
})

monaco.languages.registerSignatureHelpProvider('sql', {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [',', ')'],
  async provideSignatureHelp(model, position, token) {
    const snapshot = modelSnapshot(model), dialect = snapshot.context
    if (!dialect || model.getValueLength() > ANALYSIS_LIMIT) return
    try {
      const result = await request<ReturnType<typeof routineSignatures>>('signature', model, token, { text: model.getValue(), offset: model.getOffsetAt(position) })
      if (!result || !snapshot.current() || token.isCancellationRequested) return
      const signatures = result.signatures.map(({ label, arguments: args }): monaco.languages.SignatureInformation => {
        if (args === undefined) return { label, parameters: [], documentation: 'Open the routine definition to inspect available argument metadata.' }
        const parameters: monaco.languages.ParameterInformation[] = []
        let depth = 0, start = 0
        const add = (end: number) => {
          const argument = args.slice(start, end).trim()
          if (argument) {
            const offset = label.length + 1 + args.indexOf(argument, start)
            parameters.push({ label: [offset, offset + argument.length] })
          }
        }
        for (const part of sqlTokens(args, dialect)) {
          if (symbol(part, '(')) depth++
          if (symbol(part, ')')) depth--
          if (!depth && symbol(part, ',')) { add(part.start); start = part.end }
        }
        add(args.length)
        return { label: label + '(' + args + ')', parameters,
          documentation: result.limited ? 'Visible catalog preview. Additional overloads may exist.' : 'Catalog signature. The database resolves overloads when you run SQL.' }
      })
      const activeSignature = Math.max(0, signatures.findIndex(signature => signature.parameters.length > result.argument))
      return { value: { signatures, activeSignature, activeParameter: result.argument }, dispose() {} }
    } catch { /* Unsupported or obsolete analysis. */ }
  }
})

/** Each visible editor owns its debounce and marker lifetime. */
export function watchSqlDiagnostics(editor: monaco.editor.IStandaloneCodeEditor) {
  const owner = 'dbcommander-sql-analysis'
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: monaco.CancellationTokenSource | undefined
  let model = editor.getModel()
  function refresh() {
    clearTimeout(timer)
    active?.dispose(true)
    if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, owner, [])
    model = editor.getModel()
    const target = model
    if (!target || !target.getValueLength() || target.getValueLength() > ANALYSIS_LIMIT) return
    timer = setTimeout(async () => {
      const snapshot = modelSnapshot(target)
      if (!snapshot.context) return
      const source = new monaco.CancellationTokenSource()
      active = source
      try {
        const issues = await request<SqlDiagnostic[]>('diagnostics', target, source.token, { text: target.getValue() })
        if (!source.token.isCancellationRequested && snapshot.current() && editor.getModel() === target) {
          monaco.editor.setModelMarkers(target, owner, issues.map(issue => ({
            ...sqlRange(target, issue), message: issue.message, source: 'SQL analysis', severity: monaco.MarkerSeverity.Warning
          })))
        }
      } catch { /* Diagnostics never block editing. */ }
      finally { if (active === source) { source.dispose(); active = undefined } }
    }, 350)
  }
  const changes = editor.onDidChangeModelContent(refresh), switches = editor.onDidChangeModel(refresh)
  refresh()
  return {
    refresh,
    dispose() {
      clearTimeout(timer)
      active?.dispose(true)
      changes.dispose()
      switches.dispose()
      if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, owner, [])
    }
  }
}

export async function editorSqlDefinition(editor: monaco.editor.IStandaloneCodeEditor) {
  const model = editor.getModel(), position = editor.getPosition()
  if (!model || !position) return
  const source = new monaco.CancellationTokenSource()
  try {
    const result = await navigation(model, position, source.token)
    const current = editor.getPosition()
    if (editor.getModel() === model && current && position.equals(current)) return result
  } finally { source.dispose() }
}

export function sqlRenameReview(editor: monaco.editor.IStandaloneCodeEditor, workspaceBudget: () => number) {
  const model = editor.getModel(), position = editor.getPosition()
  if (!model || !position) throw new Error('Focus a query editor first.')
  const snapshot = modelSnapshot(model), offset = model.getOffsetAt(position)
  const current = () => {
    if (!snapshot.current() || editor.getModel() !== model || editor.getOption(monaco.editor.EditorOption.readOnly)) {
      throw new Error('The query or connection changed. Reopen the rename review.')
    }
  }
  current()
  if (model.getValueLength() > ANALYSIS_LIMIT) throw new Error('Alias review supports SQL buffers up to 200,000 characters.')
  return {
    async preview(name: string) {
      current()
      const source = new monaco.CancellationTokenSource()
      try {
        const plan = await request<SqlRename>('rename', model, source.token, { text: model.getValue(), offset, name })
        current()
        const rows = plan.edits.map(edit => {
          const range = sqlRange(model, edit), before = model.getValueInRange(range)
          const line = model.getLineContent(range.startLineNumber)
          return { line: range.startLineNumber, column: range.startColumn, before,
            prefix: line.slice(Math.max(0, range.startColumn - 41), range.startColumn - 1),
            suffix: line.slice(range.endColumn - 1, range.endColumn + 39) }
        })
        return { plan, rows }
      } finally { source.dispose() }
    },
    apply(plan: SqlRename) {
      current()
      const added = plan.edits.reduce((sum, edit) => sum + plan.replacement.length - (edit.end - edit.start), 0)
      if (added > workspaceBudget()) throw new Error('Shorten SQL buffers before applying the rename. The workspace supports 5 MB of SQL.')
      editor.pushUndoStop()
      if (!editor.executeEdits('sql-alias-rename', plan.edits.map(edit => ({ range: sqlRange(model, edit), text: plan.replacement })))) {
        throw new Error('The editor refused the rename. Reopen the review.')
      }
      editor.pushUndoStop()
    }
  }
}
