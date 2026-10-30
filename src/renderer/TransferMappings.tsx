import { useEffect, useState } from 'react'
import type { DatabaseEngine } from '../shared/contracts'
import type { ImportPreview } from '../shared/transfer'
import { compatibleMapping, type TransferMapping } from '../shared/transfer-mappings'

export function TransferMappings({ engine, preview, mapping, disabled, onChange }: { engine: DatabaseEngine; preview: ImportPreview; mapping: (string | null)[]; disabled: boolean; onChange(mapping: (string | null)[]): void }) {
  const [saved, setSaved] = useState<TransferMapping[]>([]), [selected, setSelected] = useState(''), [name, setName] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { void window.dbCommander.transferMappings().then(setSaved).catch(error => setMessage(error.message)) }, [])
  const compatible = saved.filter(item => compatibleMapping(item, engine, preview.headers, preview.columns))
  async function save(remove = false) {
    setBusy(true); setMessage('')
    try {
      if (remove) { await window.dbCommander.removeTransferMapping(selected); setSaved(saved.filter(item => item.id !== selected)); setSelected(''); setName(''); setMessage('Saved mapping removed.') }
      else {
        const value = await window.dbCommander.saveTransferMapping({ id: selected || crypto.randomUUID(), name, engine, headers: preview.headers, columns: preview.columns.map(({ name, type }) => ({ name, type })), mapping })
        setSaved([...saved.filter(item => item.id !== value.id), value]); setSelected(value.id); setMessage('Mapping saved. No paths, rows, SQL or credentials were saved.')
      }
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <fieldset disabled={disabled || busy} className="transfer-saved-mappings"><legend>Saved mappings</legend>
    <p>Reuse mappings when the engine, source headers and reviewed target columns match. Up to 50 named mappings are stored in this workspace.</p>
    <div className="form-row"><label>Saved mapping<select aria-label="Saved mapping" value={selected} onChange={event => { const id = event.target.value; setSelected(id); const item = compatible.find(item => item.id === id); setName(item?.name ?? ''); if (item) onChange([...item.mapping]); setMessage('') }}><option value="">New mapping</option>{compatible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Mapping name<input maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label></div>
    <button disabled={!name.trim()} onClick={() => void save()}>{selected ? 'Update mapping' : 'Save mapping'}</button><button disabled={!selected} onClick={() => void save(true)}>Remove saved mapping</button>
    {message && <p role="status">{message}</p>}
  </fieldset>
}
