import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableAction } from './explorer-actions'
import { processIsAlive as alive } from '../process-liveness'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await waitForWorkspaceReady(page)
    await expect(page.locator('.monaco-editor')).toBeVisible()
    return { app, page }
  } catch (error) { await close(app); throw error }
}
async function close(app?: ElectronApplication) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
const workspace = (page: Page) => page.evaluate(() => window.dbCommander.loadWorkspace())
async function connect(app: ElectronApplication, page: Page, engine: 'sqlite' | 'duckdb', file: string, mode: 'create' | 'read-write') {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Database engine').selectOption(engine)
  await form.getByLabel('Open mode').selectOption(mode)
  await form.getByRole('button', { name: mode === 'create' ? 'Choose new database file' : 'Browse database files' }).click()
  await form.getByLabel('Save connection profile').uncheck()
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(form).toHaveCount(0); await expect(page.locator('.status-text')).toHaveText('Connected')
}
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed')
  if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
}
async function killHost(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const hosts = app.getAppMetrics().filter(item => item.name === 'Db Commander database host')
    if (hosts.length !== 1) throw new Error(`Expected one database host, found ${hosts.length}.`)
    process.kill(hosts[0].pid, 'SIGKILL'); return hosts[0].pid
  })
}

function descendants(parent: number): number[] {
  const records: { pid: number; parent: number }[] = process.platform === 'win32'
    ? JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 10_000 })).map((item: { ProcessId: number; ParentProcessId: number }) => ({ pid: item.ProcessId, parent: item.ParentProcessId }))
    : execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n').map(line => { const [pid, parent] = line.trim().split(/\s+/).map(Number); return { pid, parent } })
  const owned = new Set([parent])
  let previous = 0
  while (owned.size !== previous) { previous = owned.size; for (const item of records) if (owned.has(item.parent)) owned.add(item.pid) }
  return [...owned].filter(pid => pid !== parent)
}

test('host recovery keeps the replacement workspace when the prior window closes late', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-late-window-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app
    const events: string[] = [], record = (event: string) => {
      events.push(event); writeFileSync(info.outputPath('window-recovery-events.json'), JSON.stringify(events))
    }
    record('launched')
    const saved = 'SELECT preserved_after_renderer_recovery;'
    await enter(launched.page, saved)
    await expect.poll(async () => (await workspace(launched.page))?.tabs[0].sql).toBe(saved)
    await app.evaluate(({ BrowserWindow }) => {
      const previous = BrowserWindow.getAllWindows()[0], emit = previous.emit.bind(previous)
      let closed: (() => void) | undefined
      previous.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'closed') { closed = () => emit(event, ...args); return true }
        return emit(event, ...args)
      }) as typeof previous.emit
      ;(globalThis as any).__releaseOldWindow = () => {
        if (!closed) throw new Error('The prior window has not closed.')
        closed(); delete (globalThis as any).__releaseOldWindow
      }
    })
    const replacement = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    const page = await replacement
    record('replacement created')
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await app.evaluate(() => (globalThis as any).__releaseOldWindow())
    record('prior close delivered')
    expect((await workspace(page))?.tabs[0].sql).toBe(saved)
    await enter(page, saved + ' -- still writable')
    await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(saved + ' -- still writable')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    record('saved buffer, writable replacement and no replay verified')
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

