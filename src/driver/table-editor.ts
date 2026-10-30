import { lexSql } from '../shared/sql/lexer'
import { captureData } from './data-capture'
import { randomUUID, createHash } from 'node:crypto'
import type { Cell, DatabaseEngine, GridChange, GridColumn, GridResponse, GridSnapshot, GridTable, SessionInfo } from '../shared/contracts'
import { MAX_TABS } from '../shared/contracts'
import { GridSql } from './grid-sql'
import { gridDml } from './grid-dml'
import { GRID_CELL_LIMIT, GRID_PAGE_BYTES, GRID_PREVIEW_CELL_LIMIT } from '../shared/grid-limits'
import { browseColumn, browseSelect, displayable } from './browse-sql'
import { inspectExpression } from './inspection-sql'
import { foreignKeys } from './foreign-keys'
import { INSPECT_LIMIT, inspectionPrefix, type CellInspection, type CellMark } from '../shared/inspection'
import { openImport } from '../transfer/import'
import type { GridOperation, ImportContext, ImportSource, ImportRequest } from '../shared/transfer'

export interface GridQueryResult { rows: Cell[][]; affected: number; warnings?: number }
export type GridQuery = (sql: string, values?: Cell[]) => Promise<GridQueryResult>
const truth = (value: Cell) => ['1', 'true', 't'].includes(value ?? '')
export function duckdbGeneratedColumns(sql: string): Set<string> {
  const tokens = lexSql(sql, 'duckdb').filter(token => token.kind !== 'comment'), generated = new Set<string>()
  let depth = 0, name = '', start = true
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.text === '(') { depth++; if (depth === 1) start = true; continue }
    if (token.kind === 'symbol' && token.text === ')') { depth--; continue }
    if (depth !== 1) continue
    if (token.kind === 'symbol' && token.text === ',') { start = true; continue }
    if (start) { name = token.value; start = false }
    else if (token.kind === 'word' && token.text.toUpperCase() === 'GENERATED') generated.add(name.toLowerCase())
  }
  return generated
}
interface Definition { columns: GridColumn[]; fingerprint: string }
/** Independent tab snapshots on one physical session. Never accepts renderer-supplied originals,
 * identifiers for mutations, SQL fragments, or arbitrary parameter types. */
