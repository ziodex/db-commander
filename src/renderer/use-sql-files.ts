import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { MAX_TABS, type Workspace, type WorkspaceTab } from '../shared/contracts'
import { normalizedSql, type SqlFileInfo, type SqlFilesState } from '../shared/sql-files'

const api = window.dbCommander
interface Options {
  workspace: Workspace; workspaceRef: MutableRefObject<Workspace>; ready: boolean
  changeWorkspace(update: (previous: Workspace) => Workspace): void
  patchTab(id: string, patch: Partial<WorkspaceTab>): void
  persist(): Promise<void>; report(error: unknown, id?: string): void
}

export function useSqlFiles(options: Options) {
  const latest = useRef(options); latest.current = options
  const [state, setState] = useState<SqlFilesState>({ files: [], recent: [] })
  const [initialized, setInitialized] = useState(false)
  const [busy, setBusy] = useState(false), busyRef = useRef(false)
  const [error, setError] = useState('')
  const [recentOpen, setRecentOpen] = useState(false)
  const [hashes, setHashes] = useState<Record<string, { sql: string; hash: string }>>({})
  const hashesRef = useRef(hashes); hashesRef.current = hashes
  const revision = useRef(0), checking = useRef(false)
  const files = Object.fromEntries(state.files.map(file => [file.tabId, file]))
  const currentTab = (id = latest.current.workspaceRef.current.activeTabId) => latest.current.workspaceRef.current.tabs.find(tab => tab.id === id)

  useEffect(() => {
    let disposed = false
    void Promise.all(options.workspace.tabs.map(async tab => {
      const sql = normalizedSql(tab.sql), cached = hashesRef.current[tab.id]
      if (cached?.sql === sql) return [tab.id, cached] as const
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))
      return [tab.id, { sql, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }] as const
    })).then(items => { if (!disposed) setHashes(Object.fromEntries(items)) }).catch(error => latest.current.report(error))
    return () => { disposed = true }
  }, [options.workspace.tabs])

  async function refresh() {
    const version = revision.current, next = await api.checkSqlFiles()
    if (version === revision.current) setState(next)
  }
  useEffect(() => {
    if (!options.ready) return
    let disposed = false
    void api.restoreSqlFiles().then(value => { if (!disposed) setState(value) })
      .catch(error => { if (!disposed) latest.current.report(error) })
      .finally(() => { if (!disposed) setInitialized(true) })
    const check = () => {
      if (busyRef.current || checking.current) return
      checking.current = true
      const version = revision.current
      void api.checkSqlFiles().then(value => { if (!disposed && version === revision.current) setState(value) }).catch(error => { if (!disposed) latest.current.report(error) }).finally(() => { checking.current = false })
    }
    const timer = setInterval(check, 3000)
    window.addEventListener('focus', check)
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', check) }
  }, [options.ready])

  async function work<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current || !initialized) return
    busyRef.current = true; setBusy(true); setError(''); revision.current++
    try { return await action() }
    catch (error) {
      setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error))
      latest.current.report(error); return undefined
    }
    finally { revision.current++; busyRef.current = false; setBusy(false) }
  }
  function accept(file: SqlFileInfo) { setState(previous => ({ ...previous, files: [...previous.files.filter(item => item.tabId !== file.tabId), file] })) }
  async function open(recentId?: string) {
    await work(async () => {
      const source = currentTab()!, opened = await api.openSql({ tabId: crypto.randomUUID(), recentId })
      if (!opened) return
      const { file, sql } = opened, workspace = latest.current.workspaceRef.current
      if (workspace.tabs.some(tab => tab.id === file.tabId)) {
        // Opening an already-open file must never replace that tab's buffer.
        latest.current.changeWorkspace(previous => ({ ...previous, activeTabId: file.tabId }))
      } else {
        if (workspace.tabs.length >= MAX_TABS || workspace.tabs.reduce((size, tab) => size + tab.sql.length, sql.length) > 5_000_000) {
          await api.forgetSqlFile(file.tabId)
          throw new Error('The workspace is full (20 tabs or 5,000,000 SQL characters). Close a tab before opening this file.')
        }
        latest.current.changeWorkspace(previous => ({ ...previous, activeTabId: file.tabId, tabs: [...previous.tabs, {
          id: file.tabId, title: file.name, sql, profile: source.profile, profileId: source.profileId
        }] }))
      }
      accept(file); setRecentOpen(false)
      await latest.current.persist(); await refresh()
    })
  }
  async function save(id = latest.current.workspaceRef.current.activeTabId, saveAs = false): Promise<boolean> {
    return Boolean(await work(async () => {
      const tab = currentTab(id); if (!tab) return false
      const file = await api.saveSqlFile({ tabId: id, sql: tab.sql, saveAs })
      if (!file) return false
      accept(file); latest.current.patchTab(id, { title: file.name })
      await latest.current.persist(); await refresh()
      return currentTab(id)?.sql === tab.sql
    }))
  }
  async function reload(id = latest.current.workspaceRef.current.activeTabId) {
    if (!files[id]) return
    await work(async () => {
      const tab = currentTab(id); if (!tab) return
      const opened = await api.reloadSqlFile({ tabId: id, sql: tab.sql })
      if (!opened) return
      try {
        if (currentTab(id)?.sql !== tab.sql) throw new Error('The editor changed during reload. Its edits were kept; reload again to replace them.')
        const total = latest.current.workspaceRef.current.tabs.reduce((size, item) => size + (item.id === id ? opened.sql.length : item.sql.length), 0)
        if (total > 5_000_000) throw new Error('The file exceeds the remaining workspace capacity. Your buffer was kept.')
        latest.current.patchTab(id, { title: opened.file.name, sql: opened.sql })
        try {
          // Save the accepted buffer before changing the file conflict baseline.
          await latest.current.persist()
          const file = await api.finishSqlFileReload({ reloadId: opened.reloadId, accept: true })
          if (!file) throw new Error('Reload was not accepted. Reload the file again.')
          accept(file)
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)
          throw new Error(`The SQL file was loaded into the editor, but reload could not be saved. Its file association was not updated. ${detail}`, { cause })
        }
      } finally { await api.finishSqlFileReload({ reloadId: opened.reloadId, accept: false }).catch(() => {}) }
    })
  }
  async function forget(id: string) { revision.current++; await api.forgetSqlFile(id); setState(previous => ({ ...previous, files: previous.files.filter(file => file.tabId !== id) })) }
  async function clearRecent() { await work(async () => { await api.clearRecentSqlFiles(); await refresh() }) }
  function dirty(tab: WorkspaceTab) {
    const file = files[tab.id], cached = hashes[tab.id]
    return file ? cached?.sql !== normalizedSql(tab.sql) || cached.hash !== file.savedHash : Boolean(tab.sql.trim())
  }
  const actions = useRef({ open, save, reload }); actions.current = { open, save, reload }
  useEffect(() => api.onFileCommand(command => {
    if (document.querySelector('dialog[open], [role="dialog"]')) return
    if (command === 'recent') setRecentOpen(true)
    else if (command === 'open') void actions.current.open()
    else if (command === 'reload') void actions.current.reload()
    else void actions.current.save(undefined, command === 'save-as')
  }), [])
  return { files, error, recent: state.recent, notice: state.notice, busy: busy || !initialized, dirty, open, save, reload, forget, clearRecent, recentOpen, setRecentOpen }
}