for (const engine of ['sqlite', 'duckdb'] as const) test(`application crash ${engine} releases native locks and recovers the saved workspace without replay`, async ({}, testInfo) => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-main-crash-${engine}-`)), file = join(directory, `local.${engine}`)
  let app: ElectronApplication | undefined
  let owned: number[] = []
  let databaseProcessesExited = false
  try {
    let launched = await launch(directory); app = launched.app
    const page = launched.page
    await connect(app, page, engine, file, 'create')
    await run(page, 'CREATE TABLE committed(n INTEGER); INSERT INTO committed VALUES(7);')
    await run(page, 'BEGIN TRANSACTION; UPDATE committed SET n=99;')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const longQuery = engine === 'sqlite'
      ? 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;'
      : 'SELECT sum(sin(i)) FROM range(1000000000000) t(i);'
    await enter(page, longQuery)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Running')
    const saved = `-- Saved but never submitted: ${engine} main-process crash\nINSERT INTO committed VALUES(777);`
    await enter(page, saved); await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(saved)
    const before = await page.evaluate(() => window.dbCommander.history())
    const processes = await app.evaluate(({ app }) => ({ main: process.pid, hosts: app.getAppMetrics().filter(item => item.name === 'Db Commander database host').map(item => item.pid) }))
    expect(processes.hosts).toHaveLength(1)
    const workers = descendants(processes.hosts[0]); owned = [...processes.hosts, ...workers]
    // Windows also owns one kernel-handle guard; it cannot stand in for the
    // separate SQLite execution process required by this assertion.
    if (engine === 'sqlite') expect(workers.length).toBeGreaterThan(process.platform === 'win32' ? 1 : 0)
    // Kill only the actual Electron main PID, not its process group or the
    // Windows Playwright command shell. Observe children before test cleanup.
    process.kill(processes.main, 'SIGKILL')
    await expect.poll(() => owned.filter(pid => alive(pid)), { timeout: 10_000, message: 'A main-process crash must not leave a native database owner running.' }).toEqual([])
    databaseProcessesExited = true
    await app.close().catch(() => {}); app = undefined
    launched = await launch(directory); app = launched.app
    expect((await workspace(launched.page))?.tabs[0].sql).toBe(saved)
    await expect(launched.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    const recoveredHistory = await launched.page.evaluate(() => window.dbCommander.history())
    for (const entry of before) expect(recoveredHistory).toContainEqual(entry)
    expect(recoveredHistory.some(item => item.sql === saved || (item.sql === longQuery && item.status === 'completed'))).toBe(false)
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual(recoveredHistory)
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true })
    let integrity: unknown
    try { integrity = db.prepare('PRAGMA quick_check').get()?.quick_check } finally { db.close() }
    expect(integrity).toBe('ok')
    await connect(app, launched.page, engine, file, 'read-write')
    await run(launched.page, 'BEGIN TRANSACTION; UPDATE committed SET n=n; COMMIT; SELECT n FROM committed;')
    await expect(launched.page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    await expect(launched.page.getByRole('cell', { name: '777', exact: true })).toHaveCount(0)
    writeFileSync(testInfo.outputPath(`${engine}-main-crash.json`), JSON.stringify({ engine, main: processes.main, databaseProcesses: owned, allDatabaseProcessesExited: true, saved, historyBefore: before.length, historyRecovered: recoveredHistory.length, workspaceIntegrity: integrity, committedValue: 7, noSQLReplay: true }, null, 2))
  } finally {
    await close(app)
    if (!databaseProcessesExited) for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const engine of ['sqlite', 'duckdb'] as const) test(`host recovery ${engine} releases a running transaction and retains unsaved SQL without replay`, async ({}, testInfo) => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-host-${engine}-`)), file = join(directory, `local.${engine}`)
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; const page = launched.page
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message))
    await connect(app, page, engine, file, 'create')
    await run(page, 'CREATE TABLE committed(n INTEGER); INSERT INTO committed VALUES(7);')
    await run(page, 'BEGIN TRANSACTION; UPDATE committed SET n=99;')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const longQuery = engine === 'sqlite'
      ? 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;'
      : 'SELECT sum(sin(i)) FROM range(1000000000000) t(i);'
    await enter(page, longQuery)
    await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(longQuery)
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Running')
    // Delay the autosave debounce while leaving animation frames and native
    // performance measurements intact. Main-process IPC is never delayed.
    await page.evaluate(() => {
      const timeout = window.setTimeout.bind(window)
      ;(window as any).__restoreHostTestTimers = () => { window.setTimeout = timeout }
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => timeout(handler, delay === 250 ? 60_000 : delay, ...args)) as typeof window.setTimeout
    })
    const retained = `SELECT 'unsaved_${engine}_host_loss';`
    await enter(page, retained)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(`unsaved_${engine}_host_loss`)
    const historyBefore = await page.evaluate(() => window.dbCommander.history())
    const killed = await killHost(app)
    await expect(page.locator('.status-text')).toHaveText('Disconnected')
    await expect(page.locator('.error-banner')).toContainText('reconnect explicitly')
    await expect(page.locator('.error-banner')).toContainText('unknown')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(`unsaved_${engine}_host_loss`)
    // A read starts a fresh host, but must neither reconnect nor replay SQL.
    expect((await workspace(page))?.tabs[0].sql).toBe(longQuery)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(historyBefore)
    await page.evaluate(() => (window as any).__restoreHostTestTimers())
    await connect(app, page, engine, file, 'read-write')
    await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(retained)
    // A surviving SQLite child would hold the write lock. DuckDB must also
    // release its native file ownership and roll back the uncommitted update.
    await run(page, 'BEGIN TRANSACTION; UPDATE committed SET n=n; COMMIT; SELECT n FROM committed;')
    await expect(page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    const after = await page.evaluate(() => window.dbCommander.history())
    expect(after).toHaveLength(historyBefore.length + 1)
    expect(after.some(item => item.sql === longQuery || item.sql === retained)).toBe(false)
    await enter(page, retained); await expect.poll(async () => (await workspace(page))?.tabs[0].sql).toBe(retained)
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app
    expect((await workspace(launched.page))?.tabs[0].sql).toBe(retained)
    await expect(launched.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual(after)
    expect(pageErrors).toEqual([])
    writeFileSync(testInfo.outputPath(`${engine}-host-recovery.json`), JSON.stringify({ engine, killedHost: killed, retained, historyBefore: historyBefore.length, historyAfter: after.length, committedValue: 7, pageErrors }, null, 2))
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

for (const engine of ['sqlite', 'duckdb'] as const) test(`host recovery ${engine} allows discarding retained staged edits and reconnecting`, async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-host-grid-${engine}-`)), file = join(directory, `local.${engine}`)
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await connect(app, page, engine, file, 'create')
    await run(page, "CREATE TABLE drafts(id INTEGER PRIMARY KEY, name VARCHAR(60)); INSERT INTO drafts VALUES(1,'Committed');")
    await tableAction(page, 'drafts', 'Edit data')
    await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByLabel('Row 1 name', { exact: true }).fill('Retained local draft')
    await expect(page.getByRole('button', { name: 'Discard edits', exact: true })).toBeEnabled()
    const before = await page.evaluate(() => window.dbCommander.history())
    await killHost(app)
    await expect(page.locator('.status-text')).toHaveText('Disconnected')
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Retained local draft')
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveAttribute('readonly', '')
    for (const name of ['Apply edits', 'Insert row', 'Reload data']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Discard edits', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-disconnected-draft.png`) })
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await expect(page.getByLabel('Row 1 name', { exact: true })).toHaveValue('Committed')
    await expect(page.getByRole('button', { name: 'Reload data', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Close data', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Editable table data', exact: true })).toHaveCount(0)
    await connect(app, page, engine, file, 'read-write')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
    await run(page, 'SELECT name FROM drafts;')
    await expect(page.getByRole('cell', { name: 'Committed', exact: true })).toBeVisible()
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