export class TableEditor {
  private snapshot?: GridSnapshot
  private originals: Cell[][] = []
  private fingerprint = ''
  private dialect: GridSql
  private views = new Map<string, TableEditor>()
  constructor(engine: DatabaseEngine, private query: GridQuery, private readOnly = false) { this.dialect = new GridSql(engine) }
  invalidate() { this.snapshot = undefined; this.originals = []; this.views.clear() }
  private async definition(table: GridTable, browse = false, requireKey = true): Promise<Definition> {
    const { sql, values } = this.dialect.metadata(table, browse), { rows } = await this.query(sql, values)
    if (!rows.length) throw new Error(browse ? 'This table or view is unavailable. Refresh the schema and check your permissions.' : 'This object is not an editable base table. MySQL/MariaDB require InnoDB without triggers; views and virtual tables are read-only.')
    if (rows.length > 100) throw new Error('The table browser supports up to 100 columns. Select the columns you need using SQL.')
    let physicalDefinition = ''
    if (this.dialect.mysql && !browse) {
      // A session-local MySQL temporary table can shadow a fully qualified
      // permanent table, while INFORMATION_SCHEMA still describes the latter.
      // Refuse it, including a nontransactional temporary table with the same key.
      physicalDefinition = (await this.query(`SHOW CREATE TABLE ${this.dialect.table(table)}`)).rows[0]?.[1] ?? ''
      if (!/^CREATE TABLE /i.test(physicalDefinition)) throw new Error('MySQL/MariaDB temporary tables are not editable in the grid. Use a permanent InnoDB table.')
    }
    const columns = rows.map(row => ({ name: row[0]!, type: row[1]!, nullable: truth(row[2]), primaryKey: truth(row[3]), generated: truth(row[4]), hasDefault: truth(row[5]) }))
    if (this.dialect.engine === 'duckdb') {
      const generated = duckdbGeneratedColumns(rows[0][7] ?? '')
      for (const column of columns) column.generated = generated.has(column.name.toLowerCase())
    }
    if (!browse) {
      if (requireKey && !columns.some(c => c.primaryKey)) throw new Error('A declared primary key is required for safe row editing.')
      const unsupported = columns.find(column => !this.dialect.supported(column))
      if (unsupported) throw new Error(`Column “${unsupported.name}” (${unsupported.type}) needs a dedicated editor. This table remains read-only.`)
    }
    return { columns: columns.map(column => browseColumn(this.dialect, column)), fingerprint: JSON.stringify([rows, physicalDefinition]) }
  }
  private validate(changes: GridChange[], snapshot: GridSnapshot) {
    if (Buffer.byteLength(JSON.stringify(changes)) > GRID_PAGE_BYTES) throw new Error('Staged edits exceed 8 MiB. Apply a smaller batch.')
    const seen = new Set<number>()
    for (const change of changes) {
      if (change.kind !== 'insert') {
        if (seen.has(change.row) || !snapshot.rows[change.row]) throw new Error('Invalid or duplicate edited row.')
        seen.add(change.row)
      }
      if (change.kind === 'delete') continue
      const columns = new Set<number>()
      for (const value of change.values) {
        const column = snapshot.columns[value.column]
        if (!column || columns.has(value.column)) throw new Error('Invalid or duplicate edited column.')
        columns.add(value.column)
        if (column.generated || change.kind === 'update' && column.primaryKey) throw new Error('Generated columns and existing primary keys cannot be edited.')
        if (value.value === null && (!column.nullable || column.primaryKey)) throw new Error(`“${column.name}” cannot be NULL.`)
        if (column.encoding === 'hex' && value.value !== null && (!/^(?:[0-9a-f]{2})*$/i.test(value.value))) throw new Error(`“${column.name}” requires complete hexadecimal byte pairs.`)
        if (this.dialect.engine === 'oracle' && value.value !== null && value.value.length > GRID_PREVIEW_CELL_LIMIT) throw new Error('Oracle grid values are limited to 16,384 characters. Use SQL for larger values.')
      }
      if (change.kind === 'insert') for (let index = 0; index < snapshot.columns.length; index++) {
        const column = snapshot.columns[index]
        if (!column.generated && !column.hasDefault && (!column.nullable || column.primaryKey) && !columns.has(index)) throw new Error(`Enter a value for “${column.name}”.`)
      }
    }
  }
  private async importFile(request: (ImportSource & { action: 'inspect-import' }) | ImportRequest, info: SessionInfo, context?: ImportContext): Promise<Omit<GridResponse, 'session'>> {
    this.invalidate()
    const d = this.dialect, table = { ...request.table }
    if (d.engine === 'duckdb' && !table.catalog) table.catalog = info.database
    const source = await openImport(request.file, request.format)
    let began = false, rowNumber = 1, closeAttempted = false, failed = false
    const closeSource = async () => {
      if (closeAttempted) return
      closeAttempted = true
      await source.close()
    }
    try {
      const definition = await this.definition(table, false, false)
      if (definition.columns.some(column => column.encoding === 'hex')) throw new Error('Binary columns are not supported by file import. Use explicit SQL for this table.')
      const signature = createHash('sha256').update(JSON.stringify([table, request.file, request.format, source.identity, source.headers, definition.fingerprint])).digest('hex')
      if (request.action === 'inspect-import') {
        const rows: Cell[][] = []
        for await (const row of source.records) { if (row.length !== source.headers.length) throw new Error('A preview record has a different number of columns than the header.'); rows.push(row); if (rows.length === 10) break }
        if (!await source.unchanged()) throw new Error('The source file changed during preview. Preview the import again.')
        return { importPreview: { headers: source.headers, rows, columns: definition.columns, signature } }
      }
      context!.signal.throwIfAborted()
      if (request.signature !== signature) throw new Error('The source file or table definition changed. Preview and review the import again.')
      if (request.mapping.length !== source.headers.length) throw new Error('Map every source column or explicitly skip it.')
      const mapped = request.mapping.flatMap((name, index) => {
        if (name === null) return []
        const column = definition.columns.find(column => column.name === name)
        if (!column || column.generated) throw new Error('The mapping contains an unavailable or generated column.')
        return [{ column, index }]
      })
      if (!mapped.length || new Set(mapped.map(item => item.column.name)).size !== mapped.length) throw new Error('Choose unique target columns for the import.')
      for (const column of definition.columns) if (!column.generated && !column.hasDefault && !column.nullable && !mapped.some(item => item.column.name === column.name)) throw new Error(`Map required column “${column.name}”.`)
      await this.query(d.engine === 'oracle' ? 'SAVEPOINT DBCOMMANDER_IMPORT' : d.engine === 'sqlite' ? 'BEGIN IMMEDIATE' : d.mysql ? 'START TRANSACTION' : 'BEGIN TRANSACTION')
      began = true
      if (d.engine === 'postgres') { await this.query("SET LOCAL lock_timeout = '2s'"); await this.query(`LOCK TABLE ${d.table(table)} IN ROW EXCLUSIVE MODE`) }
      else if (d.engine === 'oracle') await this.query(`LOCK TABLE ${d.table(table)} IN ROW EXCLUSIVE MODE NOWAIT`)
      else if (d.mysql || d.mssql) await this.query(`SELECT ${d.mssql ? 'TOP (1) ' : ''}${d.q(mapped[0].column.name)} FROM ${d.table(table)}${d.mssql ? ' WITH (UPDLOCK,HOLDLOCK)' : ' LIMIT 1 FOR UPDATE'}`)
      if ((await this.definition(table, false, false)).fingerprint !== definition.fingerprint) throw new Error('The table definition changed. Preview the import again.')
      // Let PostgreSQL infer the destination type: explicit VARCHAR(n) casts silently truncate.
      const sql = `INSERT INTO ${d.table(table)} (${mapped.map(item => d.q(item.column.name)).join(',')}) VALUES (${mapped.map((item, index) => d.engine === 'postgres' ? d.p(index + 1) : d.value(item.column, index + 1)).join(',')})`
      let imported = 0
      for (;;) {
        rowNumber++
        context!.signal.throwIfAborted()
        const next = await source.records.next()
        if (next.done) break
        const row = next.value
        if (row.length !== source.headers.length) throw new Error('The record has a different number of columns than the header.')
        const values = mapped.map(({ column, index }) => {
          const value = row[index]
          validateImportCell(column, value)
          if (d.engine === 'sqlite' && value !== null) {
            if (/int/i.test(column.type) && (BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n)) throw new Error(`“${column.name}” exceeds SQLite's exact integer range.`)
            if (/^(bool|boolean)$/i.test(column.type)) return /^(true|1)$/i.test(value) ? '1' : '0'
          }
          return value
        })
        const result = await this.query(sql, values)
        if (result.warnings || result.affected !== 1) throw new Error('The server reported a conversion warning or an unexpected affected-row count.')
        imported++; context!.progress(imported)
        if (imported % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      context!.signal.throwIfAborted()
      const unchanged = await source.unchanged()
      context!.signal.throwIfAborted()
      if (!unchanged) throw new Error('The source file changed during import.')
      if (!imported) throw new Error('The file contains no data records.')
      // Final file checks and close are part of import success. A close error
      // or cancellation while awaiting them must still roll back inserted rows.
      await closeSource()
      context!.signal.throwIfAborted()
      return { imported }
    } catch (error) {
      failed = true
      if (began) {
        try { await this.query('ROLLBACK') }
        catch { throw new Error(`Import stopped at record ${rowNumber}. Rollback could not be confirmed; the outcome is unknown. Reconnect and inspect before retrying.`) }
      }
      throw new Error(`Import stopped at record ${rowNumber}: ${(error as Error).message}${began ? ' The entire import was rolled back.' : ''}`)
    } finally {
      // Cleanup must not replace a confirmed rollback or unknown-outcome error.
      if (failed) await closeSource().catch(() => {})
      else await closeSource()
    }
  }
  async handle(request: GridOperation, info: SessionInfo, context?: ImportContext): Promise<Omit<GridResponse, 'session'>> {
    if (request.action === 'release') { this.views.delete(request.viewId); return {} }
    if ('viewId' in request && request.viewId) {
      let editor = this.views.get(request.viewId)
      if (!editor) {
        if (this.views.size >= MAX_TABS) throw new Error('Close a table tab before opening another view.')
        editor = new TableEditor(this.dialect.engine, this.query, this.readOnly)
        this.views.set(request.viewId, editor)
      }
      return editor.handle({ ...request, viewId: undefined }, info, context)
    }
    if (this.readOnly && !['browse','inspect-cell','foreign-keys','follow-reference','compare-data'].includes(request.action)) throw new Error('This connection was opened read-only.')
    if (info.transaction !== 'idle' || info.engine !== 'oracle' && info.autocommit === false) throw new Error('Commit or roll back the current transaction and enable autocommit before opening or applying table edits. Apply starts its own transaction.')
    if (this.dialect.mssql && (request.action === 'open' || request.action === 'apply')) {
      // TEXTSIZE is measured in bytes and can silently truncate nvarchar(max)
      // before the oversized sentinel or the optimistic comparison arrives.
      const size = (await this.query('SELECT @@TEXTSIZE')).rows[0]?.[0]
      if (size === undefined || size === null || !Number.isFinite(Number(size)) || Number(size) < 2 * (GRID_CELL_LIMIT + 1)) throw new Error('Run SET TEXTSIZE 2147483647 before editing data to prevent truncated originals.')
    }
    if (request.action === 'compare-data') {
      if (this.dialect.mssql) {
        const size = (await this.query('SELECT @@TEXTSIZE')).rows[0]?.[0]
        if (size === undefined || size === null || Number(size) < 32770) throw new Error('Run SET TEXTSIZE 2147483647 before comparing data to prevent truncated values.')
      }
      const table = { ...request.table }
      if (this.dialect.engine === 'duckdb' && !table.catalog) table.catalog = info.database
      const definition = await this.definition(table, true)
      if (this.dialect.mysql) {
        const ddl = (await this.query(`SHOW CREATE TABLE ${this.dialect.table(table)}`)).rows[0]?.[1] ?? ''
        if (!/^CREATE TABLE /i.test(ddl)) throw new Error('Temporary tables can shadow stored metadata. Compare a permanent table.')
      }
      const dataCapture = await captureData(this.dialect, table, definition.columns, request, this.query)
      if ((await this.definition(table, true)).fingerprint !== definition.fingerprint) throw new Error('The table definition changed during capture. Refresh and compare again.')
      // A comparison must not replace or invalidate the retained grid originals.
      return { dataCapture }
    }
    if (request.action === 'inspect-cell' || request.action === 'foreign-keys' || request.action === 'follow-reference') {
      const snapshot = this.snapshot, d = this.dialect
      if (!snapshot || snapshot.id !== request.snapshotId) throw new Error('This snapshot has expired. Reload the table before inspecting or navigating.')
      if ((await this.definition(snapshot.table, snapshot.mode === 'browse')).fingerprint !== this.fingerprint) throw new Error('The table definition changed. Reload before inspecting or navigating.')
      if(d.mysql&&snapshot.columns.some(c=>c.primaryKey)) {
        const ddl=(await this.query(`SHOW CREATE TABLE ${d.table(snapshot.table)}`)).rows[0]?.[1]??''
        if(!/^CREATE TABLE /i.test(ddl))throw new Error('Temporary tables can shadow stored metadata. Use SQL to inspect or navigate this object.')
      }
      if (request.action === 'foreign-keys') return { references: await foreignKeys(d,snapshot.table,this.query) }
      const row = snapshot.rows[request.row]
      if (!row) throw new Error('This row is unavailable.')
      if (request.action === 'follow-reference') {
        const ref = (await foreignKeys(d,snapshot.table,this.query)).find(ref => ref.id === request.referenceId)
        if (!ref || ref.columns.length > 8) throw new Error('This foreign key changed or exceeds the eight-column navigation limit. Reload and inspect its definition.')
        const filters = ref.columns.map((name,index) => {
          const column = snapshot.columns.findIndex(c => c.name === name), value = row[column]
          if (value === null || value === undefined) throw new Error('This foreign key contains NULL; there is no referenced row to follow.')
          if (!snapshot.columns[column]?.filterable || snapshot.cellMarks?.some(m => m.row === request.row && m.column === column && (m.truncated || m.unavailable || m.binary))) throw new Error('This key cannot be represented losslessly as a navigation filter. Use SQL.')
          return { column: ref.targetColumns[index], operator: 'eq' as const, value }
        })
        return this.handle({ action: 'browse', sessionId: info.id, table: ref.target, query: { offset: 0, pageSize: 25, filters, sort: [] } },info)
      }
      const column = snapshot.columns[request.column]
      if (!column) throw new Error('This column is unavailable.')
      const keys = snapshot.columns.map((c,index) => ({ c,index })).filter(({c}) => c.primaryKey)
      const mark = snapshot.cellMarks?.find(m => m.row === request.row && m.column === request.column)
      if (!keys.length || keys.some(({c,index}) => !c.filterable || row[index] === null || snapshot.cellMarks?.some(m => m.row === request.row && m.column === index))) {
        if (mark?.unavailable) throw new Error('A non-null, supported primary key is required to load this value. Use an explicit SQL query.')
        return { inspection: { value: mark?.binary ? row[request.column]?.replace(/^0x/i,'').replace(/…$/,'') ?? null : row[request.column], encoding: mark?.binary ? 'hex' : 'text', truncated: Boolean(mark?.truncated), source: 'snapshot', notice: 'Captured page value. No usable primary key is available for a live value read.' } }
      }
      const expression = inspectExpression(d,column), values = keys.map(({index}) => row[index])
      const where = keys.map(({c},index) => `${d.q(c.name)}=${d.engine === 'postgres' ? d.p(index+1) : d.value(c,index+1)}`).join(' AND ')
      const sql = `SELECT ${d.mssql ? 'TOP (2) ' : ''}${expression.value},${expression.kind} FROM ${d.table(snapshot.table)} WHERE ${where}${d.mssql ? '' : d.engine === 'oracle' ? ' FETCH FIRST 2 ROWS ONLY' : ' LIMIT 2'}`
      const { rows } = await this.query(sql,values)
      if (rows.length !== 1) throw new Error('The source row was deleted or is no longer uniquely identifiable. Reload the table.')
      const encoding = rows[0][1] === 'hex' ? 'hex' : 'text'
      let value = rows[0][0]
      if (encoding === 'hex' && value?.startsWith('0x')) value = value.slice(2)
      if (encoding === 'hex' && value !== null && !/^[\da-f]*$/i.test(value)) throw new Error('The database returned an unsupported binary representation.')
      const inspection: CellInspection = { value: value === null ? null : inspectionPrefix(value), encoding, truncated: value !== null && value.length > INSPECT_LIMIT, source: 'live-row', notice: 'Live read by the captured primary key. The value may have changed since this page was loaded; this does not update the edit snapshot.' }
      return { inspection }
    }
    if (request.action === 'inspect-import' || request.action === 'import') return this.importFile(request, info, context)
    if (request.action === 'open' || request.action === 'browse') {
      this.invalidate()
      const browse = request.action === 'browse'
      const table = { ...request.table }
      if (this.dialect.engine === 'duckdb' && !table.catalog) table.catalog = info.database
      const definition = await this.definition(table, browse)
      const selection = browseSelect(this.dialect, table, definition.columns, request.query, !browse)
      const { rows: rawRows } = await this.query(selection.sql, selection.values)
      const rows = this.dialect.engine === 'sqlite' ? rawRows.map(row => row.map(value => {
        if (!browse && value === 'nul:') throw new Error('This SQLite row contains text with a NUL character. Use SQL to edit it; the grid cannot retain a complete original.')
        if (value?.startsWith('blob:')) {
          if (browse) return '0x' + value.slice(5)
          throw new Error('This SQLite row contains binary storage. Use SQL to edit it; the grid cannot safely edit this value.')
        }
        return value === null ? null : value.slice(value.indexOf(':') + 1)
      })) : rawRows
      const cellLimit = selection.cellLimit
      const oversized = rows.some(row => row.some(value => value !== null && value.length > cellLimit))
      if (!browse && oversized) throw new Error(`An editable cell exceeds this page's ${cellLimit.toLocaleString()}-character limit. Choose a smaller page or use SQL; no truncated originals are retained.`)
      if (Buffer.byteLength(JSON.stringify(rows)) > GRID_PAGE_BYTES) throw new Error('This page exceeds 8 MiB. Choose a smaller page size or use SQL to select fewer columns.')
      if (!browse && rows.some(row => definition.columns.some((c, index) => c.primaryKey && row[index] === null))) throw new Error('NULL primary keys cannot identify rows safely. This table remains read-only.')
      const grid: GridSnapshot = { id: randomUUID(), table, columns: definition.columns,
        statement: selection.values.length ? undefined : selection.statement,
        rows: rows.slice(0, selection.query.pageSize).map(row => row.map(value => browse && value && value.length > 16384 ? value.slice(0, 16384) + '…' : value)),
        truncated: rows.length > selection.query.pageSize, query: selection.query, mode: browse ? 'browse' : 'edit',
        notice: selection.notice + (oversized ? ' Large cells are truncated to 16,384 characters.' : '') + (browse && definition.columns.some(c => !displayable(this.dialect, c)) ? ' Some types require SQL inspection and are shown as placeholders.' : '') }
      const cellMarks: CellMark[] = []
      for (let row = 0; row < grid.rows.length; row++) for (let column = 0; column < grid.columns.length; column++) {
        const value = rows[row][column], unavailable = browse && value !== null && !displayable(this.dialect,grid.columns[column]), binary = browse && Boolean(this.dialect.engine === 'sqlite' && rawRows[row][column]?.startsWith('blob:'))
        if (unavailable || binary || browse && value !== null && value.length > 16384) cellMarks.push({row,column,unavailable,binary:Boolean(binary),truncated:browse && value !== null && value.length > 16384})
      }
      grid.cellMarks = cellMarks
      // Browsing never authorizes mutations; Edit this page fetches new originals.
      this.originals = browse ? [] : rawRows.slice(0, selection.query.pageSize)
      this.snapshot = grid
      this.fingerprint = definition.fingerprint
      // Copy on the internal API too: callers cannot mutate the retained original.
      return { grid: structuredClone(this.snapshot) }
    }
    const snapshot = this.snapshot
    if (!snapshot || snapshot.id !== request.snapshotId || snapshot.mode !== 'edit') throw new Error('This edit snapshot has expired. Reload the table before applying edits.')
    this.validate(request.changes, snapshot)
    if (request.action === 'preview') {
      if ((await this.definition(snapshot.table)).fingerprint !== this.fingerprint) throw new Error('The table definition changed. Reload the table before reviewing edits.')
      return { preview: { statements: request.changes.map(change => { const statement = gridDml(this.dialect, snapshot, change); return { sql: statement.sql, parameterCount: statement.values.length } }), notice: 'Preview only: values are bound separately and are not shown here. Apply starts a transaction, rechecks the table and original row values, and may execute additional locking and comparison statements. Triggers and constraints can have effects beyond these statements.' } }
    }
    // Consume before any write. Neither a timeout nor an RPC retry replays DML.
    const originals = this.originals
    this.invalidate()
    const d = this.dialect, target = d.table(snapshot.table)
    let began = false
    try {
      await this.query(d.engine === 'oracle' ? 'SAVEPOINT DBCOMMANDER_GRID' : d.engine === 'sqlite' ? 'BEGIN IMMEDIATE' : d.mysql ? 'START TRANSACTION' : d.mssql ? 'BEGIN TRANSACTION' : 'BEGIN TRANSACTION')
      began = true
      // Acquire metadata/table locks before checking for schema drift. DuckDB's
      // native transaction conflict detection covers concurrent DDL and writes.
      if (d.engine === 'postgres') { await this.query("SET LOCAL lock_timeout = '2s'"); await this.query(`LOCK TABLE ${target} IN ROW EXCLUSIVE MODE`) }
      else if (d.engine === 'oracle') await this.query(`LOCK TABLE ${target} IN ROW EXCLUSIVE MODE NOWAIT`)
      else if (d.mysql || d.mssql) await this.query(`SELECT ${d.mssql ? 'TOP (1) ' : ''}${d.q(snapshot.columns.find(c => c.primaryKey)!.name)} FROM ${target}${d.mssql ? ' WITH (UPDLOCK,HOLDLOCK)' : ' LIMIT 1 FOR UPDATE'}`)
      if ((await this.definition(snapshot.table)).fingerprint !== this.fingerprint) throw new Error('The table definition changed. Reload the table before editing.')
      for (const change of request.changes) {
        const values: Cell[] = []
        const bind = (column: GridColumn, value: Cell) => { values.push(value); return d.value(column, values.length) }
        let where = ''
        if (change.kind !== 'insert') {
          const original = snapshot.rows[change.row]
          where = snapshot.columns.flatMap((column, index) => column.primaryKey ? [`${d.q(column.name)}=${bind(column, original[index])}`] : []).join(' AND ')
          const current = await this.query(d.select(snapshot.table, snapshot.columns, where, true), values)
          if (current.rows.length !== 1 || current.rows[0].some((cell, index) => cell !== originals[change.row][index])) throw new Error(`Concurrency conflict in row ${change.row + 1}: the row was changed or deleted. The entire batch was rolled back. Reload and review your edits.`)
        }
        const statement = gridDml(d, snapshot, change)
        const result = await this.query(statement.sql, statement.values)
        if (result.warnings) throw new Error('The server reported a conversion warning. The entire batch was rolled back; correct the values before retrying.')
        if (result.affected !== 1) throw new Error(`Expected to change exactly one row, but the server reported ${result.affected}. The entire batch was rolled back.`)
      }
      return { applied: request.changes.length }
    } catch (error) {
      if (began) {
        try { await this.query('ROLLBACK') }
        catch { throw new Error(`${(error as Error).message} Rollback could not be confirmed; the outcome is unknown. Reconnect and inspect the data before retrying.`) }
      }
      throw error
    }
  }
}

/** Always return authoritative state, even when validation or DML fails. */
export async function runGridOperation(editor: TableEditor, request: GridOperation, info: SessionInfo, refresh: () => Promise<void>, context?: ImportContext): Promise<GridResponse> {
  let value: Omit<GridResponse, 'session'>
  try { value = await editor.handle(request, info, context) }
  catch (error) { value = { error: (error as Error).message } }
  try { await refresh() } catch { info.transaction = 'unknown'; value.error = `${value.error ?? 'Grid operation ended.'} Connection state is unknown. Reconnect and inspect the data.` }
  if ((value.applied !== undefined || value.imported !== undefined) && info.transaction !== 'transaction') {
    value.error = 'The server did not retain the edit transaction. Inspect the data before retrying; the outcome is unknown.'; delete value.applied; delete value.imported
  }
  return { ...value, session: { ...info } }
}

function validateImportCell(column: GridColumn, value: Cell) {
  if (value === null) { if (!column.nullable) throw new Error(`“${column.name}” cannot be NULL.`); return }
  const type = column.type.toLowerCase()
  if (/^(?:tinyint|smallint|mediumint|integer|int\d*|bigint|u?hugeint|u(?:tinyint|smallint|integer|bigint))\b/.test(type) && !/^[+-]?\d+$/.test(value)) throw new Error(`“${column.name}” requires an integer.`)
  if (/^(?:numeric|decimal|number|real|float|double)\b/.test(type) && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error(`“${column.name}” requires a number.`)
  if (/^(?:bool|boolean|bit)$/.test(type) && !/^(?:true|false|0|1)$/i.test(value)) throw new Error(`“${column.name}” requires true, false, 0 or 1.`)
  const length = /^(?:var)?char(?:acter varying)?\((\d+)\)$/.exec(type)
  if (length && [...value].length > Number(length[1])) throw new Error(`“${column.name}” exceeds its declared length.`)
  const decimal = /^(?:numeric|decimal|number)\((\d+),\s*(\d+)\)$/.exec(type)
  if (decimal && (/[eE]/.test(value) || (value.split('.')[1]?.length ?? 0) > Number(decimal[2]))) throw new Error(`“${column.name}” exceeds its decimal scale; use a plain decimal with the declared scale.`)
}
