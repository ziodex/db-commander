import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, type Workspace } from '../../src/shared/contracts'
import { withClipboard } from './clipboard-fixture'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
function fixture(active = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-capacity-'))
  const tabs = Array.from({ length: 20 }, (_, index) => {
    const head = `-- capacity ${index + 1}\n`
    return { id: randomUUID(), title: `Capacity ${index + 1}.sql`, sql: index < 5 ? (head + '-- row\n'.repeat(150000)).slice(0, 1_000_000) : '', profile: DEFAULT_PROFILE }
  })
  const value: Workspace = { version: 2, activeTabId: tabs[active].id, tabs, profiles: [] }
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  try { store.save(value) } finally { store.close() }
  return { directory, value }
}
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string>, timeout: 15000 })
  try {
    const page = await app.firstWindow({ timeout: 15000 })
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    return { app, page }
  } catch (error) { await close(app); throw error }
}
async function close(app?: ElectronApplication) {
  if (!app) return
  const exit = app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) }
  finally { clearTimeout(timer) }
  if (app.process().exitCode === null) app.process().kill('SIGKILL')
  await app.close().catch(() => {})
}
function signature(value: Workspace | null) {
  return value && { tabs: value.tabs.length, characters: value.tabs.reduce((sum, tab) => sum + tab.sql.length, 0),
    digest: createHash('sha256').update(JSON.stringify(value.tabs.map(({ id, title, sql }) => ({ id, title, sql })))).digest('hex') }
}
const stored = (page: Page) => page.evaluate(() => window.dbCommander.loadWorkspace())

test('workspace capacity recovers twenty tabs and five million characters with four editor views', async ({}, info) => {
  test.setTimeout(180000)
  const { directory, value } = fixture(), timings: number[] = []
  let app: ElectronApplication | undefined
  try {
    let opened = await launch(directory); app = opened.app
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    for (const tab of value.tabs) {
      const start = performance.now(), button = opened.page.getByRole('tab', { name: tab.title, exact: true })
      await button.click(); await expect(button).toHaveAttribute('aria-selected', 'true')
      timings.push(performance.now() - start)
    }
    for (let index = 0; index < 3; index++) {
      await opened.page.getByRole('button', { name: 'Editor views', exact: true }).click()
      await opened.page.getByRole('menuitem', { name: 'Split editor side by side', exact: true }).click()
    }
    await expect(opened.page.locator('.monaco-editor')).toHaveCount(4)
    for (let index = 0; index < 4; index++) await opened.page.keyboard.press('F6')
    await expect(opened.page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    expect(Math.max(...timings)).toBeLessThan(5000)
    await close(app); app = undefined
    opened = await launch(directory); app = opened.app
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    await expect(opened.page.locator('.monaco-editor')).toHaveCount(4)
    expect(await opened.page.evaluate(() => window.dbCommander.history())).toEqual([])
    const report = info.outputPath('workspace-capacity.json')
    writeFileSync(report, JSON.stringify({ ...signature(value), views: 4, switchMs: timings, noSQLReplay: true }, null, 2))
    await info.attach('workspace-capacity.json', { path: report, contentType: 'application/json' })
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

for (const limit of ['query', 'workspace'] as const) test(`workspace capacity ${limit} overflow preserves committed SQL and recovers with undo`, async () => {
  test.setTimeout(90000)
  const active = limit === 'query' ? 0 : 19, { directory, value } = fixture(active)
  let app: ElectronApplication | undefined
  try {
    let opened = await launch(directory); app = opened.app
    await opened.page.getByRole('textbox', { name: 'SQL editor', exact: true }).focus()
    await opened.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await opened.page.keyboard.press('x'); await opened.page.keyboard.press('Escape')
    await expect(opened.page.getByText('Workspace not saved', { exact: true })).toBeVisible()
    await expect(opened.page.locator('.error-banner')).toContainText(limit === 'query' ? '1,000,000' : '5,000,000')
    await expect(opened.page.locator('.error-banner')).toContainText('Undo')
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    await withClipboard(app, async () => {
      await opened.page.keyboard.press(`${modifier}+A`); await opened.page.keyboard.press(`${modifier}+C`)
      // Windows publishes native clipboard text with CRLF line endings. Keep
      // the entire copied buffer comparison exact in that native format.
      const sql = value.tabs[active].sql + 'x', copied = process.platform === 'win32' ? sql.replace(/\n/g, '\r\n') : sql
      expect(await app!.evaluate(async ({ clipboard }, sql) => await clipboard.readText() === sql, copied)).toBe(true)
    })
    await opened.page.keyboard.press(`${modifier}+Z`)
    await expect(opened.page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    await close(app); app = undefined
    opened = await launch(directory); app = opened.app
    expect(signature(await stored(opened.page))).toEqual(signature(value))
    expect(await opened.page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})
