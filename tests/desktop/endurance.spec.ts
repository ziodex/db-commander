import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page, type CDPSession } from '@playwright/test'
import { createReadStream, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const seconds = Number(process.env.SQLCOMMANDER_ENDURANCE_SECONDS ?? 0)
const interval = Number(process.env.SQLCOMMANDER_ENDURANCE_INTERVAL_SECONDS ?? 30)
const exportRows = Number(process.env.SQLCOMMANDER_ENDURANCE_EXPORT_ROWS ?? 100_000)
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
type WindowProbe = { page: Page; cdp: CDPSession; id: number; engine: 'duckdb' | 'sqlite'; marker: string; recordId: string }
type ResourceSample = { elapsedSeconds: number; cycle: number; windows: { id: number; heap: number; nodes: number; listeners: number }[]; processes: { pid: number; type: string; name?: string; workingSetKiB: number }[]; ownedProcesses: { pid: number; ppid: number; rssKiB: number; executable: string }[] }
async function ready(page: Page) {
  await waitForWorkspaceReady(page)
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
}
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').first().click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function run(page: Page, sql: string) {
  await enter(page, sql)
  await page.evaluate(() => { (window as any).enduranceProbe.complete = undefined })
  await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).enduranceProbe.complete?.status)).toBe('completed')
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
}
async function trayCommand(app: ElectronApplication, id: string) {
  await app.evaluate(({ BrowserWindow }, id) => {
    const item = (globalThis as any).enduranceTrayMenu.getMenuItemById(id)
    item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {})
  }, id)
}

