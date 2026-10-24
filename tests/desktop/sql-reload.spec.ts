import { fileMenu } from './file-menu'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { WorkspaceStore } from '../../src/storage/store'
import { SqlFiles } from '../../src/files/sql-files'
import { DEFAULT_PROFILE, type Workspace } from '../../src/shared/contracts'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const stored = (page: Page) => page.evaluate(() => window.dbCommander.loadWorkspace())
for (const failure of ['capacity', 'workspace', 'association'] as const) test(`SQL reload recovery ${failure}: rejected or incomplete reload preserves the file baseline and allows explicit retry`, async ({}, info) => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-reload-')), path = join(directory, 'query.sql'), registry = join(directory, 'sql-files.json'), id = randomUUID()
  const baseline = 'SELECT original_buffer;', external = failure === 'capacity' ? '-- external\n' + 'x'.repeat(200_000) : 'SELECT reviewed_external;'
  const tabs = [{ id, title: 'query.sql', sql: baseline, profile: DEFAULT_PROFILE }]
  if (failure === 'capacity') for (let index = 0; index < 5; index++) tabs.push({ id: randomUUID(), title: `Large ${index}.sql`, sql: '-- retained\n' + 'x'.repeat(979_988), profile: DEFAULT_PROFILE })
  const workspace: Workspace = { version: 2, activeTabId: id, tabs, profiles: [] }, store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  try { store.save(workspace) } finally { store.close() }
  writeFileSync(path, baseline)
  const files = new SqlFiles(registry); await files.load(); await files.open(id, path)
  let app: ElectronApplication | undefined
  async function launch() {
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__reloadPrompts = []
      dialog.showMessageBox = async (windowOrOptions: any, options?: any) => {
        const chosen = options ?? windowOrOptions
        ;(globalThis as any).__reloadPrompts.push(chosen.title)
        return { response: chosen.title === 'Reload SQL file' ? 1 : 0, checkboxChecked: false }
      }
    })
    return page
  }
  const close = async () => { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); app = undefined }
  async function reload(page: Page) { await fileMenu(app!, page, 'Reload from disk'); await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled() }
  try {
    let page = await launch()
    const originalRegistry = readFileSync(registry), before = await stored(page)
    writeFileSync(path, external)
    if (failure === 'workspace') {
      // This case exercises explicit retry. Keep the queued 250 ms autosave
      // from winning the race and removing the button after the trigger repair.
      await page.evaluate(() => {
        const timeout = window.setTimeout.bind(window)
        ;(window as any).__restoreReloadTimers = () => { window.setTimeout = timeout }
        window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => timeout(handler, delay === 250 ? 60_000 : delay, ...args)) as typeof window.setTimeout
      })
      const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
      try { db.exec("CREATE TRIGGER reject_reload_workspace BEFORE INSERT ON workspace BEGIN SELECT RAISE(FAIL,'Fixture reload workspace failure'); END") } finally { db.close() }
    } else if (failure === 'association') { renameSync(registry, registry + '.original'); mkdirSync(registry) }
    await reload(page)
    await expect(page.locator('.error-banner')).toContainText(failure === 'capacity' ? 'remaining workspace capacity' : failure === 'workspace' ? 'Fixture reload workspace failure' : 'file association')
    const current = await stored(page)
    if (failure === 'capacity' || failure === 'workspace') {
      expect(readFileSync(registry)).toEqual(originalRegistry)
      expect(digest(JSON.stringify(current))).toBe(digest(JSON.stringify(before)))
    }
    await page.screenshot({ path: info.outputPath(`${failure}-reload-failed.png`) })
    if (failure === 'capacity') {
      await fileMenu(app!, page, 'Save')
      await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
      expect(await app!.evaluate(() => (globalThis as any).__reloadPrompts)).toContain('SQL file changed')
      expect(digest(readFileSync(path))).toBe(digest(external))
      // A smaller reviewed reload fits without deleting the other saved buffers.
      writeFileSync(path, 'SELECT smaller_reviewed_file;')
    } else {
      await expect(page.locator('.monaco-editor')).toContainText('reviewed_external')
      if (failure === 'workspace') {
        const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
        try { db.exec('DROP TRIGGER reject_reload_workspace') } finally { db.close() }
        await page.getByRole('button', { name: 'Retry workspace save', exact: true }).click()
        await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
        await page.evaluate(() => (window as any).__restoreReloadTimers())
      } else {
        expect(current?.tabs[0].sql).toBe(external)
        expect((await page.evaluate(() => window.dbCommander.checkSqlFiles())).files[0].savedHash).toBe(files.document(id)!.savedHash)
        rmSync(registry, { recursive: true }); renameSync(registry + '.original', registry)
      }
    }
    await reload(page)
    await expect(page.locator('.sql-file-bar')).toContainText('Saved to file')
    const expected = failure === 'capacity' ? 'SELECT smaller_reviewed_file;' : external
    expect((await stored(page))?.tabs[0].sql).toBe(expected)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await page.screenshot({ path: info.outputPath(`${failure}-reload-recovered.png`) })
    await close(); page = await launch()
    expect((await stored(page))?.tabs[0].sql).toBe(expected)
    await expect(page.locator('.sql-file-bar')).toContainText('Saved to file')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    writeFileSync(info.outputPath(`${failure}-reload.json`), JSON.stringify({ failure, priorBaselinePreserved: true, explicitRetry: true, restoredSqlHash: digest(expected), noSqlReplay: true }, null, 2))
  } finally { await close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
