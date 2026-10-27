import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { cp, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { probeSqliteWorker } from '../../scripts/release/startup-diagnostics.mjs'

test('packaged startup survives an unavailable DuckDB native library through an installation alias', async () => {
  test.skip(!process.env.SQLCOMMANDER_TEST_EXECUTABLE, 'Requires a native packaged application.')
  const executable = resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE!)
  const source = process.platform === 'darwin' ? resolve(executable, '../../..') : dirname(executable)
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-startup-'))
  const suffix = process.platform === 'darwin' ? '.app' : ''
  const installation = join(directory, `Application with spaces % # é${suffix}`), alias = join(directory, `installation-alias${suffix}`)
  let app: ElectronApplication | undefined
  let stderr = ''
  try {
    await cp(source, installation, { recursive: true, verbatimSymlinks: true })
    const resources = join(installation, process.platform === 'darwin' ? 'Contents/Resources' : 'resources')
    const bindings = join(resources, 'app.asar.unpacked/node_modules/@duckdb')
    const binaries = (await readdir(bindings, { recursive: true })).filter(name => name.endsWith('duckdb.node'))
    expect(binaries.length).toBeGreaterThan(0)
    await symlink(installation, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(directory, 'workspace') }
    delete env.ELECTRON_RUN_AS_NODE
    const launch = () => electron.launch({ executablePath: join(alias, relative(source, executable)), env: env as Record<string, string> })
    app = await launch()
    const original = await app.firstWindow()
    await waitForWorkspaceReady(original)
    await original.locator('.monaco-editor').click()
    await original.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    const recoveredSql = 'SELECT 987654321 AS recovered_buffer;'
    await original.keyboard.insertText(recoveredSql)
    await expect.poll(() => original.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)).toBe(recoveredSql)
    await app.close(); app = undefined

    // Corrupt only this test's private copy, simulating an unavailable DLL/addon.
    for (const binary of binaries) await writeFile(join(bindings, binary), 'Unavailable native library fixture')
    app = await launch()
    app.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000) })
    const page = await app.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor')).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('recovered_buffer')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined')

    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('duckdb')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('DuckDB native library')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    const run = page.getByRole('button', { name: /^Run SQL/ })
    await expect(run).toBeEnabled()
    await page.locator('.monaco-editor').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText('SELECT 42 AS answer;')
    await run.click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  } catch (error) {
    console.error('Native-library fault startup diagnostics:', stderr)
    const entry = join(installation, process.platform === 'darwin' ? 'Contents/Resources' : 'resources', 'workers/sqlite-worker.cjs')
    console.error('Standalone in-memory SQLite worker diagnostics:', await probeSqliteWorker(join(alias, relative(source, executable)), entry))
    throw error
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

for (const fault of ['throw', 'stall'] as const) test(`database host startup recovers after a ${fault === 'throw' ? 'failed launch' : 'startup timeout'} without replaying SQL`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-host-startup-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const original = await app.firstWindow()
    await waitForWorkspaceReady(original)
    const sql = 'SELECT 123456789 AS never_replayed_after_startup_failure;'
    await original.locator('.monaco-editor').click()
    await original.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await original.keyboard.insertText(sql)
    await expect.poll(() => original.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)).toBe(sql)

    await app.evaluate(({ utilityProcess }, fault) => {
      const fork = utilityProcess.fork.bind(utilityProcess)
      const control = { active: true, blocked: 0, stops: 0, exits: 0 }
      ;(globalThis as any).__hostStartupFault = control
      utilityProcess.fork = (...args) => {
        if (control.active && fault === 'throw') throw new Error('Injected database host launch failure.')
        const child = fork(...args)
        if (control.active && fault === 'stall') {
          const emit = child.emit.bind(child), kill = child.kill.bind(child)
          child.emit = (event: string, ...values: any[]) => {
            if (event === 'message' && values[0]?.ready) { control.blocked++; return false }
            return emit(event, ...values)
          }
          child.kill = () => { control.stops++; return kill() }
          child.once('exit', () => { control.exits++ })
        }
        return child
      }
    }, fault)
    const recovered = app.waitForEvent('window')
    const originalWindow = await app.browserWindow(original)
    await originalWindow.evaluate(window => window.webContents.forcefullyCrashRenderer())
    const page = await recovered
    if (fault === 'throw') {
      await expect(page.locator('.error-banner')).toContainText('Injected database host launch failure.')
    } else {
      await expect.poll(() => app!.evaluate(() => (globalThis as any).__hostStartupFault.blocked)).toBeGreaterThan(0)
      await expect.poll(() => app!.evaluate(() => (globalThis as any).__hostStartupFault.stops), { timeout: 20_000 }).toBe(1)
      await expect.poll(() => app!.evaluate(() => (globalThis as any).__hostStartupFault.exits)).toBe(1)
    }
    await app.evaluate(() => { (globalThis as any).__hostStartupFault.active = false })
    // Retrying is an explicit renderer reload, never an automatic SQL replay.
    await page.reload()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('never_replayed_after_startup_failure')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    const run = page.getByRole('button', { name: /^Run SQL/ })
    await expect(run).toBeEnabled()
    await page.locator('.monaco-editor').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText('SELECT 43 AS recovered;')
    await run.click()
    await expect(page.getByRole('cell', { name: '43', exact: true })).toBeVisible()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
