import { useEffect, useRef, useState } from 'react'
import { DEFAULT_EDITOR_SETTINGS, editorSettingsSchema, resolveSqlFormatting, type EditorSettings, type SqlFormattingStyle } from '../shared/editor-settings'
import { engineNames, engineSchema, type DatabaseEngine } from '../shared/database-engines'
import { DEFAULT_EDITOR_SHORTCUTS, editorShortcutSchema, shortcutLabel, type EditorShortcut, type EditorShortcuts } from '../shared/editor-shortcuts'

export function EditorSettingsDialog({ settings, onApply, onClose }: {
  settings: EditorSettings; onApply(settings: EditorSettings): void; onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(settings), [error, setError] = useState('')
  const [busy, setBusy] = useState<'import' | 'export' | null>(null), [notice, setNotice] = useState('')
  const operation = useRef(false), mounted = useRef(false)
  const [scope, setScope] = useState<DatabaseEngine | 'global'>('global')
  const style = scope === 'global' ? draft : resolveSqlFormatting(draft, scope)
  const inherits = scope !== 'global' && !draft.engineFormatting?.[scope]
  useEffect(() => {
    mounted.current = true
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null
    element.showModal()
    return () => { mounted.current = false; element.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  async function transfer(action: 'import' | 'export') {
    if (operation.current) return
    operation.current = true; setBusy(action); setError(''); setNotice('')
    try {
      if (action === 'import') {
        const imported = await window.dbCommander.importEditorSettings()
        if (!mounted.current || !imported) return
        const preferences = editorSettingsSchema.parse(imported.settings)
        setDraft(preferences); setScope('global')
        const engines = engineSchema.options.filter(engine => preferences.engineFormatting?.[engine]).map(engine => engineNames[engine])
        setNotice(`Loaded ${imported.sourceName} into the draft. Custom formatting: ${engines.join(', ') || 'none'}. Review the settings, then Apply to replace your editor preferences and custom styles.`)
      } else {
        const path = await window.dbCommander.exportEditorSettings(settings)
        if (mounted.current && path) setNotice(`Applied editor settings exported to ${path}.`)
      }
    } catch (error) { if (mounted.current) setError((error as Error).message) }
    finally { operation.current = false; if (mounted.current) setBusy(null) }
  }
  function change(patch: Partial<EditorSettings>) { setDraft(value => ({ ...value, ...patch })); setError('') }
  function customFormatting(enabled: boolean) {
    if (scope === 'global') return
    const engineFormatting = { ...draft.engineFormatting }
    if (enabled) engineFormatting[scope] = resolveSqlFormatting(draft, scope)
    else delete engineFormatting[scope]
    change({ engineFormatting: Object.keys(engineFormatting).length ? engineFormatting : undefined })
  }
  function formatStyle(patch: Partial<SqlFormattingStyle>) {
    if (scope === 'global') change(patch)
    else if (!inherits) change({ engineFormatting: { ...draft.engineFormatting, [scope]: { ...style, ...patch } } })
  }
  function spacing(patch: Partial<EditorSettings['formatting']>) { formatStyle({ formatting: { ...style.formatting, ...patch } }) }
  function apply() {
    if (operation.current) return
    const parsed = editorSettingsSchema.safeParse(draft)
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path, engine = engineSchema.safeParse(path?.[1])
      // An invalid draft can be hidden after switching the formatting scope.
      if (path?.[0] === 'engineFormatting' && engine.success) {
        setScope(engine.data); setError(`Check the ${engineNames[engine.data]} formatting values. Enter whole numbers within the ranges shown.`)
      } else if (path?.[0] === 'shortcuts') setError('Choose a different shortcut for each action, or None.')
      else { if (path?.[0] === 'formatting') setScope('global'); setError('Enter whole numbers within the ranges shown.') }
      return
    }
    onApply(parsed.data); onClose()
  }
  const numberValue = (value: number) => Number.isFinite(value) ? value : ''
  return <dialog ref={dialog} className="connection-dialog editor-settings-dialog" aria-labelledby="editor-settings-title"
    aria-busy={Boolean(busy)} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!operation.current) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); apply() }}>
      <div className="dialog-heading"><div><h2 id="editor-settings-title">Editor settings</h2><p>Applies to all query tabs.</p></div><button type="button" disabled={Boolean(busy)} aria-label="Close editor settings" onClick={onClose}>×</button></div>
      <div className="editor-settings-fields">
      <fieldset disabled={Boolean(busy)}><legend>Display</legend>
        <label>Appearance<select aria-label="Appearance" value={draft.appearance ?? 'dark'} onChange={event => change({ appearance: event.target.value as EditorSettings['appearance'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
        <div className="form-row">
          <label>Font size (10–32 px)<input autoFocus type="number" required min={10} max={32} step={1} value={numberValue(draft.fontSize)} onChange={event => change({ fontSize: event.target.valueAsNumber })}/></label>
          <label>Line numbers<select aria-label="Line numbers" value={draft.lineNumbers} onChange={event => change({ lineNumbers: event.target.value as EditorSettings['lineNumbers'] })}><option value="on">Absolute</option><option value="relative">Relative</option><option value="off">Hidden</option></select></label>
        </div>
        <label className="check-field"><input type="checkbox" checked={draft.wordWrap} onChange={event => change({ wordWrap: event.target.checked })}/>Wrap long lines</label>
        <label className="check-field"><input type="checkbox" checked={draft.minimap} onChange={event => change({ minimap: event.target.checked })}/>Show minimap</label>
        <label className="check-field"><input type="checkbox" checked={draft.automaticSuggestions} onChange={event => change({ automaticSuggestions: event.target.checked })}/>Automatic suggestions</label>
        <p>Ctrl+Space opens suggestions even when automatic suggestions are off.</p>
      </fieldset>
      <fieldset disabled={Boolean(busy)}><legend>Editor shortcuts</legend>
        {([['run', 'Run selection or script'], ['current', 'Run current statement / batch'], ['format', 'Format SQL']] as [keyof EditorShortcuts, string][]).map(([action, label]) => <label key={action}>{label}<select aria-label={label} value={(draft.shortcuts ?? DEFAULT_EDITOR_SHORTCUTS)[action]} onChange={event => change({ shortcuts: { ...(draft.shortcuts ?? DEFAULT_EDITOR_SHORTCUTS), [action]: event.target.value as EditorShortcut } })}>
          {editorShortcutSchema.options.map(key => <option key={key} value={key}>{shortcutLabel(key, navigator.platform.toLowerCase().includes('mac'))}</option>)}
        </select></label>)}
        <p>Applies while a query editor has focus. Choose a different shortcut for each action. File, panel and navigation shortcuts stay fixed.</p>
      </fieldset>
      <fieldset disabled={Boolean(busy)}><legend>Indentation</legend>
        <div className="form-row">
          <label>Indent using<select aria-label="Indent using" value={draft.insertSpaces ? 'spaces' : 'tabs'} onChange={event => change({ insertSpaces: event.target.value === 'spaces' })}><option value="spaces">Spaces</option><option value="tabs">Tabs</option></select></label>
          <label>Indent width (1–8)<input type="number" required min={1} max={8} step={1} value={numberValue(draft.tabSize)} onChange={event => change({ tabSize: event.target.valueAsNumber })}/></label>
        </div>
        <p>Used for typing, tab display width and default SQL formatting. Custom database formatting below applies only to Format SQL. Existing text stays unchanged until edited or formatted.</p>
      </fieldset>
      <fieldset disabled={Boolean(busy)}><legend>SQL formatting</legend>
        <label>Formatting settings for<select aria-label="Formatting settings for" value={scope} onChange={event => { setScope(event.target.value as typeof scope); setError('') }}>
          <option value="global">Global defaults</option>
          {engineSchema.options.map(engine => <option key={engine} value={engine}>{engineNames[engine]}{draft.engineFormatting?.[engine] ? ' (custom)' : ''}</option>)}
        </select></label>
        {scope !== 'global' && <>
          <label className="check-field"><input type="checkbox" checked={!inherits} onChange={event => customFormatting(event.target.checked)}/>Use custom formatting</label>
          <p>{inherits ? 'Using global defaults. Changes to global defaults apply to this database type.' : 'Applies to every query tab using this database type. Turn off custom formatting to use global defaults again.'}</p>
          <div className="form-row">
            <label>Format indentation<select aria-label="Format indentation" disabled={inherits} value={style.insertSpaces ? 'spaces' : 'tabs'} onChange={event => formatStyle({ insertSpaces: event.target.value === 'spaces' })}><option value="spaces">Spaces</option><option value="tabs">Tabs</option></select></label>
            <label>Format indent width (1–8)<input disabled={inherits} type="number" required min={1} max={8} step={1} value={numberValue(style.tabSize)} onChange={event => formatStyle({ tabSize: event.target.valueAsNumber })}/></label>
          </div>
        </>}
        <div className="form-row">
          <label>Inline expression width (20–200)<input disabled={inherits} type="number" required min={20} max={200} step={1} value={numberValue(style.formatting.expressionWidth)} onChange={event => spacing({ expressionWidth: event.target.valueAsNumber })}/></label>
          <label>Blank lines between statements (0–3)<input disabled={inherits} type="number" required min={0} max={3} step={1} value={numberValue(style.formatting.linesBetweenQueries)} onChange={event => spacing({ linesBetweenQueries: event.target.valueAsNumber })}/></label>
        </div>
        <p>Width controls when expressions expand across lines; it is not a line-length limit. Formatting preserves letter case, literals and parameters.</p>
      </fieldset>
      <details className="editor-settings-transfer"><summary>Import and export settings</summary>
      <fieldset disabled={Boolean(busy)}><legend>Import and export</legend>
        <div className="editor-settings-file-actions"><button type="button" onClick={() => void transfer('import')}>Import settings</button><button type="button" onClick={() => void transfer('export')}>Export applied settings</button></div>
        <p>Import replaces this draft for review before Apply. Export includes applied editor and formatting preferences only. Choose a new JSON filename; existing files are kept.</p>
      </fieldset>
      {(busy || notice) && <p className="editor-settings-file-notice" role="status">{busy === 'import' ? 'Reading editor settings…' : busy === 'export' ? 'Exporting applied editor settings…' : notice}</p>}
      </details>
      </div>
      <div className="editor-settings-footer">
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={Boolean(busy)} onClick={() => { setDraft(DEFAULT_EDITOR_SETTINGS); setScope('global'); setError(''); setNotice('') }}>Reset defaults</button><span className="tabs-spacer"/><button type="button" disabled={Boolean(busy)} onClick={onClose}>Cancel</button><button type="submit" disabled={Boolean(busy)} className="primary-button">Apply settings</button></div>
      </div>
    </form>
  </dialog>
}
