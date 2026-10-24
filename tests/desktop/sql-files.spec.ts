import { waitForWorkspaceReady } from './workspace-ready'
import { fileMenu } from './file-menu'
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface Harness {
  directory: string; app: ElectronApplication; page: Page
  open(path: string): Promise<void>; destination(path?: string): Promise<void>
  answer(response: number): Promise<void>; restart(response: number, beforeLaunch?: () => void): Promise<void>
}
const test = base.extend<{ files: Harness }>({ files: async ({}, use) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-files-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow()
    await waitForWorkspaceReady(page)
    await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).filePrompts = []
      ;(globalThis as any).fileAnswer = 0
      dialog.showMessageBox = (async (_window: unknown, options: any) => {
        ;(globalThis as any).filePrompts.push(options)
        return { response: (globalThis as any).fileAnswer, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    return page
  }
  const h: Harness = {
    directory, app: undefined!, page: undefined!,
    async open(path) {
      await h.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
      await h.page.getByRole('button', { name: 'Open SQL file', exact: true }).click()
      await expect(h.page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    },
    async destination(path) {
      await h.app.evaluate(({ dialog }, path) => {
        ;(globalThis as any).saveDialogCalls = 0
        dialog.showSaveDialog = async () => { (globalThis as any).saveDialogCalls++; return { canceled: !path, filePath: path ?? '' } }
      }, path)
    },
    async answer(response) { await h.app.evaluate((_, value) => { (globalThis as any).fileAnswer = value }, response) },
    async restart(response, beforeLaunch) { await h.answer(response); await h.app.close(); beforeLaunch?.(); h.page = await launch(); h.app = app! }
  }
  try { h.page = await launch(); h.app = app!; await use(h) }
  finally { await app!?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app!?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
} })
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function menu(app: ElectronApplication, page: Page, name: string) { await fileMenu(app, page, name) }
async function shortcut(app: ElectronApplication, keyCode: string, shift = false) {
  // Disk writes precede workspace persistence/refresh. Wait until the UI accepts
  // another file command, including when a prior save already changed the file.
  await expect((await app.firstWindow()).getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
  await app.evaluate(({ BrowserWindow }, { keyCode, shift, mac }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.focus()
    const modifiers: Electron.KeyboardInputEvent['modifiers'] = [mac ? 'meta' : 'control', ...(shift ? ['shift' as const] : [])]
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, { keyCode, shift, mac: process.platform === 'darwin' })
}

test('SQL files open in associated tabs, focus duplicates, Save and Save As via native shortcuts', async ({ files: h }, testInfo) => {
  const file = join(h.directory, 'opened.sql'), copy = join(h.directory, 'copy.sql')
  writeFileSync(file, 'SELECT 10;\n'); await enter(h.page, 'SELECT original_scratch;')
  await h.open(file)
  await expect(h.page.getByRole('tab', { name: 'opened.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Saved to file')
  await expect(h.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  await enter(h.page, 'SELECT edited_buffer;')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Unsaved changes')
  await h.open(file); await expect(h.page.getByRole('tab')).toHaveCount(2)
  await expect(h.page.locator('.monaco-editor')).toContainText('edited_buffer')
  await h.destination(copy); await shortcut(h.app, 's')
  await expect.poll(() => readFileSync(file, 'utf8')).toBe('SELECT edited_buffer;')
  expect(await h.app.evaluate(() => (globalThis as any).saveDialogCalls)).toBe(0)
  await expect(h.page.locator('.sql-file-bar')).toContainText('Saved to file')
  await enter(h.page, 'SELECT saved_copy;'); await shortcut(h.app, 's', true)
  await expect(h.page.getByRole('tab', { name: 'copy.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(readFileSync(copy, 'utf8')).toBe('SELECT saved_copy;'); expect(readFileSync(file, 'utf8')).toBe('SELECT edited_buffer;')
  expect(await h.app.evaluate(() => (globalThis as any).saveDialogCalls)).toBe(1)
  expect((await h.page.evaluate(() => window.dbCommander.checkSqlFiles())).files.every(file => file.external === 'unchanged')).toBe(true)
  await enter(h.page, 'SELECT saved_again;'); await shortcut(h.app, 's')
  await expect.poll(() => readFileSync(copy, 'utf8')).toBe('SELECT saved_again;')
  expect(await h.app.evaluate(() => (globalThis as any).filePrompts)).toEqual([])
  // File bytes can be published before the save releases the workspace lock.
  // Wait until tab actions are accepted before selecting the scratch buffer.
  await expect(h.page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
  await h.page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
  await expect(h.page.getByRole('tab', { name: 'Untitled.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(h.page.locator('.monaco-editor')).toContainText('original_scratch')
  await shortcut(h.app, 'o'); await expect(h.page.getByRole('tab', { name: 'opened.sql', exact: true })).toBeVisible()
  await menu(h.app, h.page, 'Recent SQL files…'); await expect(h.page.getByRole('dialog', { name: 'Recent SQL files' })).toContainText('copy.sql')
  await h.page.screenshot({ path: testInfo.outputPath('recent-sql-files.png') })
  await h.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
})

test('SQL files protect unsaved buffers when closing tabs and cancelling Save As', async ({ files: h }) => {
  const file = join(h.directory, 'kept.sql')
  await enter(h.page, 'SELECT keep_me;')
  await h.page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: 'Close query tab' })
  await dialog.getByRole('button', { name: 'Keep tab', exact: true }).click()
  await expect(h.page.locator('.monaco-editor')).toContainText('keep_me')
  await h.destination(); await h.page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save and close', exact: true }).click()
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Save and close' })).toBeEnabled()
  await h.destination(join(h.directory, 'nonexistent-parent', 'failed.sql')); await dialog.getByRole('button', { name: 'Save and close', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('ENOENT')
  await expect(h.page.getByRole('tab', { name: 'Untitled.sql', exact: true })).toBeVisible()
  await h.destination(file); await dialog.getByRole('button', { name: 'Save and close', exact: true }).click()
  await expect(dialog).not.toBeVisible(); expect(readFileSync(file, 'utf8')).toBe('SELECT keep_me;')
  await h.open(file); await enter(h.page, 'SELECT discard_me;')
  await h.page.getByRole('button', { name: 'Close kept.sql', exact: true }).click()
  await dialog.getByRole('button', { name: 'Close tab', exact: true }).click()
  await expect(h.page.getByRole('tab', { name: 'kept.sql', exact: true })).not.toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe('SELECT keep_me;')
  // Closing removes the tab before asynchronous persistence and file cleanup.
  await expect.poll(() => h.page.evaluate(async () => (await window.dbCommander.checkSqlFiles()).files)).toHaveLength(0)
})

test('SQL files retain their association and dirty buffer when registry publication fails', async ({ files: h }) => {
  const original = join(h.directory, 'original.sql'), target = join(h.directory, 'retained.sql')
  const registry = join(h.directory, 'sql-files.json'), backup = registry + '.original'
  writeFileSync(original, 'SELECT original_file;')
  await h.open(original); await enter(h.page, 'SELECT retained_buffer;')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Unsaved changes')
  const before = await h.page.evaluate(() => window.dbCommander.checkSqlFiles())
  renameSync(registry, backup); mkdirSync(registry)
  try {
    await h.destination(target); await shortcut(h.app, 's', true)
    await expect(h.page.locator('.error-banner')).toBeVisible()
    await expect(h.page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    expect(readFileSync(target, 'utf8')).toBe('SELECT retained_buffer;')
    expect(readFileSync(original, 'utf8')).toBe('SELECT original_file;')
    expect(await h.page.evaluate(() => window.dbCommander.checkSqlFiles())).toEqual(before)
    await expect(h.page.locator('.error-banner')).toContainText('file was written')
    await expect(h.page.locator('.sql-file-bar')).toContainText('Unsaved changes')
    await expect(h.page.getByRole('tab', { name: 'original.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(h.page.locator('.monaco-editor .view-lines')).toContainText('retained_buffer')
  } finally {
    rmSync(registry, { recursive: true, force: true }); renameSync(backup, registry)
  }
  // A partial save left the destination on disk. Retry must still review it.
  await h.answer(2); await h.destination(target); await shortcut(h.app, 's', true)
  await expect(h.page.getByRole('tab', { name: 'retained.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Saved to file')
  expect((await h.app.evaluate(() => (globalThis as any).filePrompts)).some((prompt: any) => prompt.title === 'SQL file changed')).toBe(true)
  await h.restart(1)
  await expect(h.page.getByRole('tab', { name: 'retained.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(h.page.locator('.monaco-editor .view-lines')).toContainText('retained_buffer')
  // Match fs/promises.realpath in the application, including Windows 8.3 aliases.
  expect((await h.page.evaluate(() => window.dbCommander.checkSqlFiles())).files[0].path).toBe(realpathSync.native(target))
  expect(readFileSync(original, 'utf8')).toBe('SELECT original_file;')
})

test('SQL files preserve a newer registry while recovered buffers remain usable', async ({ files: h }) => {
  const registry = join(h.directory, 'sql-files.json'), target = join(h.directory, 'must-not-exist.sql')
  const future = JSON.stringify({ version: 2, documents: [], recent: [], futureMetadata: 'must remain intact' })
  await enter(h.page, 'SELECT newer_registry_recovery;')
  await h.restart(1, () => writeFileSync(registry, future))
  expect(readFileSync(registry, 'utf8')).toBe(future)
  await expect(h.page.locator('.monaco-editor .view-lines')).toContainText('newer_registry_recovery')
  await h.destination(target); await shortcut(h.app, 's', true)
  await expect(h.page.locator('.error-banner')).toContainText('newer Db Commander version')
  expect(() => readFileSync(target)).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(future)
  await h.page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = h.page.getByRole('dialog')
  await form.getByLabel('Database engine').selectOption('sqlite')
  await form.getByLabel('Open mode').selectOption('memory')
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(form).not.toBeVisible()
  const run = h.page.getByRole('button', { name: /^Run SQL/ })
  await expect(run).toBeEnabled(); await enter(h.page, 'SELECT 44 AS registry_preserved;'); await run.click()
  await expect(h.page.getByRole('cell', { name: '44', exact: true })).toBeVisible()
  expect(readFileSync(registry, 'utf8')).toBe(future)
})

test('SQL files detect external edits, revalidate replacement, confirm reload and recover missing files', async ({ files: h }, testInfo) => {
  const file = join(h.directory, 'external.sql'), copy = join(h.directory, 'recovered.sql')
  writeFileSync(file, 'SELECT disk_initial;'); await h.open(file); await enter(h.page, 'SELECT local_edits;')
  writeFileSync(file, 'SELECT external_edits;')
  await expect(h.page.locator('.sql-file-notice')).toContainText('File changed on disk.', { timeout: 10000 })
  await h.answer(0); await fileMenu(h.app, h.page, 'Save')
  await expect(h.page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
  expect(readFileSync(file, 'utf8')).toBe('SELECT external_edits;')
  await expect(h.page.locator('.monaco-editor')).toContainText('local_edits')
  await h.app.evaluate(({ dialog }) => {
    ;(globalThis as any).replacementReview = false
    dialog.showMessageBox = (() => new Promise(resolve => {
      ;(globalThis as any).replacementReview = true
      ;(globalThis as any).finishReplacementReview = () => resolve({ response: 2, checkboxChecked: false })
    })) as typeof dialog.showMessageBox
  })
  await fileMenu(h.app, h.page, 'Save')
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).replacementReview)).toBe(true)
  writeFileSync(file, 'SELECT changed_during_review;')
  await h.app.evaluate(() => (globalThis as any).finishReplacementReview())
  await expect(h.page.locator('.error-banner')).toContainText('changed again')
  expect(readFileSync(file, 'utf8')).toBe('SELECT changed_during_review;')
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: (globalThis as any).fileAnswer, checkboxChecked: false })) as typeof dialog.showMessageBox })
  await h.answer(0); await h.page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await expect(h.page.getByRole('button', { name: 'Reload from disk', exact: true })).toBeEnabled()
  await expect(h.page.locator('.monaco-editor')).toContainText('local_edits')
  await h.page.screenshot({ path: testInfo.outputPath('external-change.png') })
  await h.answer(1); await h.page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await expect(h.page.locator('.monaco-editor')).toContainText('changed_during_review')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Saved to file')
  unlinkSync(file)
  await expect(h.page.locator('.sql-file-notice')).toContainText('File removed from disk.', { timeout: 10000 })
  await fileMenu(h.app, h.page, 'Save')
  await expect(h.page.locator('.error-banner')).toContainText('removed. Use Save As')
  await h.destination(copy); await h.page.getByRole('button', { name: 'Save As…', exact: true }).click()
  await expect(h.page.getByRole('tab', { name: 'recovered.sql', exact: true })).toBeVisible()
  expect(readFileSync(copy, 'utf8')).toBe('SELECT changed_during_review;')
})

test('SQL files retain dirty buffers and recent files across quit, and save all before exit', async ({ files: h }) => {
  const file = join(h.directory, 'recovery.sql'); writeFileSync(file, 'SELECT on_disk;')
  await h.open(file); await enter(h.page, 'SELECT recovered_buffer;')
  const second = join(h.directory, 'second.sql'); writeFileSync(second, 'SELECT second_original;')
  await h.open(second); await enter(h.page, 'SELECT second_recovered;')
  await h.page.getByRole('tab', { name: 'recovery.sql', exact: true }).click()
  await h.answer(0); await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).filePrompts.map((item: any) => item.title))).toContain('Unsaved SQL files')
  await expect(h.page.locator('.monaco-editor')).toContainText('recovered_buffer')
  await h.restart(1)
  await expect(h.page.locator('.monaco-editor')).toContainText('recovered_buffer')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Unsaved changes')
  expect(readFileSync(file, 'utf8')).toBe('SELECT on_disk;'); expect(readFileSync(second, 'utf8')).toBe('SELECT second_original;')
  await expect(h.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  expect(await h.page.evaluate(() => window.dbCommander.history())).toHaveLength(0)
  await h.restart(2)
  expect(readFileSync(file, 'utf8')).toBe('SELECT recovered_buffer;'); expect(readFileSync(second, 'utf8')).toBe('SELECT second_recovered;')
  await expect(h.page.locator('.sql-file-bar')).toContainText('Saved to file')
  await menu(h.app, h.page, 'Recent SQL files…')
  const dialog = h.page.getByRole('dialog', { name: 'Recent SQL files' })
  await expect(dialog).toContainText('recovery.sql'); await dialog.getByRole('button', { name: 'Clear recent files' }).click()
  await expect(dialog).toContainText('No recent SQL files.'); expect(readFileSync(file, 'utf8')).toBe('SELECT recovered_buffer;')
})

test('SQL files reject invalid files, handle cancelled open and report missing recent files', async ({ files: h }) => {
  const invalid = join(h.directory, 'invalid.sql'); writeFileSync(invalid, Buffer.from([0xff, 0x00]))
  await enter(h.page, 'SELECT untouched;'); await h.open(invalid)
  await expect(h.page.locator('.error-banner')).toContainText('UTF-8')
  await expect(h.page.getByRole('tab')).toHaveCount(1); await expect(h.page.locator('.monaco-editor')).toContainText('untouched')
  await h.app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await h.page.getByRole('button', { name: 'Open SQL file', exact: true }).click()
  await expect(h.page.getByRole('tab')).toHaveCount(1)
  const file = join(h.directory, 'missing.sql'); writeFileSync(file, 'SELECT missing;'); await h.open(file)
  await h.page.getByRole('button', { name: 'Close missing.sql', exact: true }).click()
  await h.page.getByRole('dialog').getByRole('button', { name: 'Close tab', exact: true }).click()
  await expect(h.page.getByRole('dialog')).toBeHidden()
  await expect(h.page.getByRole('tab', { name: 'missing.sql', exact: true })).toHaveCount(0)
  unlinkSync(file); await menu(h.app, h.page, 'Recent SQL files…')
  const dialog = h.page.getByRole('dialog', { name: 'Recent SQL files' })
  await dialog.getByRole('button', { name: /missing.sql/ }).click()
  await expect(dialog.getByRole('alert')).toContainText('ENOENT')
  await expect(h.page.getByRole('tab')).toHaveCount(1)
})

test('SQL files leave database sessions, transactions and query results unchanged', async ({ files: h }) => {
  const file = join(h.directory, 'transaction.sql'), other = join(h.directory, 'unexecuted.sql')
  await h.page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = h.page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb')
  await form.getByLabel('Open mode').selectOption('memory'); await form.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(form).not.toBeVisible(); await expect(h.page.getByRole('button', { name: 'Begin', exact: true })).toBeEnabled()
  await h.page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(h.page.locator('.transaction-badge')).toHaveText('In transaction')
  await enter(h.page, 'SELECT 42 AS retained_result;'); await h.page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(h.page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  await h.destination(file); await fileMenu(h.app, h.page, 'Save')
  await expect(h.page.getByRole('tab', { name: 'transaction.sql', exact: true })).toBeVisible()
  await h.page.getByRole('button', { name: 'Close transaction.sql', exact: true }).click()
  await expect(h.page.locator('.error-banner')).toContainText('Commit or roll back'); await expect(h.page.getByRole('dialog')).not.toBeVisible()
  writeFileSync(other, 'CREATE TABLE must_not_execute(id INT);'); await h.open(other)
  await expect(h.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  await h.page.getByRole('tab', { name: 'transaction.sql', exact: true }).click()
  await expect(h.page.locator('.transaction-badge')).toHaveText('In transaction')
  await expect(h.page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  await h.page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(h.page.locator('.transaction-badge')).toHaveText('Autocommit')
})
