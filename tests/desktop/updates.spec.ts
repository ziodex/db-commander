import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

async function launch(directory: string, status = 200) {
  const application = join(directory, 'application'), profile = join(directory, 'profile')
  mkdirSync(application, { recursive: true }); mkdirSync(profile, { recursive: true })
  cpSync(resolve('build/icons'), join(application, 'build/icons'), { recursive: true })
  writeFileSync(join(application, 'package.json'), JSON.stringify({ name: 'dbcommander', version: '0.1.0', main: resolve('tests/desktop/update-bootstrap.cjs') }))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: profile, DBCOMMANDER_UPDATE_TEST_MAIN: resolve('out/main/index.cjs'), DBCOMMANDER_UPDATE_TEST_STATUS: String(status) }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [application], env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await waitForWorkspaceReady(page)
    return { app, page, profile }
  } catch (error) {
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {})
    await app.close().catch(() => {})
    throw error
  }
}
async function manualCheck(app: ElectronApplication) {
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('check-for-updates')!.enabled)).toBe(true)
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const menu = Menu.getApplicationMenu()!, item = menu.getMenuItemById('check-for-updates')!
    if (!menu.items.some(parent => parent.role === 'help' && parent.submenu?.items.some(child => child.id === item.id))) throw new Error('Check for updates must belong to Help.')
    item.click(item, BrowserWindow.getFocusedWindow()!, {} as any)
  })
}
async function closeFixture(app: ElectronApplication | undefined) {
  if (!app) return
  // A failed transaction assertion must not leave a modal close guard hanging.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
}
async function query(page: Page, id: string, sql: string) {
  return page.evaluate(async ({ id, sql }) => {
    const api = window.dbCommander, rows: unknown[][] = []
    const finished = new Promise<{ status: string; transaction: string; rows: unknown[][] }>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Query did not finish')) }, 10_000)
      const off = api.onEvent(event => {
        if (!('sessionId' in event) || event.sessionId !== id) return
        if (event.type === 'rows') rows.push(...event.rows)
        if (event.type === 'complete') { clearTimeout(timer); off(); resolve({ status: event.status, transaction: event.transaction, rows }) }
      })
    })
    await api.run({ sessionId: id, sql, maxRows: 10 })
    return finished
  }, { id, sql })
}

