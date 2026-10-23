import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { conf as sqlConfiguration, language as sqlLanguage } from 'monaco-editor/esm/vs/basic-languages/sql/sql'
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/esm/vs/editor/contrib/format/browser/formatActions'
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import { DEFAULT_EDITOR_SHORTCUTS, type EditorShortcut } from '../shared/editor-shortcuts'
import { resolveSqlFormatting, type EditorSettings } from '../shared/editor-settings'
import { setSqlContext, removeSqlContext, formatEditor, invalidateSqlFormatting } from './language-service'
import { vscodeDarkEditorTheme } from './themes/vscode-dark-2026'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })
monaco.languages.register({ id: 'sql', extensions: ['.sql'], aliases: ['SQL', 'sql'] })
monaco.languages.setLanguageConfiguration('sql', sqlConfiguration)
// Monaco groups JOIN/AND/NULL with symbolic operators. VS Code's SQL grammar
// colors these words as keywords, while comparison/arithmetic symbols retain
// their operator color. Preserve Monaco's grammar and distinguish only these.
monaco.languages.setMonarchTokensProvider('sql', {
  ...sqlLanguage,
  tokenizer: { ...sqlLanguage.tokenizer, root: [
    [new RegExp(`\\b(?:${(sqlLanguage.operators as string[]).join('|')})\\b`, 'i'), 'operator.word'],
    ...sqlLanguage.tokenizer.root
  ] }
})
// The wrapper's URI-keyed cache never removes permanently closed tabs. Tie
// cursor/scroll state to the model instead, so only live buffers keep it alive.
const viewStates = new WeakMap<monaco.editor.ITextModel, monaco.editor.ICodeEditorViewState>()
monaco.editor.defineTheme('commander', vscodeDarkEditorTheme)

monaco.editor.defineTheme('commander-light', {
  base: 'vs', inherit: true,
  rules: [{ token: 'keyword', foreground: '234c97' }, { token: 'operator.sql', foreground: '425a70' }, { token: 'operator.word', foreground: '425a70' }, { token: 'string.sql', foreground: '32652b' }, { token: 'number.sql', foreground: '306748' }, { token: 'predefined.sql', foreground: '674599' }, { token: 'comment', foreground: '596b7b', fontStyle: 'italic' }],
  colors: { 'editor.background': '#ffffff', 'editor.foreground': '#243442', 'editorLineNumber.foreground': '#596b7b', 'editorLineNumber.activeForeground': '#354b5f', 'editor.lineHighlightBackground': '#f2f5f7', 'editor.selectionBackground': '#e1ecf7', 'editor.inactiveSelectionBackground': '#e9edf2', 'editorCursor.foreground': '#27694d', 'editorIndentGuide.background1': '#dce3e9' }
})
function binding(value: EditorShortcut): number[] {
  if (value === 'none') return []
  const keys: Record<string, number> = { CtrlCmd: monaco.KeyMod.CtrlCmd, Shift: monaco.KeyMod.Shift, Alt: monaco.KeyMod.Alt, Enter: monaco.KeyCode.Enter, F: monaco.KeyCode.KeyF, F5: monaco.KeyCode.F5, F8: monaco.KeyCode.F8, F9: monaco.KeyCode.F9 }
  return [value.split('+').reduce((code, key) => code | keys[key], 0)]
}

