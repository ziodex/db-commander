import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { duplicateArguments, observeDuplicate } from './duplicate-launch'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
function environment(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  return env as Record<string, string>
}
async function launch(directory: string) {
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: environment(directory) })
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
  await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
}
function stopDuplicate(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  // Each raw test launch owns a separate process group. Never kill another app
  // instance or leave a failed regression's native database host behind.
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}

for (const alias of [false, true]) test(`profile ownership reuses the live owner through ${alias ? 'a filesystem alias' : 'a repeated launch'}`, async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-profile-owner-')), link = `${directory}-alias`
  let app: ElectronApplication | undefined, duplicate: ChildProcess | undefined, diagnostics: ReturnType<typeof observeDuplicate> | undefined
  try {
    if (alias) symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
    const configured = alias ? link : directory
    const launched = await launch(configured); app = launched.app
    let page = launched.page
    if (!alias) {
      const created = app.waitForEvent('window')
      await page.evaluate(() => window.dbCommander.createWorkspaceWindow('Owned analysis'))
      page = await created; await waitForWorkspaceReady(page)
    }
    expect(await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }))).toEqual({ userData: configured, sessionData: configured })
    const sql = "SELECT 'owned_unexecuted_buffer';"
    await enter(page, sql)
    const before = await page.evaluate(async () => ({ workspace: await window.dbCommander.loadWorkspace(), history: await window.dbCommander.history() }))
    const native = await app.browserWindow(page)
    if (alias) await native.evaluate(window => window.minimize())
    const executable = await app.evaluate(() => process.execPath)
    const args = duplicateArguments(app.process().spawnargs, process.env.SQLCOMMANDER_TEST_EXECUTABLE ? [] : [resolve('.')])
    duplicate = spawn(executable, args, { env: environment(directory), detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
    diagnostics = observeDuplicate(duplicate)
    try {
      await expect.poll(() => diagnostics!().spawnError ?? duplicate!.signalCode ?? duplicate!.exitCode, { timeout: 8_000, message: 'A repeated launch must exit instead of opening another workspace writer.' }).toBe(0)
    } catch (error) { throw new Error(`${(error as Error).message}\nDuplicate launch diagnostics: ${JSON.stringify({ ...diagnostics(), arguments: args })}`, { cause: error }) }
    await expect.poll(() => native.evaluate(window => window.isMinimized())).toBe(false)
    await expect.poll(() => native.evaluate(window => window.isFocused())).toBe(true)
    expect(app.windows()).toHaveLength(alias ? 1 : 2)
    expect(await page.evaluate(async () => ({ workspace: await window.dbCommander.loadWorkspace(), history: await window.dbCommander.history() }))).toEqual(before)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    writeFileSync(testInfo.outputPath('profile-owner.json'), JSON.stringify({ alias, ownerPid: await app.evaluate(() => process.pid), duplicateExitCode: duplicate.exitCode, bufferPreserved: true, historyUnchanged: true }, null, 2))
  } finally {
    try {
      if (diagnostics) await testInfo.attach('profile-duplicate.json', { body: JSON.stringify(diagnostics(), null, 2), contentType: 'application/json' })
    } finally { stopDuplicate(duplicate); await close(app); await rm(link, { force: true }); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  }
})

test('profile ownership permits independent profiles and releases ownership after normal exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-independent-profiles-'))
  let first: ElectronApplication | undefined, second: ElectronApplication | undefined
  try {
    let owner = await launch(join(directory, 'first')); first = owner.app
    if (process.platform !== 'win32') expect(statSync(join(directory, 'first')).mode & 0o077).toBe(0)
    await enter(owner.page, "SELECT 'first_profile';")
    const other = await launch(join(directory, 'second')); second = other.app
    await enter(other.page, "SELECT 'second_profile';")
    expect((await owner.page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe("SELECT 'first_profile';")
    await first.close(); first = undefined
    owner = await launch(join(directory, 'first')); first = owner.app
    expect((await owner.page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe("SELECT 'first_profile';")
    expect((await other.page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe("SELECT 'second_profile';")
  } finally { await close(second); await close(first); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
