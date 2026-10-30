import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { waitForWorkspaceReady } from './workspace-ready'
import { openBackup } from './explorer-actions'

async function enter(page: Page, sql: string) {
  await page.bringToFront()
  const editor = page.locator('.monaco-editor').first(), input = editor.locator('textarea.inputarea')
  await expect(input).toBeEditable(); await editor.click(); await expect(input).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await expect.poll(async () => { const workspace = await page.evaluate(() => window.dbCommander.loadWorkspace()); return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql }).toBe(sql)
}
async function run(page: Page, sql: string) { await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled() }

for (const engine of ['sqlite', 'duckdb'] as const) test(`backup workflows ${engine}: file choices, inspection, restore connection and durable folder history`, async ({}, info) => {
  test.setTimeout(120000)
  const root = mkdtempSync(join(tmpdir(), 'backup-workflow-')), backup = join(root, `backup.${engine}`), target = join(root, `restored.${engine}`), profile = join(root, 'profile')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow()
  try {
    await waitForWorkspaceReady(page); await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Open mode').selectOption('memory'); await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    await run(page, "CREATE TABLE backup_data(id BIGINT, label VARCHAR); INSERT INTO backup_data VALUES(9223372036854775807,'001');")
    await enter(page, 'DELETE FROM backup_data') // Opening the restore must never replay this buffer.
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, backup)
    await openBackup(page)
    const dialog = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await dialog.getByRole('button', { name: 'Choose backup destination', exact: true }).click(); await expect(dialog.getByLabel('Backup file', { exact: true })).toHaveValue(backup)
    await dialog.getByRole('button', { name: 'Review job', exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'Backup checks' })).toContainText('New backup destination: Passed')
    expect(await page.evaluate(() => window.dbCommander.backupJobs())).toHaveLength(0)
    await expect(dialog.getByRole('button', { name: 'Start backup', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('backup-review.png') })
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Start backup', exact: true }).click(); await expect(dialog.locator('.backup-status')).toHaveText('completed')
    await app.evaluate(({ shell }) => { (globalThis as any).backupRevealed = []; shell.showItemInFolder = file => { (globalThis as any).backupRevealed.push(file) } })
    await dialog.getByRole('button', { name: 'Show backup file', exact: true }).click(); expect(await app.evaluate(() => (globalThis as any).backupRevealed)).toEqual([backup])
    await dialog.getByRole('button', { name: 'Configure another job', exact: true }).click(); await dialog.getByLabel('Operation').selectOption('restore')
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, backup)
    await dialog.getByRole('button', { name: 'Browse backup files', exact: true }).click()
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, target)
    await dialog.getByRole('button', { name: 'Choose restore destination', exact: true }).click(); await expect(dialog.getByLabel('New database file')).toHaveValue(target); await dialog.getByRole('button', { name: 'Review job', exact: true }).click()
    await expect(dialog).toContainText('File size'); await expect(dialog).toContainText('New restore destination: Passed')
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Start restore', exact: true }).click(); await expect(dialog.locator('.backup-status')).toHaveText('completed')
    await dialog.getByRole('button', { name: 'Show restored file', exact: true }).click(); expect(await app.evaluate(() => (globalThis as any).backupRevealed)).toEqual([backup, target])
    await dialog.getByLabel('Job status').selectOption('failed'); await expect(dialog).toContainText('No jobs match these filters.'); await dialog.getByLabel('Job status').selectOption('all')
    await page.screenshot({ path: info.outputPath('restore-completed.png') })
    await dialog.getByRole('button', { name: 'Connect to restored database', exact: true }).click(); await expect(dialog).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Restored database.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled() // New editor is empty.
    await run(page, 'SELECT * FROM backup_data'); await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '001', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click(); await expect(page.locator('.monaco-editor').first()).toContainText('DELETE FROM backup_data')
    await run(page, 'SELECT COUNT(*) AS source_count FROM backup_data'); await expect(page.locator('[data-result-column="0"][data-result-row="0"]')).toHaveText('1')
    const settings = JSON.parse(readFileSync(join(profile, 'desktop-settings.json'), 'utf8'))
    expect(settings.backupLocations).toEqual(expect.arrayContaining(['backup', 'restore', 'target'].map(purpose => ({ engine, purpose, directory: root }))))
    expect(JSON.stringify(settings)).not.toContain('backup_data'); expect(JSON.stringify(settings)).not.toContain(backup)
    await openBackup(page)
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = (async (_window, options) => { (globalThis as any).backupChoice = options; return { canceled: true, filePath: '' } }) as typeof dialog.showSaveDialog })
    await dialog.getByRole('button', { name: 'Choose backup destination', exact: true }).click()
    expect((await app.evaluate(() => (globalThis as any).backupChoice)).defaultPath).toContain(root)
    await expect(dialog.getByLabel('Backup file', { exact: true })).toHaveValue('') // Cancelling a picker changes no input.
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})

for (const [theme, zoom] of [['dark', 1.25], ['light', 2]] as const) test(`backup workflows layout ${theme}: invalid-source recovery and review actions at ${zoom * 100}% zoom`, async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'backup-workflow-layout-')), invalid = join(root, 'invalid.sqlite'), snapshot = join(root, 'backup.sqlite')
  writeFileSync(invalid, 'Not a database')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(root, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow()
  try {
    await waitForWorkspaceReady(page); await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog'); await connection.getByLabel('Database engine').selectOption('sqlite'); await connection.getByLabel('Open mode').selectOption('memory'); await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).toBeHidden()
    await page.getByRole('button', { name: 'Workspace', exact: true }).click(); await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog'); await preferences.getByLabel('Appearance', { exact: true }).selectOption(theme); await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click(); await expect(preferences).toBeHidden()
    await app.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1024, 700); window.webContents.setZoomFactor(zoom) }, zoom)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1024 / zoom))
    await openBackup(page); const dialog = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await dialog.getByLabel('Operation').selectOption('restore'); await dialog.getByLabel('Backup file', { exact: true }).fill(invalid); await dialog.getByLabel('New database file').fill(join(root, 'new.sqlite'))
    await dialog.getByRole('button', { name: 'Review job', exact: true }).focus(); await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name: 'Resolve these checks before continuing', exact: true })).toBeFocused()
    await expect(dialog.getByRole('region', { name: 'Backup checks' })).toContainText('Choose a SQLite database snapshot')
    await expect(dialog.getByRole('region', { name: 'Backup checks' })).not.toContainText('The file header matches')
    await expect(dialog.getByRole('button', { name: 'Start restore', exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('backup-check-error.png') })
    await dialog.getByLabel('Operation').selectOption('backup'); await dialog.getByLabel('Backup file', { exact: true }).fill(snapshot)
    await dialog.getByRole('button', { name: 'Review job', exact: true }).click(); await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Start backup', exact: true }).click({ trial: true }); await dialog.getByRole('button', { name: 'Back', exact: true }).click({ trial: true })
    const width = await dialog.evaluate(element => ({ visible: element.clientWidth, content: element.scrollWidth }))
    expect(width.content).toBeLessThanOrEqual(width.visible + 1)
    await page.screenshot({ path: info.outputPath('backup-layout-review.png') })
    expect(await page.evaluate(() => window.dbCommander.backupJobs())).toHaveLength(0)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
