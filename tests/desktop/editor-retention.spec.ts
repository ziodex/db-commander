import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type CDPSession, type Page, type TestInfo } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-retention-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await waitForWorkspaceReady(page)
    await expect(page.locator('.monaco-editor')).toBeVisible()
    const cdp = await app.context().newCDPSession(page); await cdp.send('Performance.enable')
    return { app, page, cdp, close: async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } }
  } catch (error) {
    await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); throw error
  }
}
async function sample(cdp: CDPSession, phase: string) {
  await cdp.send('HeapProfiler.collectGarbage')
  const dom = await cdp.send('Memory.getDOMCounters'), metrics = await cdp.send('Performance.getMetrics')
  return { phase, ...dom, heap: metrics.metrics.find((metric: { name: string }) => metric.name === 'JSHeapUsedSize')!.value }
}
async function retainSamples(testInfo: TestInfo, name: string, samples: unknown[]) {
  const path = testInfo.outputPath(name)
  writeFileSync(path, JSON.stringify(samples, null, 2))
  // Keep the counters in both CI logs and JUnit attachments, so a failed
  // resource guard can be investigated without downloading a heap archive.
  console.log(`${name}: ${JSON.stringify(samples)}`)
  await testInfo.attach(name, { path, contentType: 'application/json' })
}
async function retainedViewStates(cdp: CDPSession, file: string) {
  const chunks: string[] = [], listener = ({ chunk }: { chunk: string }) => chunks.push(chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', listener)
  try { await cdp.send('HeapProfiler.takeHeapSnapshot') }
  finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', listener) }
  writeFileSync(file, chunks.join('')); chunks.length = 0
  const heap = JSON.parse(readFileSync(file, 'utf8'))
  const nf = heap.snapshot.meta.node_fields, ef = heap.snapshot.meta.edge_fields
  const edgeCount = nf.indexOf('edge_count'), edgeType = ef.indexOf('type'), edgeName = ef.indexOf('name_or_index')
  const edgeTypes = heap.snapshot.meta.edge_types[edgeType]
  let count = 0, edge = 0
  // Match Monaco's public ICodeEditorViewState shape, independently of bundler
  // variable names. Raw heap size alone hides this small per-closed-tab leak.
  for (let node = 0; node < heap.nodes.length; node += nf.length) {
    let fields = 0
    for (let i = 0; i < heap.nodes[node + edgeCount]; i++, edge += ef.length) {
      if (edgeTypes[heap.edges[edge + edgeType]] !== 'property') continue
      const name = heap.strings[heap.edges[edge + edgeName]]
      if (name === 'cursorState') fields |= 1
      if (name === 'viewState') fields |= 2
      if (name === 'contributionsState') fields |= 4
    }
    if (fields === 7) count++
  }
  return count
}
async function scratch(page: Page) {
  await page.getByRole('button', { name: 'New query tab', exact: true }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.locator('.monaco-editor').click(); await page.keyboard.insertText('SELECT closed_scratch;')
  await page.getByRole('button', { name: 'Close Query 2.sql', exact: true }).click()
  await page.getByRole('dialog', { name: 'Close query tab', exact: true }).getByRole('button', { name: 'Close tab', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(1); await expect(page.locator('.monaco-editor')).toBeVisible()
}
async function readyForSnapshot(page: Page) {
  const editor = page.locator('.monaco-editor')
  // Visible can still mean Monaco's initial 5px layout. Compare fully laid-out
  // editors with the same lazy suggestion controls, not two creation stages.
  await expect.poll(() => editor.evaluate(element => element.clientWidth > 100 && element.clientHeight > 100)).toBe(true)
  await editor.locator('textarea').focus(); await page.keyboard.press('Control+Space')
  const suggestions = editor.locator('.suggest-widget')
  await expect(suggestions).toHaveClass(/\bvisible\b/)
  // Monaco hides this message after loading but retains its text in the DOM.
  await expect(suggestions.getByText('Loading...', { exact: true })).not.toBeVisible()
  await page.keyboard.press('Escape')
  await expect(suggestions).not.toHaveClass(/\bvisible\b/)
}

test('closed scratch tabs release view states while open tabs retain selection, scroll and undo', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const { page, cdp, close } = await launch(), samples = []
  try {
    const sql = Array.from({ length: 300 }, (_, n) => `SELECT ${n} AS retained_line;`).join('\n') + '\n-- selected_marker'
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    for (let i = 0; i < 'selected_marker'.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    const selected = () => page.locator('.monaco-editor textarea').evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))
    await expect.poll(selected).toBe('selected_marker')
    const firstLine = () => page.locator('.monaco-editor .view-line').first().innerText()
    const scrolledLine = await firstLine(); expect(scrolledLine).not.toContain('SELECT 0 ')
    for (let i = 0; i < 4; i++) await scratch(page)
    await readyForSnapshot(page)
    // Snapshot collection also settles Blink's native listener collection.
    // Sample afterward so the DOM counters and retained view states describe
    // the same post-collection state, not native listeners awaiting collection.
    const warmupViews = await retainedViewStates(cdp, testInfo.outputPath('warmup.heapsnapshot'))
    samples.push({ ...await sample(cdp, 'warmup'), views: warmupViews })
    expect(samples[0].views).toBeGreaterThan(0)
    for (let i = 0; i < 40; i++) await scratch(page)
    await readyForSnapshot(page)
    const closedViews = await retainedViewStates(cdp, testInfo.outputPath('closed-40.heapsnapshot'))
    samples.push({ ...await sample(cdp, 'closed_40'), views: closedViews })
    await expect.poll(firstLine).toBe(scrolledLine)
    await page.locator('.monaco-editor textarea').focus(); await expect.poll(selected).toBe('selected_marker')
    await page.keyboard.press('ArrowRight')
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).not.toBe(sql)
    await page.keyboard.press(`${modifier}+Z`)
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    expect(samples[1].views - samples[0].views).toBeLessThanOrEqual(2)
    expect(samples[1].nodes - samples[0].nodes).toBeLessThan(100)
    expect(samples[1].jsEventListeners - samples[0].jsEventListeners).toBeLessThan(10)
  } finally {
    try { await retainSamples(testInfo, 'view-retention.json', samples) }
    finally { await close() }
  }
})

test('native input DOM retention plateaus without clearing the open SQL buffer undo history', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const { page, cdp, close } = await launch(), samples = []
  try {
    // Lazy completion controls have a one-time DOM/listener cost. Initialize
    // them before comparing retention from repeated edits, as in the tab test.
    await readyForSnapshot(page)
    for (let i = 1; i <= 1500; i++) {
      await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(`SELECT '${String(i).padStart(4, '0')}' AS n;`); await page.keyboard.press('Escape')
      if ([100, 1100, 1500].includes(i)) {
        // Compare the same settled completion UI. Merely creating its shell
        // can leave asynchronous list/action listeners pending at a sample.
        await readyForSnapshot(page)
        samples.push(await sample(cdp, `edit_${i}`))
      }
    }
    // Blink retains native textarea undo commands as well as Monaco's model
    // undo. Measure after that native history is warm, not against an empty one.
    expect(samples[2].nodes - samples[1].nodes).toBeLessThan(100)
    expect(samples[2].jsEventListeners - samples[1].jsEventListeners).toBeLessThan(10)
    expect(samples[2].heap - samples[1].heap).toBeLessThan(4 * 1024 * 1024)
    const text = () => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)
    let value = await text()
    // Monaco may split inserted text at word boundaries. Undo through those
    // groups until the previous replacement is recovered, without assuming a
    // single synthetic insertText call is one model undo step.
    for (let i = 0; i < 10 && value !== "SELECT '1499' AS n;"; i++) {
      await page.keyboard.press(`${modifier}+Z`)
      await expect.poll(text).not.toBe(value); value = await text()
    }
    expect(value).toBe("SELECT '1499' AS n;")
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally {
    try { await retainSamples(testInfo, 'input-retention.json', samples) }
    finally { await close() }
  }
})
