import { objectKey, type CatalogObject } from '../shared/catalog'
import type { DatabaseEngine, SchemaSnapshot } from '../shared/contracts'
import type { TableConstraint } from '../shared/schema-changes'

export const freshConstraint = (): TableConstraint => ({ kind: 'check', name: '', expression: '' })
export function SchemaConstraintFields({ value, onChange, engine, localColumns, objects, snapshot, index }: {
  value: TableConstraint; onChange(value: TableConstraint): void; engine: DatabaseEngine; localColumns: string[];
  objects: CatalogObject[]; snapshot: SchemaSnapshot | null; index: number
}) {
  const label = `Constraint ${index + 1}`
  const referenced = value.kind === 'foreign' && value.reference.kind === 'table' ? value.reference.table : undefined
  const referencedColumns = value.kind !== 'foreign' ? [] : !referenced ? localColumns : snapshot?.objects.find(o => o.name === referenced.name && o.schema === referenced.schema && o.catalog === referenced.catalog)?.columns.map(c => c.name) ?? []
  const actionOptions = (direction: 'delete' | 'update') => engine === 'duckdb' ? ['no-action'] : engine === 'oracle' ? direction === 'update' ? ['no-action'] : ['no-action', 'cascade', 'set-null'] : ['sqlserver','azure-sql'].includes(engine) ? ['no-action', 'cascade', 'set-null', 'set-default'] : ['mysql','mariadb'].includes(engine) ? ['no-action', 'restrict', 'cascade', 'set-null'] : ['no-action', 'restrict', 'cascade', 'set-null', 'set-default']
  return <fieldset className="schema-column"><legend>{label}</legend><div className="schema-edit-row">
    <label>Name<input aria-label={`${label} name`} value={value.name} onChange={e => onChange({ ...value, name: e.target.value })}/></label>
    <label>Kind<select aria-label={`${label} kind`} value={value.kind} onChange={e => {
      const kind = e.target.value
      onChange(kind === 'unique' ? { kind, name: value.name, columns: [] } : kind === 'foreign' ? { kind, name: value.name, columns: [], reference: { kind: 'self' }, referencedColumns: [], onDelete: 'no-action', onUpdate: 'no-action' } : { kind: 'check', name: value.name, expression: '' })
    }}><option value="check">Check</option><option value="unique">Unique</option><option value="foreign">Foreign key</option></select></label>
  </div>
    {value.kind === 'check' && <label>Check SQL expression<input aria-label={`${label} expression`} maxLength={4000} value={value.expression} onChange={e => onChange({ ...value, expression: e.target.value })}/></label>}
    {value.kind !== 'check' && <fieldset><legend>Columns (selection order)</legend>{localColumns.filter(Boolean).map(name => <label className="check-field" key={name}><input aria-label={`${label} column ${name}`} type="checkbox" checked={value.columns.includes(name)} onChange={e => onChange({ ...value, columns: e.target.checked ? [...value.columns, name] : value.columns.filter(c => c !== name) })}/>{name}{value.columns.includes(name) ? ` (${value.columns.indexOf(name) + 1})` : ''}</label>)}</fieldset>}
    {value.kind === 'foreign' && <><label>Referenced table<select aria-label={`${label} referenced table`} value={referenced ? objectKey(referenced) : 'self'} onChange={e => { const table = objects.find(object => objectKey(object) === e.target.value); onChange({ ...value, reference: table ? { kind: 'table', table } : { kind: 'self' }, referencedColumns: [] }) }}><option value="self">This table</option>{objects.map(object => <option value={objectKey(object)} key={objectKey(object)}>{[object.catalog,object.schema,object.name].filter(Boolean).join('.')}</option>)}</select></label>
      <fieldset><legend>Referenced columns (matching order)</legend>{referencedColumns.map(name => <label className="check-field" key={name}><input aria-label={`${label} referenced column ${name}`} type="checkbox" checked={value.referencedColumns.includes(name)} onChange={e => onChange({ ...value, referencedColumns: e.target.checked ? [...value.referencedColumns,name] : value.referencedColumns.filter(c => c !== name) })}/>{name}{value.referencedColumns.includes(name) ? ` (${value.referencedColumns.indexOf(name) + 1})` : ''}</label>)}{referenced && !referencedColumns.length && <p>Refresh the database objects to load the referenced columns.</p>}</fieldset>
      <div className="schema-edit-row">{(['delete','update'] as const).map(direction => <label key={direction}>On {direction}<select aria-label={`${label} on ${direction}`} value={direction === 'delete' ? value.onDelete : value.onUpdate} onChange={e => onChange({ ...value, [direction === 'delete' ? 'onDelete' : 'onUpdate']: e.target.value as typeof value.onDelete })}>{actionOptions(direction).map(action => <option key={action} value={action}>{action.replaceAll('-', ' ')}</option>)}</select></label>)}</div>
    </>}
  </fieldset>
}