test('update checks: startup, daily notification and shared dismissal preserve SQL and open transactions', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-update-desktop-'))
  let app: ElectronApplication | undefined
  try {
    const opened = await launch(directory); app = opened.app
    const page = opened.page, banner = page.getByLabel('Application updates')
    await expect(banner).toContainText('Db Commander 0.2.0 is available.')
    expect(await app.evaluate(() => (globalThis as any).updateFixture.requests)).toEqual([{ url: 'https://api.github.com/repos/ziodex/db-commander/releases/latest', credentials: 'omit', redirect: 'error' }])
    const sql = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs[0].sql
    const id = await page.evaluate(async () => (await window.dbCommander.connect({ engine: 'duckdb', name: 'Update transaction', host: 'local', port: 1, user: 'local', database: 'DuckDB', password: '', tls: 'disable', duckdbMode: 'memory' })).id)
    expect(await query(page, id, 'BEGIN TRANSACTION; CREATE TABLE update_probe AS SELECT 42 AS value;')).toMatchObject({ status: 'completed', transaction: 'transaction' })
    const history = await page.evaluate(() => window.dbCommander.history())
    await banner.getByRole('button', { name: 'Release notes & download' }).click()
    expect(await app.evaluate(() => (globalThis as any).updateFixture.opened)).toEqual(['https://github.com/ziodex/db-commander/releases/tag/v0.2.0'])
    await banner.getByRole('button', { name: 'Dismiss update notification' }).click()
    await expect(banner).not.toBeVisible()
    await manualCheck(app)
    await expect(banner).toContainText('0.2.0 is available')
    await banner.getByRole('button', { name: 'Dismiss update notification' }).click()
    await app.evaluate(() => {
      const fixture = (globalThis as any).updateFixture
      fixture.release.tag_name = 'v0.3.0'; fixture.elapsed += 24 * 60 * 60 * 1000; fixture.daily()
    })
    await expect(banner).toContainText('0.3.0 is available')
    await page.screenshot({ path: info.outputPath('update-banner-dark.png') })
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await settings.getByLabel('Appearance', { exact: true }).selectOption('light')
    await settings.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.setViewportSize({ width: 1024, height: 700 })
    await expect(banner.getByRole('button', { name: 'Dismiss update notification' })).toBeInViewport()
    await page.screenshot({ path: info.outputPath('update-banner-light-1024.png') })
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs[0].sql).toBe(sql)
    expect(await query(page, id, 'SELECT value FROM update_probe;')).toMatchObject({ status: 'completed', transaction: 'transaction', rows: [['42']] })
    await query(page, id, 'ROLLBACK;'); await page.evaluate(id => window.dbCommander.disconnect(id), id)
    await page.evaluate(() => window.dbCommander.createWorkspaceWindow('Update review'))
    await expect.poll(() => app!.windows().length).toBe(2)
    const second = app.windows().find(candidate => candidate !== page)!
    await expect(second.getByLabel('Application updates')).toContainText('0.3.0 is available')
    expect(await app.evaluate(() => (globalThis as any).updateFixture.requests.length)).toBe(3)
    await second.getByRole('button', { name: 'Dismiss update notification' }).click()
    await expect(banner).not.toBeVisible()
  } finally { await closeFixture(app); rmSync(directory, { recursive: true, force: true }) }
})

test('update checks: dismissal survives restart and Help can show the dismissed release again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-update-restart-'))
  let app: ElectronApplication | undefined
  try {
    let opened = await launch(directory); app = opened.app
    await expect(opened.page.getByLabel('Application updates')).toBeVisible()
    await opened.page.getByRole('button', { name: 'Dismiss update notification' }).click()
    const preferences = join(opened.profile, 'update-settings.json')
    await expect.poll(() => existsSync(preferences) ? JSON.parse(readFileSync(preferences, 'utf8')).dismissedVersion : undefined).toBe('0.2.0')
    await app.close(); app = undefined
    opened = await launch(directory); app = opened.app
    await expect.poll(() => opened.page.evaluate(() => window.dbCommander.updateStatus())).toMatchObject({ dismissed: true, available: { version: '0.2.0' } })
    await expect(opened.page.getByLabel('Application updates')).not.toBeVisible()
    await manualCheck(app)
    await expect(opened.page.getByLabel('Application updates')).toContainText('0.2.0 is available')
  } finally { await closeFixture(app); rmSync(directory, { recursive: true, force: true }) }
})

test('update checks: missing releases, offline checks and up-to-date feedback stay nonblocking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-update-offline-'))
  let app: ElectronApplication | undefined
  try {
    const opened = await launch(directory, 404); app = opened.app
    const page = opened.page, banner = page.getByLabel('Application updates')
    await expect.poll(() => page.evaluate(() => window.dbCommander.updateStatus())).toMatchObject({ checking: false })
    await expect(banner).not.toBeVisible()
    await manualCheck(app); await expect(banner).toContainText('No public release is available yet')
    await app.evaluate(() => { (globalThis as any).updateFixture.offline = true })
    await manualCheck(app); await expect(banner).toContainText('Could not check for updates')
    await app.evaluate(() => { const fixture = (globalThis as any).updateFixture; fixture.offline = false; fixture.status = 200; fixture.release.tag_name = 'v0.1.0' })
    await manualCheck(app); await expect(banner).toContainText("You're up to date")
    await banner.getByRole('button', { name: 'Dismiss update notification' }).click()
    await expect(banner).not.toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await closeFixture(app); rmSync(directory, { recursive: true, force: true }) }
})
