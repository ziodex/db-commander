import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { planSnippetImport, type PortableSnippet, type SnippetImportRequest } from '../shared/snippet-files'
import type { HistoryEntry, Workspace } from '../shared/contracts'
import { DEFAULT_PROFILE, legacyWorkspaceSchema, workspaceSchema } from '../shared/contracts'
import { DEFAULT_LAYOUT, layoutSchema } from '../shared/layout'
import { recoverEditorSettings } from '../shared/editor-settings'
import { recoverEditorViews } from '../shared/editor-views'
import { orderPinnedTabs } from '../shared/tab-order'
import { recoverTableLayouts } from '../shared/table-layouts'
import { DEFAULT_HISTORY_SETTINGS, historySearchSchema, historySettingsSchema, snippetSchema, snippetSearchSchema, type HistorySearch, type HistorySettings, type SnippetInput, type Snippet } from '../shared/query-library'

/** Accessed exclusively in the utility process. No credentials or result rows. */
export class WorkspaceStore {
  private db: DatabaseSync
  private historyCleanupDeferred = false
  get recoveryNotice(): string | undefined {
    return this.historyCleanupDeferred ? 'Query history cleanup was deferred because the workspace disk is full. Saved SQL buffers are available. Free disk space and retry saving. No SQL was replayed.' : undefined
  }
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > 3) throw new Error('This workspace was created by a newer Db Commander version.')
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA busy_timeout=5000;')
      if (version.user_version === 1) {
        const row = this.db.prepare('SELECT value FROM workspace WHERE id=1').get() as { value: string } | undefined
        const previous = row ? legacyWorkspaceSchema.parse(JSON.parse(row.value)) : undefined
        // VACUUM INTO includes WAL contents. A failed backup leaves v1 untouched.
        const backup = `${path}.v1-backup-${randomUUID()}`
        this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600)
        this.db.exec('BEGIN IMMEDIATE')
        try {
          if (previous) {
            const id = randomUUID(), profileId = previous.profile ? randomUUID() : undefined
            const value: Workspace = { version: 2, activeTabId: id, profiles: profileId ? [{ id: profileId, config: previous.profile! }] : [],
              tabs: [{ id, title: 'Untitled.sql', sql: previous.sql, profile: previous.profile ?? DEFAULT_PROFILE, profileId }] }
            this.save(value)
          }
          this.db.exec('PRAGMA user_version=2; COMMIT')
        } catch (error) { this.db.exec('ROLLBACK'); throw error }
      }
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, connection TEXT NOT NULL, sql TEXT NOT NULL, status TEXT NOT NULL, startedAt TEXT NOT NULL, durationMs INTEGER NOT NULL);
        PRAGMA secure_delete=ON;`)
      if(version.user_version<3) {
        if(version.user_version===2) {const backup=`${path}.v2-backup-${randomUUID()}`;this.db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600)}
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.exec(`ALTER TABLE history ADD COLUMN engine TEXT;
            ALTER TABLE history ADD COLUMN database TEXT NOT NULL DEFAULT '';
            ALTER TABLE history ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE history ADD COLUMN parameters TEXT NOT NULL DEFAULT '[]';
            CREATE INDEX history_date ON history(startedAt DESC,id DESC);
            CREATE TABLE library_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
            CREATE TABLE snippets(id TEXT PRIMARY KEY,value TEXT NOT NULL);
            PRAGMA user_version=3; COMMIT;`)
        } catch(error){this.db.exec('ROLLBACK');throw error}
      }
      this.pruneHistory()
    } catch (error) { this.db.close(); throw error }
  }
  load(): Workspace | null {
    const row = this.db.prepare('SELECT value FROM workspace WHERE id=1').get() as { value: string } | undefined
    if (!row) return null
    const value = JSON.parse(row.value)
    // A damaged presentation preference must not prevent SQL/profile recovery.
    // Writes still validate strictly; only disk recovery tolerates bad preferences.
    if (value && typeof value === 'object' && 'layout' in value && !layoutSchema.safeParse(value.layout).success) value.layout = { ...DEFAULT_LAYOUT }
    if (value && typeof value === 'object' && 'editorSettings' in value) value.editorSettings = recoverEditorSettings(value.editorSettings)
    if (value && typeof value === 'object' && 'editorViews' in value) {
      const views = recoverEditorViews(value.editorViews, Array.isArray(value.tabs) ? value.tabs.map((tab: { id?: string }) => tab?.id).filter((id: unknown): id is string => typeof id === 'string') : [], value.activeTabId)
      if (views) value.editorViews = views; else delete value.editorViews
    }
    if (value && typeof value === 'object' && 'tableLayouts' in value) value.tableLayouts = recoverTableLayouts(value.tableLayouts)
    if (Array.isArray(value?.tabs)) for (const tab of value.tabs) {
      if (tab && typeof tab === 'object' && 'pinned' in tab && typeof tab.pinned !== 'boolean') delete tab.pinned
    }
    const workspace = workspaceSchema.parse(value)
    return { ...workspace, tabs: orderPinnedTabs(workspace.tabs) }
  }
  save(value: Workspace): void {
    const workspace = workspaceSchema.parse(value)
    this.db.prepare('INSERT INTO workspace VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify({ ...workspace, tabs: orderPinnedTabs(workspace.tabs) }))
  }
  addHistory(entry: HistoryEntry): void {
    if(!this.historySettings().enabled)return
    this.db.prepare(`INSERT INTO history(id,connection,sql,status,startedAt,durationMs,engine,database,parameters) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,durationMs=excluded.durationMs`).run(entry.id,entry.connection,entry.sql,entry.status,entry.startedAt,entry.durationMs,entry.engine??null,entry.database??'',JSON.stringify(entry.parameters?.map(({name,type})=>({name,type}))??[]))
    this.pruneHistory()
  }
  historySettings():HistorySettings {
    const row=this.db.prepare('SELECT value FROM library_settings WHERE id=1').get()
    return row?historySettingsSchema.parse(JSON.parse(String(row.value))):{...DEFAULT_HISTORY_SETTINGS}
  }
  saveHistorySettings(input:HistorySettings) {const settings=historySettingsSchema.parse(input);this.db.prepare('INSERT INTO library_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(settings));this.pruneHistory()}
  private pruneHistory() {
    try {
      const settings=this.historySettings(),eligible=settings.keepFavorites?'favorite=0':'1=1'
      if(settings.maxAgeDays)this.db.prepare(`DELETE FROM history WHERE ${eligible} AND startedAt<?`).run(new Date(Date.now()-settings.maxAgeDays*86400000).toISOString())
      this.db.prepare(`DELETE FROM history WHERE id IN (SELECT id FROM history WHERE ${eligible} ORDER BY startedAt DESC,id DESC LIMIT -1 OFFSET ?)`).run(settings.maxEntries)
      // A separate byte budget bounds storage even with million-character SQL.
      const favorites=this.db.prepare('SELECT coalesce(sum(length(CAST(sql AS BLOB))),0) AS n FROM history WHERE favorite=1').get()!.n as number
      this.db.prepare(`DELETE FROM history WHERE id IN (SELECT id FROM (SELECT id,sum(length(CAST(sql AS BLOB))) OVER(ORDER BY startedAt DESC,id DESC) AS bytes FROM history WHERE favorite=0) WHERE bytes>?)`).run(Math.max(0,64*1024*1024-favorites))
      this.historyCleanupDeferred = false
    } catch (error) {
      // Maintenance must not make saved buffers/history unreadable on a full
      // volume. Explicit writes still fail normally; other SQLite faults surface.
      if ((error as { code?: string; errcode?: number })?.code !== 'ERR_SQLITE_ERROR' || (error as { errcode?: number }).errcode !== 13) throw error
      this.historyCleanupDeferred = true
    }
  }
  searchHistory(input:HistorySearch={}) {
    this.pruneHistory()
    const q=historySearchSchema.parse(input),where=['1=1'],values:(string|number)[]=[]
    for(const field of ['connection','database','engine','status'] as const)if(q[field]){where.push(`${field}=?`);values.push(q[field]!)}
    if(q.text){where.push('instr(lower(sql),lower(?))>0');values.push(q.text)}
    if(q.from){where.push('startedAt>=?');values.push(q.from)}if(q.to){where.push('startedAt<=?');values.push(q.to)}if(q.favorites)where.push('favorite=1')
    const condition=where.join(' AND '),total=Number(this.db.prepare(`SELECT count(*) AS n FROM history WHERE ${condition}`).get(...values)!.n)
    const entries=this.db.prepare(`SELECT * FROM history WHERE ${condition} ORDER BY startedAt DESC,id DESC LIMIT ? OFFSET ?`).all(...values,q.limit,q.offset).map(row=>({...row,engine:row.engine??undefined,favorite:Boolean(row.favorite),parameters:JSON.parse(String(row.parameters))})) as unknown as HistoryEntry[]
    return {entries,total}
  }
  history(): HistoryEntry[] {return this.searchHistory({limit:100}).entries}
  favoriteHistory(id:string,favorite:boolean) {
    if(favorite){const row=this.db.prepare('SELECT length(CAST(sql AS BLOB)) AS bytes,favorite FROM history WHERE id=?').get(id);if(!row)throw new Error('History entry no longer exists.')
      const totals=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(sql AS BLOB))),0) AS bytes FROM history WHERE favorite=1').get()!
      if(!row.favorite&&(Number(totals.n)>=500||Number(totals.bytes)+Number(row.bytes)>32*1024*1024))throw new Error('Favorites support up to 500 entries and 32 MiB of SQL. Remove a favorite first.')}
    this.db.prepare('UPDATE history SET favorite=? WHERE id=?').run(Number(favorite),id);this.pruneHistory()
  }
  deleteHistory(id:string) {this.db.prepare('DELETE FROM history WHERE id=?').run(id)}
  clearHistory(includeFavorites=true): void {this.db.exec(`DELETE FROM history${includeFavorites?'':' WHERE favorite=0'}`);this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')}
  snippets(input:Parameters<typeof snippetSearchSchema.parse>[0]={}):Snippet[] {
    const q=snippetSearchSchema.parse(input)
    return this.db.prepare('SELECT value FROM snippets').all().map(row=>JSON.parse(String(row.value)) as Snippet).filter(s=>(!q.engine||s.engine===q.engine)&&(!q.favorites||s.favorite)&&(!q.text||`${s.name}\n${s.description}\n${s.sql}`.toLowerCase().includes(q.text.toLowerCase()))).sort((a,b)=>Number(b.favorite)-Number(a.favorite)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id))
  }
  saveSnippet(input:SnippetInput):Snippet {
    const clean=snippetSchema.parse(input),all=this.snippets(),previous=all.find(s=>s.id===clean.id)
    if(clean.id&&!previous)throw new Error('Snippet no longer exists.')
    if(!previous&&all.length>=200)throw new Error('Up to 200 snippets can be saved.')
    if(all.reduce((n,s)=>n+(s.id===clean.id?0:s.sql.length),clean.sql.length)>5_000_000)throw new Error('Snippets exceed the 5 MB SQL budget.')
    const now=new Date().toISOString(),value:Snippet={...clean,id:clean.id??randomUUID(),createdAt:previous?.createdAt??now,updatedAt:now}
    this.db.prepare('INSERT INTO snippets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id,JSON.stringify(value));return value
  }
  deleteSnippet(id:string) {this.db.prepare('DELETE FROM snippets WHERE id=?').run(id)}
  snippetRevision() { return createHash('sha256').update(JSON.stringify(this.snippets().sort((a, b) => a.id.localeCompare(b.id)))).digest('hex') }
  importSnippets(snippets: PortableSnippet[], selected: number[], duplicates: SnippetImportRequest['duplicates'], revision: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (revision !== this.snippetRevision()) throw new Error('Saved snippets changed after this review. Choose the file again.')
      const actions = planSnippetImport(snippets, this.snippets(), selected, duplicates)
      for (const action of actions) if (!action.skip) this.saveSnippet(action.snippet)
      this.db.exec('COMMIT')
      return { imported: actions.filter(a => !a.skip).length, skipped: actions.filter(a => a.skip).length }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }
}
