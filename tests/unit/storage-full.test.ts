import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, type Workspace } from '../../src/shared/contracts'

const fault = vi.hoisted(() => ({ pruneCode: 0, limitWrites: false }))
vi.mock('node:sqlite', async importOriginal => {
  const sqlite = await importOriginal<typeof import('node:sqlite')>()
  return { ...sqlite, DatabaseSync: class extends sqlite.DatabaseSync {
    prepare(sql: string) {
      const statement = super.prepare(sql), db = this
      return new Proxy(statement, { get(target, key) {
        if (key === 'run' && sql.startsWith('DELETE FROM history')) return (...args: Parameters<typeof statement.run>) => {
          if (fault.pruneCode) throw Object.assign(new Error(fault.pruneCode === 13 ? 'database or disk is full' : 'Other SQLite failure'), { code: 'ERR_SQLITE_ERROR', errcode: fault.pruneCode })
          return target.run(...args)
        }
        if (key === 'run' && sql.startsWith('INSERT INTO workspace')) return (...args: Parameters<typeof statement.run>) => {
          // Real SQLite FULL from its page budget, without exhausting the host disk.
          const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count)
          db.exec(`PRAGMA max_page_count=${fault.limitWrites ? pages : 1073741823}`)
          return target.run(...args)
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
  } }
})

let directory: string
const workspace = (): Workspace => { const id = randomUUID(); return { version: 2, activeTabId: id, profiles: [], tabs: [{ id, title: 'Preserved.sql', sql: 'SELECT preserved_before_full;', profile: DEFAULT_PROFILE }] } }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dbcommander-storage-full-')); fault.pruneCode = 0; fault.limitWrites = false })
afterEach(() => { fault.pruneCode = 0; fault.limitWrites = false; rmSync(directory, { recursive: true, force: true }) })

it('reopens saved buffers when startup history maintenance encounters SQLITE_FULL', () => {
  const path = join(directory, 'workspace.sqlite'), value = workspace()
  let store = new WorkspaceStore(path); store.save(value); store.close()
  fault.pruneCode = 13
  store = new WorkspaceStore(path)
  try {
    expect(store.load()).toEqual(value)
    expect(store.recoveryNotice).toContain('history cleanup')
    expect(store.history()).toEqual([])
    fault.pruneCode = 0; expect(store.history()).toEqual([]); expect(store.recoveryNotice).toBeUndefined()
    expect(store.load()).toEqual(value)
  } finally { store.close() }
})

it('keeps history reads available and retries deferred maintenance after space returns', () => {
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite')), value = workspace()
  try {
    store.save(value); store.addHistory({ id: randomUUID(), connection: 'Fixture', sql: 'SELECT explicit_query;', status: 'completed', startedAt: new Date().toISOString(), durationMs: 1 })
    fault.pruneCode = 13
    expect(store.searchHistory().entries.map(entry => entry.sql)).toEqual(['SELECT explicit_query;'])
    expect(store.recoveryNotice).toContain('disk is full')
    expect(store.load()).toEqual(value)
    fault.pruneCode = 0; expect(store.searchHistory().total).toBe(1); expect(store.recoveryNotice).toBeUndefined()
  } finally { store.close() }
})

it('reports real SQLite FULL for workspace writes, preserves committed SQL and permits retry', () => {
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite')), value = workspace()
  try {
    store.save(value)
    const latest = { ...value, tabs: [{ ...value.tabs[0], sql: '-- ' + 'x'.repeat(128 * 1024) }] }
    fault.limitWrites = true
    expect(() => store.save(latest)).toThrow(expect.objectContaining({ errcode: 13 }))
    expect(store.load()).toEqual(value)
    fault.limitWrites = false; store.save(latest); expect(store.load()).toEqual(latest)
  } finally { store.close() }
})

it.each([8, 11])('continues to report non-FULL maintenance errors (SQLite code %s)', code => {
  const path = join(directory, 'workspace.sqlite'), value = workspace()
  const store = new WorkspaceStore(path); store.save(value); store.close()
  fault.pruneCode = code
  expect(() => new WorkspaceStore(path)).toThrow('Other SQLite failure')
  fault.pruneCode = 0
  const recovered = new WorkspaceStore(path)
  try { expect(recovered.load()).toEqual(value) } finally { recovered.close() }
})
