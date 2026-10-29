import { useEffect, useRef, useState } from 'react'
import { X } from './WorkbenchIcons'
import type { CatalogObject, ObjectDetail } from '../shared/catalog'
import type { DatabaseEngine } from '../shared/database-engines'
import { objectScripts } from '../shared/object-scripts'
export interface ObjectView { tabId: string; sessionId: string; object: CatalogObject; loading: boolean; detail?: ObjectDetail; error?: string }
export function ObjectInspector({ view, engine, onClose, onRefresh, onOpen }: { view: ObjectView; engine: DatabaseEngine; onClose(): void; onRefresh(): void; onOpen(sql: string, title: string): void }) {
  const ref = useRef<HTMLDialogElement>(null), [message, setMessage] = useState(''), [script, setScript] = useState<'create' | 'alter' | 'drop'>('create')
  useEffect(() => { const node = ref.current!; node.showModal(); return () => node.close() }, [])
  const detail = view.detail, definition = detail?.definition, sql = definition?.sql, usable = Boolean(sql && !definition?.truncated && !view.loading)
  const scripts = detail && objectScripts(engine, view.object, detail), selectedScript = scripts?.[script]
  async function copy() { try { await window.dbCommander.copyDefinition(sql!); setMessage('Definition copied.') } catch { setMessage('Could not copy. Select the definition or save it to a file.') } }
  async function save() { try { if (await window.dbCommander.saveSql(sql!)) setMessage('Definition saved.') } catch (error) { setMessage((error as Error).message) } }
  return <dialog ref={ref} className="connection-dialog object-inspector" aria-label="Object details" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!view.loading) onClose() }}>
    <div className="dialog-heading"><div><h2>{view.object.name}</h2><p>{[view.object.catalog,view.object.schema,view.object.kind].filter(Boolean).join(' · ')}{view.object.parent ? ` · on ${view.object.parent}` : ''}</p>{view.object.signature && <code>{view.object.signature}</code>}</div><button disabled={view.loading} aria-label="Close object details" onClick={onClose}><X size={18}/></button></div>
    <div className="object-actions"><button disabled={view.loading} onClick={onRefresh}>Refresh object</button><button disabled={!usable} onClick={() => void copy()}>Copy definition</button><button disabled={!usable} onClick={() => void save()}>Save definition</button><button disabled={!usable} onClick={() => onOpen(sql!, `${view.object.name}.sql`)}>Open definition in new tab</button></div>
    {view.loading && <p role="status">Loading object details…</p>}{view.error && <p role="alert">{view.error}</p>}{message && <p role="status">{message}</p>}
    {detail && <><p className="object-source">Read {new Date(detail.fetchedAt).toLocaleTimeString()} · {detail.source === 'session' ? 'This tab’s catalog and transaction' : 'Separate catalog connection; committed metadata only'}. Opening or copying a definition does not execute it.</p>
      <h3>Definition <small>{definition!.source === 'generated' ? 'Generated summary' : definition!.source === 'native' ? 'From database metadata' : 'Unavailable'}</small></h3>
      {definition!.notice && <p>{definition!.notice}</p>}{definition!.truncated && <p role="alert">Definition exceeds the display limit and is incomplete. Copy, save and open are disabled.</p>}
      {sql && <textarea aria-label="Object definition" className="object-definition" readOnly spellCheck={false} value={sql}/>}
      {scripts && ['view', 'function', 'procedure', 'trigger', 'macro'].includes(view.object.kind) && <section aria-label="Object scripts"><h3>Object scripts</h3><p>{scripts.notice}</p><label>Script <select aria-label="Object script" value={script} onChange={event => setScript(event.target.value as typeof script)}><option value="create" disabled={!scripts.create}>Create</option><option value="alter" disabled={!scripts.alter}>Alter</option><option value="drop" disabled={!scripts.drop}>Drop</option></select></label>{selectedScript ? <><textarea aria-label="Object script preview" className="object-definition" readOnly spellCheck={false} value={selectedScript}/><div className="object-actions"><button disabled={view.loading} onClick={() => onOpen(selectedScript, `${view.object.name}-${script}.sql`)}>Open script in new tab</button></div></> : <p>The selected script is unavailable for this definition. Choose another available operation.</p>}</section>}
      {detail.sections.map(section => <details className="object-section" key={section.title} open><summary>{section.title} ({section.rows.length}{section.truncated ? '+' : ''})</summary>{section.truncated && <p>Metadata display limit reached; some rows or values are incomplete.</p>}{section.rows.length ? <div className="object-table-scroll"><table aria-label={section.title}><thead><tr>{section.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{section.rows.map((row,index) => <tr key={index}>{row.map((cell,i) => <td key={i}>{cell === null ? <em>—</em> : cell}</td>)}</tr>)}</tbody></table></div> : <p>No entries visible.</p>}</details>)}
    </>}
  </dialog>
}