test('local endurance keeps multiple workspaces, hidden queries, exports and resources healthy', async ({}, testInfo) => {
  test.skip(process.env.SQLCOMMANDER_ENDURANCE_SECONDS === undefined, 'Opt in with scripts/run-endurance.mjs; ordinary smoke must remain short.')
  for (const [name, value, min, max] of [['seconds', seconds, 30, 86400], ['interval', interval, 1, 60], ['export rows', exportRows, 10000, 10000000]] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid endurance ${name}.`)
  }
  if (!process.env.SQLCOMMANDER_TEST_EXECUTABLE) throw new Error('Endurance requires a packaged executable.')
  test.setTimeout(seconds * 1000 + 300_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-endurance-'))
  const reportPath = process.env.SQLCOMMANDER_ENDURANCE_PROGRESS ?? testInfo.outputPath('progress.json')
  const started = Date.now()
  let workloadStarted: number | undefined, workloadFinished: number | undefined
  let app: ElectronApplication | undefined, cycle = 0, errorMessage: string | undefined, appPid: number | undefined
  const probes: WindowProbe[] = [], samples: ResourceSample[] = [], cycles: { cycle: number; durationMs: number; cancelMs: number; typingMs?: number }[] = []
  const exports: { cycle: number; rows: number; bytes: number; durationMs: number }[] = []
  let state = 'starting', baseline: ResourceSample | undefined
  function checkpoint() {
    const temporary = `${reportPath}.tmp`
    writeFileSync(temporary, JSON.stringify({ state, appPid, startedAt: new Date(started).toISOString(), workloadStartedAt: workloadStarted ? new Date(workloadStarted).toISOString() : undefined, workloadElapsedSeconds: workloadStarted ? ((workloadFinished ?? Date.now()) - workloadStarted) / 1000 : 0, updatedAt: new Date().toISOString(), requestedSeconds: seconds, elapsedSeconds: (Date.now() - started) / 1000, cycle, profile: directory, samples, cycles, exports, error: errorMessage }, null, 2), { mode: 0o600 })
    renameSync(temporary, reportPath)
  }
  async function launch() {
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    const launched = await electron.launch({ executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE!), env: env as Record<string, string> })
    app = launched
    appPid = launched.process().pid
    const diagnostics: string[] = []
    launched.process().stderr?.on('data', chunk => { diagnostics.push(String(chunk)); if (diagnostics.length > 100) diagnostics.shift() })
    const page = await launched.firstWindow()
    try { await ready(page); return page }
    catch (error) { writeFileSync(testInfo.outputPath('startup-errors.log'), diagnostics.join('')); throw error }
  }
  async function sample() {
    const windows = []
    for (const probe of probes) {
      await probe.cdp.send('HeapProfiler.collectGarbage')
      const dom = await probe.cdp.send('Memory.getDOMCounters'), metrics = await probe.cdp.send('Performance.getMetrics')
      windows.push({ id: probe.id, heap: metrics.metrics.find((metric: { name: string }) => metric.name === 'JSHeapUsedSize')!.value, nodes: dom.nodes, listeners: dom.jsEventListeners })
    }
    const processes = await app!.evaluate(({ app }) => app.getAppMetrics().map(process => ({ pid: process.pid, type: process.type, name: process.name, workingSetKiB: process.memory.workingSetSize })))
    // Electron metrics omit ordinary child_process SQLite workers. Include the
    // owned OS process tree on POSIX, reading executable names rather than args.
    const ownedProcesses: ResourceSample['ownedProcesses'] = []
    if (process.platform !== 'win32') {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)!
        return { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), executable: match[4] }
      })
      const owned = new Set([appPid!])
      for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid) }
      ownedProcesses.push(...rows.filter(row => owned.has(row.pid)))
      expect(ownedProcesses.some(row => row.pid === appPid)).toBe(true)
    }
    const value = { elapsedSeconds: (Date.now() - started) / 1000, cycle, windows, processes, ownedProcesses }; samples.push(value)
    if (baseline && ownedProcesses.length) {
      const total = (rows: ResourceSample['ownedProcesses']) => rows.reduce((sum, row) => sum + row.rssKiB, 0)
      expect(total(ownedProcesses) - total(baseline.ownedProcesses)).toBeLessThan(1024 * 1024)
      expect(ownedProcesses.length - baseline.ownedProcesses.length).toBeLessThanOrEqual(2)
    }
    if (baseline) for (let index = 0; index < windows.length; index++) {
      // Regression budgets after warmup/GC, not a proof of native leak freedom.
      expect(windows[index].heap - baseline.windows[index].heap).toBeLessThan(32 * 1024 * 1024)
      expect(windows[index].nodes - baseline.windows[index].nodes).toBeLessThan(2000)
      expect(windows[index].listeners - baseline.windows[index].listeners).toBeLessThan(400)
    }
    return value
  }
  try {
    checkpoint()
    const primary = await launch()
    await app!.evaluate(({ Tray, Menu, BrowserWindow }) => {
      const original = Tray.prototype.setContextMenu
      Tray.prototype.setContextMenu = function(menu) { (globalThis as any).enduranceTrayMenu = menu; return original.call(this, menu) }
      const item = Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!
      if (!item.checked) item.click(item, BrowserWindow.getAllWindows()[0], {} as any)
    })
    await expect.poll(() => app!.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('minimize-to-tray')!; return item.checked && item.enabled })).toBe(true)
    for (let index = 0; index < 3; index++) {
      let page = primary
      if (index) { const created = app!.waitForEvent('window'); await primary.evaluate(name => window.dbCommander.createWorkspaceWindow(name), `Endurance ${index}`); page = await created; await ready(page) }
      await page.evaluate(() => {
        const probe = { sessionId: '', complete: undefined as unknown, lost: '' }; (window as any).enduranceProbe = probe
        window.dbCommander.onEvent(event => {
          if (event.type === 'host-lost') { probe.lost = event.message; return }
          if (!probe.sessionId) probe.sessionId = event.sessionId
          if (probe.sessionId !== event.sessionId) return
          if (event.type === 'session-lost') probe.lost = event.message
          if (event.type === 'complete') probe.complete = event
        })
      })
      const engine = index === 1 ? 'sqlite' : 'duckdb', marker = `workspace_${index}`
      await page.getByRole('button', { name: 'Connect database', exact: true }).click()
      const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Open mode').selectOption('memory')
      await form.getByLabel('Save connection profile').uncheck(); await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
      await run(page, `CREATE TEMP TABLE endurance_state(marker VARCHAR, n INTEGER); INSERT INTO endurance_state VALUES('${marker}',7); ${index < 2 ? 'BEGIN;' : ''} UPDATE endurance_state SET n=8; SELECT marker,n FROM endurance_state;`)
      const native = await app!.browserWindow(page), cdp = await app!.context().newCDPSession(page); await cdp.send('Performance.enable')
      probes.push({ page, cdp, id: await native.evaluate(window => window.id), engine, marker, recordId: (await page.evaluate(() => window.dbCommander.workspaceWindows())).currentId })
    }
    const exportSession = await primary.evaluate(() => window.dbCommander.connect({ engine: 'duckdb', name: 'Endurance export', host: 'local', port: 1, user: 'local', database: 'DuckDB', password: '', tls: 'disable', duckdbMode: 'memory', recordHistory: false }))
    workloadStarted = Date.now()
    const deadline = workloadStarted + seconds * 1000
    state = 'running'; checkpoint()
    do {
      const tick = Date.now(), cancelProbe = probes[2]
      // Two transactions stay open while another workspace runs/cancels expensive SQL.
      await enter(cancelProbe.page, 'SELECT sum(hash(i)) FROM range(1000000000000) t(i);')
      await cancelProbe.page.evaluate(() => { (window as any).enduranceProbe.complete = undefined })
      await cancelProbe.page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(cancelProbe.page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
      for (const probe of probes) { const native = await app!.browserWindow(probe.page); await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false) }
      expect(await cancelProbe.page.evaluate(() => (window as any).enduranceProbe.complete)).toBeUndefined()
      const cancelling = performance.now()
      await cancelProbe.page.evaluate(() => window.dbCommander.cancel((window as any).enduranceProbe.sessionId))
      await expect.poll(() => cancelProbe.page.evaluate(() => (window as any).enduranceProbe.complete?.status)).toBe('cancelled')
      const cancelMs = performance.now() - cancelling; expect(cancelMs).toBeLessThan(5000)
      await trayCommand(app!, 'tray-show-all')
      for (const probe of probes) {
        const native = await app!.browserWindow(probe.page); await expect.poll(() => native.evaluate(window => window.isVisible() && !window.isMinimized())).toBe(true)
        await run(probe.page, 'SELECT marker,n,9223372036854775807 AS exact_value FROM endurance_state;')
        await expect(probe.page.getByRole('cell', { name: probe.marker, exact: true })).toBeVisible()
        await expect(probe.page.getByRole('cell', { name: '8', exact: true })).toBeVisible()
        await expect(probe.page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
        expect(await probe.page.evaluate(() => (window as any).enduranceProbe.lost)).toBe('')
      }
      let typingMs: number | undefined
      if (cycle % 10 === 0) {
        const file = join(directory, `export-${cycle}.csv`), began = performance.now()
        const job = await primary.evaluate(({ sessionId, file, rows }) => window.dbCommander.startTransfer({ action: 'export', sessionId, file, sql: `SELECT i,repeat('x',64) AS payload FROM range(${rows}) t(i)`, format: 'csv', confirmed: true }), { sessionId: exportSession.id, file, rows: exportRows })
        const typing = performance.now(); await enter(primary, `SELECT 'saved_cycle_${cycle}';`); typingMs = performance.now() - typing; expect(typingMs).toBeLessThan(2000)
        const native = await app!.browserWindow(primary); await native.evaluate(window => window.minimize()); await expect.poll(() => native.evaluate(window => window.isVisible())).toBe(false)
        await expect.poll(async () => (await primary.evaluate(() => window.dbCommander.transferJobs())).find(item => item.id === job.id)?.status, { timeout: 120000 }).toBe('completed')
        let lines = 0, first = '', last = ''
        for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) { lines++; if (lines === 2) first = line; last = line }
        expect(lines).toBe(exportRows + 1); expect(first).toBe(`"0","${'x'.repeat(64)}"`); expect(last).toBe(`"${exportRows - 1}","${'x'.repeat(64)}"`)
        exports.push({ cycle, rows: exportRows, bytes: statSync(file).size, durationMs: performance.now() - began }); rmSync(file)
        await trayCommand(app!, `tray-window-${probes[0].id}`)
        await primary.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(primary.locator('.status-text')).toHaveText('Connected')
        // Connected precedes database/schema discovery. Respect the same busy
        // guard as an interactive close instead of racing its confirmation.
        await expect(primary.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
        await primary.getByRole('button', { name: 'Close Query 2.sql', exact: true }).click(); await primary.getByRole('dialog', { name: 'Close query tab', exact: true }).getByRole('button', { name: 'Close tab', exact: true }).click()
        await expect(primary.getByRole('tab')).toHaveCount(1)
      }
      cycles.push({ cycle, durationMs: Date.now() - tick, cancelMs, typingMs }); cycle++
      if (cycle === 3) baseline = await sample()
      else if (cycle > 3 && cycle % 5 === 0) { await sample(); console.log(`Endurance: ${cycle} cycles, ${Math.round((Date.now() - started) / 1000)}s elapsed.`) }
      checkpoint()
      const remaining = deadline - Date.now()
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval * 1000, remaining)))
    } while (Date.now() < deadline || cycle < 6)
    workloadFinished = Date.now()
    expect(workloadFinished - workloadStarted).toBeGreaterThanOrEqual(seconds * 1000)
    await sample()
    state = 'verifying-restart'; checkpoint()
    for (let index = 0; index < probes.length; index++) {
      const page = probes[index].page
      if (index < 2) await run(page, 'ROLLBACK; SELECT n FROM endurance_state;')
      await expect(page.getByRole('cell', { name: index < 2 ? '7' : '8', exact: true })).toBeVisible()
      await enter(page, `SELECT 'endurance_saved_${index}' AS marker;`); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
      await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(`SELECT 'endurance_saved_${index}' AS marker;`)
    }
    await primary.evaluate(id => window.dbCommander.disconnect(id), exportSession.id)
    const histories = await Promise.all(probes.map(probe => probe.page.evaluate(() => window.dbCommander.history())))
    await primary.screenshot({ path: testInfo.outputPath('endurance-final.png') })
    await app!.close(); app = undefined
    const restarted = await launch()
    for (let index = 0; index < probes.length; index++) {
      let page = restarted
      if (index) { const opened = app!.waitForEvent('window'); await restarted.evaluate(id => window.dbCommander.openWorkspaceWindow(id), probes[index].recordId); page = await opened; await ready(page) }
      expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(`SELECT 'endurance_saved_${index}' AS marker;`)
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(histories[index])
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    }
    state = 'passed'; checkpoint()
  } catch (error) {
    state = 'failed'; errorMessage = error instanceof Error ? error.stack : String(error); checkpoint()
    // The failing page may be hidden or not be Playwright's last active page.
    // Retain each workspace's accessible state before closing the owned app.
    for (const probe of probes) await probe.page.locator('body').ariaSnapshot({ timeout: 2000 })
      .then(body => testInfo.attach(`endurance-window-${probe.id}`, { body, contentType: 'text/plain' })).catch(() => {})
    throw error
  }
  finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {})
    await testInfo.attach('endurance-progress', { path: reportPath, contentType: 'application/json' })
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
