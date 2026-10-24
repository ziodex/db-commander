import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-export-fault-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await waitForWorkspaceReady(page)
    return { app, page, directory }
  } catch (error) { await close(app); rmSync(directory, { recursive: true, force: true }); throw error }
}
async function close(app: ElectronApplication) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
}
async function connect(page: Page, engine: 'sqlite' | 'duckdb') {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
  await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Save connection profile').uncheck()
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
}
async function run(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
}
async function destination(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, file)
}

for (const engine of ['sqlite', 'duckdb'] as const) test(`export safety ${engine}: fetched CSV refuses existing files and retries without SQL replay`, async () => {
  const { app, page, directory } = await launch()
  try {
    await connect(page, engine)
    const sql = "SELECT 9223372036854775807 AS exact_value, NULL AS missing, '' AS empty_text, 'Ω' AS unicode_value;"
    await run(page, sql)
    const existing = join(directory, 'existing.csv'); writeFileSync(existing, 'keep existing bytes')
    await destination(app, existing); await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('already exists')
    expect(readFileSync(existing, 'utf8')).toBe('keep existing bytes')
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
    const retry = join(directory, 'retry.csv'); await destination(app, retry)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(retry, 'utf8')).toBe('"exact_value","missing","empty_text","unicode_value"\r\n"9223372036854775807",,"","Ω"\r\n')
    expect((await page.evaluate(() => window.dbCommander.history())).map(entry => entry.sql)).toEqual([sql])
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
    await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    expect(readdirSync(directory).some(name => name.startsWith('.dbcommander-backup-'))).toBe(false)
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('export disk full: real ENOSPC leaves no partial preview or full export and permits retry', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'The bounded HFS+ disk-image fixture requires macOS; injected publication faults run in the portable unit suite.')
  test.setTimeout(120000)
  const { app, page, directory } = await launch(), mount = join(directory, 'volume'), image = join(directory, 'destination.dmg')
  let mounted = false
  try {
    execFileSync('hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-volname', 'DbCommanderExportFault', '-type', 'UDIF', '-nospotlight', image], { stdio: 'pipe' })
    execFileSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, image], { stdio: 'pipe' }); mounted = true
    writeFileSync(join(mount, '.metadata_never_index'), '')
    const filler = join(mount, 'filler'), descriptor = openSync(filler, 'wx', 0o600), block = Buffer.alloc(1024 * 1024)
    let full = false
    try {
      // The private volume is at most 32 MiB; never fill the host filesystem.
      for (let index = 0; index < 40; index++) writeSync(descriptor, block)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error; full = true }
    finally { ftruncateSync(descriptor, Math.max(0, fstatSync(descriptor).size - 128 * 1024)); closeSync(descriptor) }
    expect(full).toBe(true)
    await connect(page, 'duckdb')
    await page.evaluate(() => {
      const off = window.dbCommander.onEvent(event => {
        if (event.type === 'complete') { (window as any).__exportSessionId = event.sessionId; off() }
      })
    })
    const sql = "SELECT 9223372036854775807 AS exact_value, repeat('x',512) AS payload FROM range(1000);"
    await run(page, sql)
    const preview = join(mount, 'preview.csv'); await destination(app, preview)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('ENOSPC')
    expect(existsSync(preview)).toBe(false)
    expect(readdirSync(mount).some(name => name.startsWith('.dbcommander-backup-'))).toBe(false)
    await page.screenshot({ path: info.outputPath('export-disk-full.png') })
    const output = join(mount, 'full.csv')
    // Capture the tab session from its completed query, without reaching into React.
    const start = () => page.evaluate(file => window.dbCommander.startTransfer({ action: 'export', sessionId: (window as any).__exportSessionId, file,
      sql: "SELECT i, repeat('y',4096) AS payload FROM range(1000) t(i)", format: 'csv', confirmed: true }), output)
    const transfer = await start()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.transferJobs())).find(job => job.id === transfer.id)?.status).toBe('failed')
    expect((await page.evaluate(() => window.dbCommander.transferJobs())).find(job => job.id === transfer.id)?.phase).toContain('ENOSPC')
    expect(existsSync(output)).toBe(false)
    expect(readdirSync(mount).some(name => name.startsWith('.dbcommander-backup-'))).toBe(false)
    rmSync(filler)
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    const csv = readFileSync(preview, 'utf8').split('\r\n')
    expect(csv).toHaveLength(1002); expect(csv[1]).toBe(`"9223372036854775807","${'x'.repeat(512)}"`); expect(csv[1000]).toBe(csv[1])
    const retry = await start()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.transferJobs())).find(job => job.id === retry.id)?.status).toBe('completed')
    const fullCsv = readFileSync(output, 'utf8').split('\r\n')
    expect(fullCsv).toHaveLength(1002); expect(fullCsv[1]).toBe(`"0","${'y'.repeat(4096)}"`); expect(fullCsv[1000]).toBe(`"999","${'y'.repeat(4096)}"`)
    expect((await page.evaluate(() => window.dbCommander.history())).map(entry => entry.sql)).toEqual([sql])
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
    await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true }).first()).toBeVisible()
    const report = info.outputPath('export-disk-full.json')
    writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, volume: '32 MiB private HFS+ image', reachedENOSPC: full, reservedBytes: 128 * 1024,
      previewRows: csv.length - 2, fullRows: fullCsv.length - 2, failedTransfer: transfer.id, retriedTransfer: retry.id, temporaryFiles: readdirSync(mount).filter(name => name.startsWith('.dbcommander-backup-')) }, null, 2))
    await info.attach('export-disk-full.json', { path: report, contentType: 'application/json' })
    await run(page, 'SELECT 42 AS still_usable;'); await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  } finally {
    await close(app)
    if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'pipe' })
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
