import { _electron as electron, test, expect, type ElectronApplication, type Page, type CDPSession } from '@playwright/test'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
function setting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`)
  return value
}
const cycles = setting('SQLCOMMANDER_SOAK_CYCLES', 64, 12, 1000)
const exportRows = setting('SQLCOMMANDER_SOAK_EXPORT_ROWS', 100_000, 10_000, 10_000_000)
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-soak-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const cdp = await app.context().newCDPSession(page); await cdp.send('Performance.enable')
    return { app, page, directory, cdp }
  } catch (error) { await close(app, directory); throw error }
}
async function close(app: ElectronApplication, directory: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
async function enter(page: Page, text: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(text); await page.keyboard.press('Escape')
}
async function sample(cdp: CDPSession, app: ElectronApplication, phase: string) {
  await cdp.send('HeapProfiler.collectGarbage')
  const dom = await cdp.send('Memory.getDOMCounters'), metrics = await cdp.send('Performance.getMetrics')
  const heap = metrics.metrics.find((metric: { name: string }) => metric.name === 'JSHeapUsedSize')!.value
  const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(process => ({ type: process.type, name: process.name, workingSetKiB: process.memory.workingSetSize })))
  return { phase, heap, ...dom, processes }
}

test('local soak keeps repeated query results, scratch tabs and DOM resources bounded', async ({}, testInfo) => {
  test.setTimeout(Math.max(180_000, cycles * 3000))
  const { app, page, directory, cdp } = await launch()
  const samples: Awaited<ReturnType<typeof sample>>[] = [], durations: number[] = []
  try {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb')
    await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Save connection profile').uncheck()
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
    for (let iteration = 0; iteration < cycles + 4; iteration++) {
      const started = performance.now(), marker = `cycle_${iteration}`
      await enter(page, `SELECT '${marker}' AS marker, i, repeat('x',256) AS payload FROM range(100000) t(i);`)
      await page.getByRole('button', { name: /^Run SQL/ }).click()
      await expect(page.getByRole('cell', { name: marker, exact: true }).first()).toBeVisible()
      await expect(page.locator('.status-text')).toHaveText('Completed')
      const grid = page.getByRole('table', { name: 'Query results', exact: true })
      await expect(grid).toHaveAttribute('aria-rowcount', '1001')
      expect(await grid.getByRole('row').count()).toBeLessThan(80)
      await page.getByRole('button', { name: 'New query tab', exact: true }).click()
      // New tabs reuse the current session. Respect the same
      // connection/metadata guard that protects an interactive close request.
      await expect(page.locator('.status-text')).toHaveText('Connected')
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
      await page.getByRole('button', { name: 'Close Query 2.sql', exact: true }).click()
      await page.getByRole('dialog', { name: 'Close query tab', exact: true }).getByRole('button', { name: 'Close tab', exact: true }).click()
      await expect(page.getByRole('tab')).toHaveCount(1)
      await expect(grid).toHaveAttribute('aria-rowcount', '1001')
      durations.push(performance.now() - started)
      if (cycles > 64 && iteration > 3 && (iteration - 3) % 100 === 0) console.log(`Soak: ${iteration - 3}/${cycles} query/tab/connection cycles completed.`)
      if (iteration === 3 || iteration === cycles + 3 || iteration === 3 + Math.floor(cycles / 2)) samples.push(await sample(cdp, app, `cycle_${iteration - 3}`))
    }
    const baseline = samples[0], final = samples.at(-1)!
    // Post-GC retained-resource guards, not universal throughput targets.
    expect(final.heap - baseline.heap).toBeLessThan(16 * 1024 * 1024)
    expect(final.nodes - baseline.nodes).toBeLessThan(1500)
    expect(final.jsEventListeners - baseline.jsEventListeners).toBeLessThan(300)
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs).toHaveLength(1)
  } finally {
    const report = testInfo.outputPath('soak-resources.json')
    writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, cycles, warmup: 4, previewRows: 1000, sourceRowsPerQuery: 100000, durationsMs: durations, samples }, null, 2))
    await testInfo.attach('soak-resources.json', { path: report, contentType: 'application/json' })
    await close(app, directory)
  }
})

test('local soak streams exports and cancellation while typing remains responsive and preview cache survives', async ({}, testInfo) => {
  test.setTimeout(Math.max(180_000, exportRows / 2))
  const { app, page, directory, cdp } = await launch(), output = join(directory, 'exports')
  mkdirSync(output)
  const samples: Awaited<ReturnType<typeof sample>>[] = [], exports: { rows: number; bytes: number; durationMs: number; typingMs: number }[] = []
  try {
    const preview = await page.evaluate(async () => {
      const api = window.dbCommander, session = await api.connect({ engine: 'duckdb', name: 'Soak fixture', host: 'local', port: 1, user: 'local', database: 'DuckDB', password: '', tls: 'disable', duckdbMode: 'memory' })
      const rows: (string | null)[][] = []
      let queryId = ''
      await new Promise<void>((resolve, reject) => {
        const off = api.onEvent(event => {
          if (event.type === 'host-lost' || event.sessionId !== session.id) return
          if (event.type === 'rows') rows.push(...event.rows)
          if (event.type === 'complete') { off(); queryId = event.queryId; event.status === 'completed' ? resolve() : reject(new Error(event.error)) }
        })
        void api.run({ sessionId: session.id, sql: 'SELECT 9223372036854775807::BIGINT AS exact_value;', maxRows: 1000 }).catch(error => { off(); reject(error) })
      })
      return { sessionId: session.id, queryId, rows }
    })
    expect(preview.rows).toEqual([['9223372036854775807']])
    async function cached(file: string) {
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
      await page.evaluate(queryId => window.dbCommander.exportCsv(queryId, 0), preview.queryId)
    }
    await cached(join(output, 'before.csv')); samples.push(await sample(cdp, app, 'before_exports'))
    for (const rows of [exportRows, exportRows * 2]) {
      const file = join(output, `full-${rows}.csv`), started = performance.now()
      const job = await page.evaluate(({ sessionId, file, rows }) => window.dbCommander.startTransfer({ action: 'export', sessionId, file, sql: `SELECT i, repeat('x',64) AS payload FROM range(${rows}) t(i)`, format: 'csv', confirmed: true }), { sessionId: preview.sessionId, file, rows })
      const typing = performance.now(); await enter(page, `SELECT typing_during_${rows}_row_export;`)
      const typingMs = performance.now() - typing
      expect(typingMs).toBeLessThan(2000)
      await expect.poll(async () => (await page.evaluate(() => window.dbCommander.transferJobs())).find(item => item.id === job.id)?.status, { timeout: Math.max(120_000, rows / 10) }).toBe('completed')
      let lines = 0, first = '', last = ''
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        lines++; if (lines === 2) first = line; last = line
      }
      expect(lines).toBe(rows + 1); expect(first).toBe(`"0","${'x'.repeat(64)}"`); expect(last).toBe(`"${rows - 1}","${'x'.repeat(64)}"`)
      exports.push({ rows, bytes: statSync(file).size, durationMs: performance.now() - started, typingMs })
      samples.push(await sample(cdp, app, `after_${rows}_rows`))
    }
    const cancelled = join(output, 'cancelled.csv')
    const job = await page.evaluate(({ sessionId, file }) => window.dbCommander.startTransfer({ action: 'export', sessionId, file, sql: "SELECT i, repeat('x',128) FROM range(1000000000) t(i)", format: 'csv', confirmed: true }), { sessionId: preview.sessionId, file: cancelled })
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.transferJobs())).find(item => item.id === job.id)?.rows).toBeGreaterThan(0)
    await page.evaluate(id => window.dbCommander.cancelTransfer(id), job.id)
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.transferJobs())).find(item => item.id === job.id)?.status).toBe('cancelled')
    await cached(join(output, 'after.csv'))
    expect(readFileSync(join(output, 'after.csv'), 'utf8')).toBe(readFileSync(join(output, 'before.csv'), 'utf8'))
    expect(readdirSync(output).sort()).toEqual(['after.csv', 'before.csv', `full-${exportRows}.csv`, `full-${exportRows * 2}.csv`].sort())
    await page.evaluate(id => window.dbCommander.disconnect(id), preview.sessionId)
    samples.push(await sample(cdp, app, 'after_disconnect'))
    expect(samples.at(-1)!.heap - samples[0].heap).toBeLessThan(16 * 1024 * 1024)
  } finally {
    const report = testInfo.outputPath('soak-exports.json')
    writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, exports, samples }, null, 2))
    await testInfo.attach('soak-exports.json', { path: report, contentType: 'application/json' })
    await close(app, directory)
  }
})
