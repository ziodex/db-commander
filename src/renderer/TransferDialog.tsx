import { useEffect, useRef, useState } from 'react'
import { X } from './WorkbenchIcons'
import type { GridTable, SchemaTable, SessionInfo } from '../shared/contracts'
import type { DataFilePreview, DatabaseCopyReview, ExportFormat, ImportPreview, TransferJob, TransferRequest } from '../shared/transfer'
import { quoteIdentifier } from '../shared/sql/common'
import { parameterNames } from '../shared/parameters'
import { ParameterDialog } from './ParameterDialog'
import { validateExportSql } from '../shared/export-query'
import { TransferMappings } from './TransferMappings'
import { CreateImportTable } from './CreateImportTable'
import type { ApplySchemaChange, SchemaChange, SchemaChangePlan, SchemaChangeResult } from '../shared/schema-changes'

export function TransferDialog({ session, tables, sql, sourceLabel, jobs, blocked, sources = [], onPrepareTable, onApplyTable, onCommitTable, onClose }: {
  sources?: { session: SessionInfo; title: string; disabled: boolean }[]; onPrepareTable(change: SchemaChange): Promise<SchemaChangePlan>; onApplyTable(request: ApplySchemaChange): Promise<SchemaChangeResult>; onCommitTable(): void;
  session: SessionInfo | null; tables: SchemaTable[]; sql: string; sourceLabel?: string; jobs: TransferJob[]; blocked: boolean; onClose(): void
}) {
  const api = window.dbCommander
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = dialogRef.current!; dialog.showModal(); return () => dialog.close() }, [])
  const [action, setAction] = useState<'export' | 'import' | 'copy'>('export')
  const [format, setFormat] = useState<ExportFormat>('csv'), [file, setFile] = useState('')
  const [insertTable, setInsertTable] = useState(''), [insertSchema, setInsertSchema] = useState('')
  const [query, setQuery] = useState(sql), [target, setTarget] = useState('0')
  const [preview, setPreview] = useState<ImportPreview | null>(null), [mapping, setMapping] = useState<(string | null)[]>([])
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [sourceId, setSourceId] = useState(''), [capture, setCapture] = useState<DatabaseCopyReview>(), [inference, setInference] = useState<DataFilePreview>(), [createdTable, setCreatedTable] = useState<GridTable>(), [createdNotice, setCreatedNotice] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [parameterExport, setParameterExport] = useState<{ request: Extract<TransferRequest, { action: 'export' | 'capture' }>; names: string[] }>()
  useEffect(() => { setParameterExport(undefined) }, [session?.id])
  const job = jobs.find(job => job.id === selected), table = createdTable ?? tables[Number(target)], source = sources.find(item => item.session.id === sourceId), querySession = action === 'copy' ? source?.session : session
  let exportError = ''
  if ((action === 'export' || action === 'copy' && !capture) && querySession) {
    try { validateExportSql(query, querySession.engine, querySession.mysqlSqlMode) }
    catch (error) { exportError = (error as Error).message }
  }
  function reset() { if (capture) void api.discardTransferCapture(capture.id).catch(error => setError(error.message)); setCapture(undefined); setPreview(null); setConfirmed(false); setError('') }
  async function choose() {
    try { const path = await api.chooseTransferFile({ save: action === 'export', format }); if (path) { setFile(path); reset() } }
    catch (error) { setError((error as Error).message) }
  }
  async function inspect() {
    if (!session || !table || format === 'sql') return
    setBusy(true); setError(''); setConfirmed(false); setPreview(null)
    try {
      const result = await api.inspectImport({ sessionId: session.id, file, format, table: { catalog: table.catalog, schema: table.schema, name: table.name } })
      setPreview(result)
      setMapping(result.headers.map(header => {
        const matches = result.columns.filter(column => !column.generated && column.name.toLowerCase() === header.toLowerCase())
        return matches.length === 1 ? matches[0].name : null
      }))
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function infer() {
    if (format === 'sql') return
    setBusy(true); setError('')
    try { setInference(await api.inspectDataFile({ file, format })) } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  async function submit(request: TransferRequest) {
    if (!session || (request.action === 'capture' ? session.id !== request.targetSessionId || !source || source.disabled || source.session.id !== request.sessionId : session.id !== request.sessionId) || blocked) throw new Error('The target session changed or is busy. Close this prompt and review the transfer again.')
    setBusy(true); setError('')
    try {
      const job = await api.startTransfer(request); setSelected(job.id); setPreview(null); setCapture(undefined); setConfirmed(false); setParameterExport(undefined)
    } finally { setBusy(false) }
  }
  async function start() {
    if (!session || blocked || !confirmed || (action === 'export' || action === 'copy' && !capture) && exportError || action === 'import' && (!preview || !table) || action === 'copy' && (!table || !capture && (!source || source.disabled))) return
    setError('')
    try {
      let request: TransferRequest
      if (action === 'copy') {
        if (!table) return
        request = capture ? { action: 'copy', sessionId: session.id, captureId: capture.id, mapping, signature: capture.preview.signature, confirmed: true } : { action: 'capture', sessionId: source!.session.id, targetSessionId: session.id, table: { schema: table.schema, name: table.name, ...(table.catalog ? { catalog: table.catalog } : {}) }, sql: query, confirmed: true }
      } else if (action === 'export') request = { action, sessionId: session.id, file, format, sql: query, confirmed: true,
        ...(format === 'sql' ? { insertTarget: { name: insertTable, ...(insertSchema ? { schema: insertSchema } : {}) } } : {}) }
      else {
        if (format === 'sql') return
        request = { action, sessionId: session.id, file, format, table: { catalog: table.catalog, schema: table.schema, name: table.name }, mapping, signature: preview!.signature, confirmed: true }
      }
      if (request.action === 'export' || request.action === 'capture') {
        const names = parameterNames(query, querySession!.engine, querySession!.mysqlSqlMode?.noBackslashEscapes, querySession!.mysqlSqlMode?.ansiQuotes)
        if (names.length > 100) throw new Error('A query may use up to 100 distinct named parameters.')
        if (names.length) { setParameterExport({ request, names }); return }
      }
      await submit(request)
    } catch (error) { setError((error as Error).message) }
  }
  return <dialog ref={dialogRef} className="connection-dialog transfer-dialog" aria-label={sourceLabel ? 'Export all rows' : 'Data import and export'} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>{sourceLabel ? 'Export all rows' : 'Data import and export'}</h2><p>{session ? `${session.name} · ${session.host} · ${session.database || 'Server connection'}` : 'Connect a database to transfer data.'}</p></div><button disabled={busy} aria-label="Close data transfer" onClick={onClose}><X size={18} /></button></div>
    {sourceLabel && <p className="transfer-source">Source preview: {sourceLabel}. This export runs the reviewed query again; it does not export the cached preview.</p>}
    {error && <p role="alert" className="backup-error">{error}</p>}
    {job ? <div className="backup-job-detail"><h3>{job.action === 'import' || job.action === 'copy' ? 'Import' : job.action === 'capture' ? 'Database source capture' : 'Full-result export'}</h3><p role="status">{job.status} · {job.rows.toLocaleString()} rows</p><p>{job.phase}</p><p className="backup-path">{job.file}</p>
      {job.status === 'running' && <button disabled={job.cancellationRequested} onClick={() => void api.cancelTransfer(job.id).catch(error => setError(error.message))}>{job.cancellationRequested ? 'Cancellation requested' : 'Cancel transfer'}</button>}
      {job.capture && job.status === 'completed' && job.capture.targetSessionId === session?.id && <button onClick={() => { setCreatedTable(job.capture!.table); setTarget('created'); setCapture(job.capture); setPreview(job.capture!.preview); setMapping(job.capture!.preview.headers.map(header => job.capture!.preview.columns.find(column => !column.generated && column.name === header)?.name ?? null)); setSelected(null); setAction('copy'); setConfirmed(false) }}>Review captured rows</button>}
      {job.capture && <><p>Review this capture in its destination connection tab.</p><button onClick={() => void api.discardTransferCapture(job.capture!.id).catch(error => setError(error.message))}>Discard captured rows</button></>}
      <button disabled={job.status === 'running'} onClick={() => { setSelected(null); reset() }}>Configure another transfer</button>
    </div> : session && <>
      <fieldset disabled={busy}>
        <div className="form-row">{!sourceLabel && <label>Transfer operation<select value={action} onChange={event => { setAction(event.target.value as typeof action); setFormat('csv'); setFile(''); reset() }}><option value="export">Export full query result</option><option value="import">Import a file</option><option value="copy">Copy from another connection</option></select></label>}
        {action !== 'copy' && <label>Data format<select value={format} onChange={event => { setFormat(event.target.value as typeof format); setFile(''); reset() }}><option value="csv">CSV (UTF-8)</option><option value="tsv">TSV (UTF-8)</option><option value="json">JSON (columns and rows)</option><option value="jsonl">JSON Lines (header and array rows)</option>{action === 'export' && <option value="sql">SQL INSERT script</option>}</select></label>}</div>
        {action !== 'copy' && <><label>{action === 'export' ? 'New export file' : 'Import file'}<input value={file} onChange={event => { setFile(event.target.value); reset() }} /></label><button onClick={() => void choose()}>{action === 'export' ? 'Choose export destination' : 'Choose import file'}</button></>}
        {action === 'copy' && !capture && <><label>Source connection<select value={sourceId} onChange={event => { setSourceId(event.target.value); reset() }}><option value="">Choose an independent connection</option>{sources.filter(item => item.session.id !== session.id).map(item => <option key={item.session.id} disabled={item.disabled} value={item.session.id}>{item.title} · {item.session.name} · {item.session.database}</option>)}</select></label><label>Source SQL to capture<textarea className="transfer-sql" value={query} onChange={event => { setQuery(event.target.value); setConfirmed(false) }}/></label><p>Capture the complete result once into a private temporary file, then review mappings. This reserves both connections during capture. Source functions can have side effects. The reviewed captured rows are imported without running the source query again; captures expire after ten minutes.</p>{exportError && <p role="alert">{exportError}</p>}</>}
        {action === 'copy' && capture && <p>Captured {capture.rows.toLocaleString()} rows. Expires {new Date(capture.expiresAt).toLocaleTimeString()}. The source query will not run again. Text representations are imported under destination type rules; this is not a schema or binary-type migration.</p>}
        {action === 'export' ? <><label>SQL to execute for export<textarea className="transfer-sql" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setConfirmed(false) }} /></label><p>Runs this SELECT again in this tab and exports every returned row, beyond the preview limit. Current data may differ from the preview. SQL functions can have side effects. Existing files are never replaced.</p><p>Use :name placeholders to enter bound values before export. Values are used once and are not saved; exported rows may contain those values.</p>
          {exportError && <p role="alert" className="backup-error">{exportError} Review one read query here, or select it explicitly in the editor.</p>}
          {format === 'sql' ? <>
            <div className="form-row"><label>INSERT export schema or database (optional)<input maxLength={255} value={insertSchema} onChange={event => { setInsertSchema(event.target.value); setConfirmed(false) }} /></label><label>INSERT export table<input maxLength={255} value={insertTable} onChange={event => { setInsertTable(event.target.value); setConfirmed(false) }} /></label></div>
            <p>Enter identifier names without SQL quoting. Result column names become INSERT columns; alias duplicates and omit generated or identity columns in the SELECT.</p>
            {insertTable && <pre className="insert-export-preview" aria-label="INSERT destination preview">{`INSERT INTO ${[insertSchema || undefined, insertTable].filter((value): value is string => value !== undefined).map(value => quoteIdentifier(value, session.engine)).join('.')} (<result columns>) VALUES (<row values>);`}</pre>}
            <p>Writes one INSERT per row for {session.engine}. The script is not executed and does not create tables or add transaction or identity commands. Review it before running against a compatible table. Destination types and constraints still apply.</p>
            <p>Supports known scalar result types, up to 100 columns and 16,384 characters per value. Unsupported or ambiguous types fail the export without publishing a partial file. SQLite expressions without declared types and ambiguous hex text require JSON export; Oracle literal limits also apply.</p>
          </> : <p>CSV/TSV uses unquoted \N for NULL and quotes all text, including empty strings. JSON preserves exact values as strings or null, with separate column metadata. JSON Lines writes the columns object on the first line and one array per subsequent line. No spreadsheet formula escaping is applied.</p>}
        </> : <>
          <label>Import target table<select value={target} onChange={event => { setTarget(event.target.value); setCreatedTable(undefined); reset() }}>{createdTable && <option value="created">{createdTable.schema}.{createdTable.name} · {capture ? 'reviewed destination' : 'newly created'}</option>}{tables.map((table, index) => <option key={index} value={index}>{[table.catalog, table.schema, table.name].filter(Boolean).join('.')}</option>)}</select></label>
          <p>Append rows to an existing table. Omitted columns use database defaults. Errors roll back the entire import; successful imports await Commit or Rollback.</p>
          {action === 'import' && <><button disabled={blocked || !file || format === 'sql'} onClick={() => void infer()}>Create table from file preview</button>{createdNotice && <p role="status">{session.transaction === 'idle' ? 'Empty table created. Preview and map the file to import rows. If row import fails, this empty table remains.' : createdNotice}</p>}{createdTable && session.transaction === 'transaction' && <button onClick={onCommitTable}>Commit created table and continue</button>}</>}
          {action === 'import' && (format === 'json' || format === 'jsonl' ? <p>{format === 'jsonl' ? 'JSON Lines starts with a columns object on one line, followed by one array per line.' : 'Use Db Commander JSON exports:'}  Columns first, then rows. Cells must be strings or null; quote numbers to preserve precision. Column type metadata is informational; mappings use the target table’s types. Duplicate or empty column names, nested values and other JSON formats are not supported.</p> : <p>The first record must contain unique headers. Unquoted \N means NULL; empty fields remain empty strings.</p>)}
          <p>Preview reads at most 10 records; the rest of the file is validated during import. Limits: 100 columns and 16,384 characters per cell. Oracle stores empty strings as NULL.</p>
          {action === 'import' && <button disabled={blocked || !file || !table} onClick={() => void inspect()}>{busy ? 'Reading preview…' : 'Preview and map columns'}</button>}
          {preview && <><TransferMappings key={preview.signature} engine={session.engine} preview={preview} mapping={mapping} disabled={blocked} onChange={values => { setMapping(values); setConfirmed(false) }}/><h3>Column mapping</h3><div className="transfer-mapping">{preview.headers.map((header, index) => <label key={index}>{header}<select aria-label={`Map ${header}`} value={mapping[index] ?? ''} onChange={event => { setMapping(mapping.map((value, i) => i === index ? event.target.value || null : value)); setConfirmed(false) }}><option value="">Skip source column</option>{preview.columns.filter(column => !column.generated).map(column => <option key={column.name} value={column.name}>{column.name} · {column.type}{column.nullable ? '' : ' · required'}</option>)}</select></label>)}</div>
            <h3>First {preview.rows.length} data records</h3><div className="transfer-preview"><table><thead><tr>{preview.headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{row.map((value, i) => <td key={i}>{value === null ? <em>NULL</em> : value === '' ? <em>Empty string</em> : value}</td>)}</tr>)}</tbody></table></div></>}
        </>}
        {blocked && <p>Finish this tab’s query or transaction and apply or discard staged edits first.</p>}
        <label className="save-profile-option"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{action === 'export' ? 'I have reviewed the SQL and new destination.' : action === 'copy' && !capture ? 'I have reviewed the source SQL and both connections and destination table.' : 'I have reviewed the captured data or file, target and column mapping.'}</label>
        <div className="dialog-actions"><button className="primary-button" disabled={blocked || action !== 'copy' && !file || !confirmed || action === 'copy' && (!table || !capture && (!source || source.disabled || Boolean(exportError))) || action === 'import' && !preview || action === 'export' && (Boolean(exportError) || !query.trim() || format === 'sql' && !insertTable.trim())} onClick={() => void start()}>{action === 'export' ? 'Run and export' : action === 'copy' && !capture ? 'Capture source rows' : 'Import into transaction'}</button></div>
      </fieldset>
    </>}
    {jobs.some(job => (job.relatedSessionIds ?? [job.sessionId]).includes(session?.id ?? '')) && <div className="backup-job-list"><h3>This tab’s transfers</h3>{[...jobs].reverse().filter(job => (job.relatedSessionIds ?? [job.sessionId]).includes(session?.id ?? '')).map(item => <button key={item.id} disabled={busy} onClick={() => setSelected(item.id)}><span>{item.action} · {item.rows.toLocaleString()} rows</span><span>{item.status}</span></button>)}</div>}
    {inference && session && <CreateImportTable session={session} preview={inference} blocked={blocked} onPrepare={onPrepareTable} onApply={onApplyTable} onClose={() => setInference(undefined)} onCreated={(table, transaction) => { setInference(undefined); setCreatedTable(table); setTarget('created'); setCreatedNotice(transaction ? 'Empty table created in this transaction. Commit it explicitly before previewing and importing rows; Rollback removes it.' : 'Empty table created. Preview and map the file to import rows. If row import fails, this empty table remains.'); reset() }}/>}
    {parameterExport && <ParameterDialog engine={querySession?.engine} sql={parameterExport.request.sql} names={parameterExport.names} submitLabel={parameterExport.request.action === 'capture' ? 'Capture with parameters' : 'Export with parameters'} onClose={() => setParameterExport(undefined)} onRun={values => submit({ ...parameterExport.request, parameters: values })} />}
  </dialog>
}