export function SqlEditor({ theme, readOnly, canRun, tabId, tabIds, value, engine, schema, settings, noBackslashEscapes, onError, onChange, editorRef, onRun, onRunCurrent, onFocus, onReady, ariaLabel }: { theme: 'dark' | 'light'; readOnly?: boolean; canRun: boolean; tabId: string; tabIds: string[]; value: string; engine: DatabaseEngine; schema: SchemaSnapshot | null; settings: EditorSettings; noBackslashEscapes?: boolean; onError(id: string, message: string): void; onChange(id: string, value: string): void; editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>; onRun(): void; onRunCurrent(): void; onFocus?(): void; onReady?(editor: monaco.editor.IStandaloneCodeEditor | null): void; ariaLabel?: string }) {
  const callbacks = useRef({ onRun, onRunCurrent, onFocus, onReady, value }); callbacks.current = { onRun, onRunCurrent, onFocus, onReady, value }
  const reportLanguageError = useEffectEvent((id: string, message: string) => onError(id, message))
  const actions = useRef<monaco.IDisposable[]>([])
  function installActions(editor: monaco.editor.IStandaloneCodeEditor) {
    // Monaco actions also register global commands. Dispose every registration
    // so closed editors cannot retain their callbacks, DOM or query results.
    actions.current.forEach(action => action.dispose())
    const keys = settingsRef.current.shortcuts ?? DEFAULT_EDITOR_SHORTCUTS
    actions.current = [
      editor.addAction({ id: 'format-sql', label: 'Format SQL (selection or document)', keybindings: binding(keys.format), run: () => formatEditor(editor) }),
      editor.addAction({ id: 'run-current-sql', label: 'Run current statement / batch', precondition: 'dbCommanderCanRun', contextMenuGroupId: '1_execution', contextMenuOrder: 2, keybindings: binding(keys.current), run: () => callbacks.current.onRunCurrent() }),
      editor.addAction({ id: 'run-sql', label: 'Run selection or script', precondition: 'dbCommanderCanRun', keybindings: binding(keys.run), run: () => callbacks.current.onRun() }),
      editor.addAction({ id: 'run-selected-sql', label: 'Run selected SQL', precondition: 'dbCommanderCanRun && editorHasSelection', contextMenuGroupId: '1_execution', contextMenuOrder: 1, run: () => callbacks.current.onRun() })
    ]
  }
  const focusListener = useRef<monaco.IDisposable | null>(null)
  const runContext = useRef<monaco.editor.IContextKey<boolean> | null>(null)
  const settingsRef = useRef(settings), modelListener = useRef<monaco.IDisposable | null>(null)
  function updateIndentation(model: monaco.editor.ITextModel | null) {
    if (model?.uri.scheme === 'dbcommander') {
      const { tabSize, insertSpaces } = settingsRef.current
      model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces })
    }
  }
  useEffect(() => {
    settingsRef.current = settings
    if (editorRef.current) installActions(editorRef.current)
    invalidateSqlFormatting()
    // Model options survive tab switches; update inactive buffers too, without
    // replacing text, recreating models or clearing their undo/view state.
    monaco.editor.getModels().forEach(updateIndentation)
  }, [settings, editorRef])
  useEffect(() => () => { actions.current.forEach(action => action.dispose()); modelListener.current?.dispose(); focusListener.current?.dispose(); callbacks.current.onReady?.(null) }, [])
  useLayoutEffect(() => () => {
    // Save before the wrapper's passive cleanup disposes the editor. Models
    // survive hidden views/tab switches and are disposed when their tab closes.
    const editor = editorRef.current, model = editor?.getModel(), state = editor?.saveViewState()
    if (model && state) viewStates.set(model, state)
  }, [editorRef])
  useEffect(() => { runContext.current?.set(canRun) }, [canRun])
  useEffect(() => { setSqlContext(monaco.Uri.parse(`dbcommander:///query/${tabId}.sql`).toString(), { engine, schema, style: resolveSqlFormatting(settings, engine), error: message => reportLanguageError(tabId, message) }) }, [tabId, engine, schema, settings])
  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      const id = model.uri.path.split('/').pop()?.replace(/\.sql$/, '')
      if (model.uri.scheme === 'dbcommander' && id && !tabIds.includes(id) && !monaco.editor.getEditors().some(editor => editor.getModel() === model)) { removeSqlContext(model.uri.toString()); model.dispose() }
    }
  }, [tabId, tabIds, editorRef])
  const mount: OnMount = editor => {
    editorRef.current = editor
    // A hidden model may have been changed by a file operation while its view
    // was unmounted. Keep the current buffer authoritative without clearing undo.
    if (editor.getValue() !== callbacks.current.value) {
      editor.executeEdits('workspace', [{ range: editor.getModel()!.getFullModelRange(), text: callbacks.current.value }]); editor.pushUndoStop()
    }
    const model = editor.getModel(), state = model && viewStates.get(model)
    if (state) editor.restoreViewState(state)
    callbacks.current.onReady?.(editor)
    focusListener.current?.dispose()
    focusListener.current = editor.onDidFocusEditorWidget(() => callbacks.current.onFocus?.())
    updateIndentation(editor.getModel())
    modelListener.current?.dispose()
    modelListener.current = editor.onDidChangeModel(() => updateIndentation(editor.getModel()))
    runContext.current = editor.createContextKey('dbCommanderCanRun', canRun)
    installActions(editor)
  }
  return <Editor path={`dbcommander:///query/${tabId}.sql`} keepCurrentModel saveViewState={false} language="sql" theme={theme === 'light' ? 'commander-light' : 'commander'} value={value} onChange={value => {
    const id = editorRef.current?.getModel()?.uri.path.split('/').pop()?.replace(/\.sql$/, '')
    if (id) onChange(id, value ?? '')
  }} onMount={mount} loading={<div className="editor-loading">Opening SQL editor…</div>}
    options={{ readOnly, domReadOnly: readOnly, autoClosingQuotes: noBackslashEscapes ? 'never' : 'languageDefined', fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: settings.fontSize, lineHeight: Math.round(settings.fontSize * 23 / 13), lineNumbers: settings.lineNumbers,
      minimap: { enabled: settings.minimap }, padding: { top: 22 }, scrollBeyondLastLine: false, automaticLayout: true,
      detectIndentation: false, tabSize: settings.tabSize, insertSpaces: settings.insertSpaces,
      wordWrap: settings.wordWrap ? 'on' : 'off', wordBasedSuggestions: 'off',
      quickSuggestions: { other: settings.automaticSuggestions, comments: false, strings: false }, suggestOnTriggerCharacters: settings.automaticSuggestions,
      ariaLabel: ariaLabel ?? 'SQL editor', fixedOverflowWidgets: true }} />
}
