import { useEffect, useRef, useState } from 'react'
import { engineNames } from '../shared/contracts'
import { planSnippetImport, type SnippetImportPreview, type SnippetImportRequest, type SnippetImportResult } from '../shared/snippet-files'

export function SnippetImportDialog({ preview, onImported, onClose }: { preview: SnippetImportPreview; onImported(result: SnippetImportResult): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState(preview.snippets.map((_, i) => i))
  const [duplicates, setDuplicates] = useState<SnippetImportRequest['duplicates']>('skip'), [active, setActive] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  const actions = planSnippetImport(preview.snippets, preview.existing, selected, duplicates), imported = actions.filter(a => !a.skip).length
  const snippet = preview.snippets[active]
  function close() { if (!busy) onClose() }
  return <dialog ref={dialog} className="connection-dialog library-dialog" aria-label="Import snippets" onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); e.stopPropagation(); close() }}>
    <div className="dialog-heading"><h2>Import snippets</h2><button aria-label="Close snippet import" disabled={busy} onClick={close}>×</button></div>
    <p>{preview.sourceName} · {preview.snippets.length} snippets. Review the SQL before importing. Import saves snippets locally; it does not execute SQL or change any connection.</p>
    <div className="library-filters"><label>Duplicate names<select aria-label="Duplicate snippets" disabled={busy} value={duplicates} onChange={e => setDuplicates(e.target.value as typeof duplicates)}><option value="skip">Skip duplicates</option><option value="copy">Keep both with new names</option></select></label><button disabled={busy} onClick={() => setSelected(preview.snippets.map((_, i) => i))}>Select all snippets</button><button disabled={busy} onClick={() => setSelected([])}>Clear snippet selection</button></div>
    <p>Names match without case differences within the same engine. Existing snippets are never replaced. This preview expires in ten minutes; changes to saved snippets require a new review.</p>
    <div className="library-content"><div className="library-list" aria-label="Snippets to import">{preview.snippets.map((s, i) => {
      const action = actions.find(a => a.index === i)
      return <div className="snippet-import-row" key={i}><input type="checkbox" aria-label={`Import snippet ${i + 1}: ${s.name}`} disabled={busy} checked={selected.includes(i)} onChange={e => setSelected(old => e.target.checked ? [...old, i] : old.filter(n => n !== i))}/><button disabled={busy} aria-pressed={active === i} onClick={() => setActive(i)}><strong>{s.name}</strong><small>{s.engine ? engineNames[s.engine] : 'Any engine'} · {action?.skip ? 'Skip duplicate' : action?.renamed ? `Import as ${action.snippet.name}` : action ? 'Import' : 'Not selected'}</small></button></div>
    })}</div><div className="library-detail"><h3>{snippet.name}</h3><p>{snippet.description || 'No description'}{snippet.favorite ? ' · Favorite' : ''}</p><textarea aria-label="SQL to import" readOnly value={snippet.sql}/></div></div>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><span>{imported} to import · {actions.length - imported} duplicates skipped</span><button disabled={busy} onClick={close}>Cancel</button><button disabled={busy || !selected.length} onClick={async () => {
      setBusy(true); setError('')
      try { onImported(await window.dbCommander.applySnippetImport({ reviewId: preview.reviewId, selected, duplicates })) }
      catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>Import selected snippets</button></div>
  </dialog>
}
