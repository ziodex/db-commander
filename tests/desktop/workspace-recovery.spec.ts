import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
const sql = (page: Page) => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)

test('workspace recovery flushes edits made while the final close save is pending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-workspace-flush-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app
    const baseline = 'SELECT before_pending_close;', latest = 'SELECT edited_during_pending_close;'
    await enter(launched.page, baseline); await expect.poll(() => sql(launched.page)).toBe(baseline)
    // Wrap a fresh real host so only workspace saves can be delayed. Queries,
    // reads and the normal five-second close deadline retain production behavior.
    await app.evaluate(({ utilityProcess }) => {
      const fork = utilityProcess.fork.bind(utilityProcess)
      const control = { hold: false, pending: [] as { sql: string; send(): void }[] }
      ;(globalThis as any).__workspaceSaves = control
      utilityProcess.fork = (...args) => {
        const child = fork(...args), send = child.postMessage.bind(child)
        child.postMessage = message => {
          if (control.hold && message.method === 'saveWorkspace') control.pending.push({ sql: message.payload.tabs[0].sql, send: () => send(message) })
          else send(message)
        }
        return child
      }
    })
    const recovered = app.waitForEvent('window'), original = await app.browserWindow(launched.page)
    await original.evaluate(window => window.webContents.forcefullyCrashRenderer())
    const page = await recovered
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('before_pending_close')
    // Pause only renderer timers so its 250 ms autosave cannot hide a stale
    // close acknowledgment. Keyboard input and native IPC remain live.
    await page.locator('.monaco-editor').click()
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000))
    await app.evaluate(() => { (globalThis as any).__workspaceSaves.hold = true })
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate(window => window.close())
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__workspaceSaves.pending.map((item: any) => item.sql))).toEqual([baseline])
    for (const buffer of ['SELECT edited_during_first_close_save;', latest]) {
      await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(buffer)
      await app.evaluate(() => { (globalThis as any).__workspaceSaves.pending.shift().send() })
      await expect.poll(() => app!.evaluate(() => (globalThis as any).__workspaceSaves.pending.map((item: any) => item.sql))).toEqual([buffer])
      expect(page.isClosed()).toBe(false)
    }
    await app.evaluate(() => {
      const control = (globalThis as any).__workspaceSaves
      control.hold = false; control.pending.shift().send()
    })
    await expect.poll(() => page.isClosed()).toBe(true)
    await close(app); app = undefined
    launched = await launch(directory); app = launched.app
    expect(await sql(launched.page)).toBe(latest)
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText('edited_during_pending_close')
    await expect(launched.page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('workspace recovery reports failed saves, keeps buffers on cancelled close and retries without editing', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-workspace-save-failure-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; const page = launched.page
    const baseline = 'SELECT committed_workspace;', latest = 'SELECT retained_after_workspace_failure;'
    await enter(page, baseline); await expect.poll(() => sql(page)).toBe(baseline)
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
    try { db.exec("CREATE TRIGGER fail_workspace_save BEFORE INSERT ON workspace BEGIN SELECT RAISE(FAIL, 'Injected workspace storage failure'); END") }
    finally { db.close() }
    await enter(page, latest)
    await expect(page.locator('.error-banner')).toContainText('Injected workspace storage failure')
    await expect(page.getByText('Workspace not saved', { exact: true })).toBeVisible()
    expect(await sql(page)).toBe(baseline)
    await page.screenshot({ path: testInfo.outputPath('workspace-save-failure.png') })
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__workspaceClosePrompts = []
      dialog.showMessageBox = async (windowOrOptions: any, options?: any) => {
        ;(globalThis as any).__workspaceClosePrompts.push(options ?? windowOrOptions)
        return { response: 0, checkboxChecked: false }
      }
    })
    const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(window => window.close())
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__workspaceClosePrompts.map((prompt: any) => prompt.title))).toContain('Workspace not saved')
    expect(page.isClosed()).toBe(false)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('retained_after_workspace_failure')
    const repair = new DatabaseSync(join(directory, 'workspace.sqlite'))
    try { repair.exec('DROP TRIGGER fail_workspace_save') } finally { repair.close() }
    await page.getByRole('button', { name: 'Retry workspace save', exact: true }).click()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect(await sql(page)).toBe(latest)
    await expect(page.getByRole('button', { name: 'Retry workspace save', exact: true })).toHaveCount(0)
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app
    expect(await sql(launched.page)).toBe(latest)
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
