import type { SchemaColumnInput } from '../shared/schema-changes'

export function SchemaDefaultFields({ value, onChange, label }: { value: SchemaColumnInput['default']; onChange(value: SchemaColumnInput['default']): void; label: string }) {
  return <><label>Default<select aria-label={`${label} default kind`} value={value.kind} onChange={e => { const kind = e.target.value; onChange(kind === 'text' || kind === 'number' || kind === 'expression' ? { kind, value: kind === 'number' ? '0' : '' } : kind === 'boolean' ? { kind, value: false } : { kind: kind as 'none' | 'null' }) }}>{['none','text','number','boolean','null','expression'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
    {(value.kind === 'text' || value.kind === 'number') && <label>Literal value<input aria-label={`${label} default value`} value={value.value} onChange={e => onChange({ kind: value.kind as 'text' | 'number', value: e.target.value })}/></label>}
    {value.kind === 'boolean' && <label>Value<select aria-label={`${label} default value`} value={String(value.value)} onChange={e => onChange({ kind: 'boolean', value: e.target.value === 'true' })}><option>false</option><option>true</option></select></label>}
    {value.kind === 'expression' && <label>SQL expression<input aria-label={`${label} default expression`} maxLength={4000} value={value.value} onChange={e => onChange({ kind: 'expression', value: e.target.value })}/></label>}
  </>
}
