import { _electron as electron, test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/shared/editor-settings'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor')).toBeVisible()
    return { app, page }
  } catch (error) { await forceClose(app); throw error }
}
async function forceClose(app?: ElectronApplication) {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {})
}
async function openSettings(page: Page, palette = false) {
  if (palette) {
    await page.getByRole('button', { name: 'Commands', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search commands' }).fill('preferences')
    await page.getByRole('button', { name: 'Editor settings', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Editor settings', exact: true }).click()
  }
  const form = page.getByRole('dialog', { name: 'Editor settings', exact: true })
  await expect(form).toBeVisible(); return form
}
async function settingsTransfer(form: Locator, name: string) {
  const details = form.locator('.editor-settings-transfer')
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) await details.locator('summary').click()
  await form.getByRole('button', { name, exact: true }).click()
}
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); if (sql) await page.keyboard.insertText(sql); else await page.keyboard.press('Backspace'); await page.keyboard.press('Escape')
}
async function workspace(page: Page) { return page.evaluate(() => window.dbCommander.loadWorkspace()) }
async function text(page: Page) { const value = await workspace(page); return value?.tabs.find(tab => tab.id === value.activeTabId)?.sql }
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled(); if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
}

test('editor settings cancel, validate, format, undo and persist across tabs and restart', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-settings-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    const source = "select 1 as id,'retain  Case' as label;\nselect 2 as other;"
    await enter(page, source); await expect.poll(() => text(page)).toBe(source)
    const original = await workspace(page)
    // Exercise an existing inactive model as well as a new model after Apply.
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'select 22 as second;')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    let form = await openSettings(page, true)
    await form.getByLabel(/Font size/).fill('18'); await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    form = await openSettings(page); await expect(form.getByLabel(/Font size/)).toHaveValue('13')
    await form.getByLabel(/Font size/).fill('99'); await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(form).toBeVisible(); expect((await workspace(page))?.editorSettings).toBeUndefined()
    await form.getByLabel(/Font size/).fill('18'); await form.getByLabel('Line numbers', { exact: true }).selectOption('relative')
    await form.getByLabel('Wrap long lines').uncheck(); await form.getByLabel('Show minimap').check(); await form.getByLabel('Automatic suggestions').uncheck()
    await form.getByLabel('Indent using').selectOption('tabs'); await form.getByLabel(/Indent width/).fill('4')
    await form.getByLabel(/Inline expression width/).fill('20'); await form.getByLabel(/Blank lines between statements/).fill('3')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click(); await expect(form).not.toBeVisible()
    const settings = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, lineNumbers: 'relative' as const, wordWrap: false, minimap: true, automaticSuggestions: false, insertSpaces: false, tabSize: 4, formatting: { expressionWidth: 20, linesBetweenQueries: 3 } }
    await expect.poll(async () => (await workspace(page))?.editorSettings).toEqual(settings)
    expect(await text(page)).toBe(source)
    await expect(page.locator('.monaco-editor .view-lines')).toHaveCSS('font-size', '18px')
    expect((await workspace(page))?.activeTabId).toBe(original?.activeTabId)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(() => text(page)).toContain('\n\t1 as id')
    expect(await text(page)).toContain(';\n\n\n\nselect')
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(() => text(page)).toBe(source)
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click(); await expect.poll(() => text(page)).toContain('\n\t22 as second')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'select 33 as third;')
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click(); await expect.poll(() => text(page)).toContain('\n\t33 as third')
    // Change indentation on existing models and verify a typed Tab follows it.
    form = await openSettings(page); await form.getByLabel('Indent using').selectOption('spaces')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click(); await enter(page, '')
    await page.keyboard.press('Tab'); await page.keyboard.insertText('select 9;')
    await expect.poll(() => text(page)).toBe('    select 9;')
    form = await openSettings(page); await form.getByRole('button', { name: 'Reset defaults', exact: true }).click()
    await page.keyboard.press('Escape'); await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeFocused()
    expect((await workspace(page))?.editorSettings?.fontSize).toBe(18)
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    expect((await workspace(page))?.editorSettings).toEqual({ ...settings, insertSpaces: true })
    expect(await text(page)).toBe('    select 9;')
    await expect(page.locator('.monaco-editor .view-lines')).toHaveCSS('font-size', '18px')
    form = await openSettings(page, true)
    await page.screenshot({ path: testInfo.outputPath('editor-settings.png') })
    await form.getByRole('button', { name: 'Reset defaults', exact: true }).click(); await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorSettings).toEqual(DEFAULT_EDITOR_SETTINGS)
    expect(await text(page)).toBe('    select 9;')
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})

test('editor settings preserve duckdb results, sessions and independent transactions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-settings-state-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb'); await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    const firstSql = "create temp table preferences_session(id integer); begin; insert into preferences_session values(7); select id from preferences_session;"
    await run(page, firstSql); await expect.poll(() => text(page)).toBe(firstSql)
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const first = await workspace(page), firstText = await text(page)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Connected')
    await run(page, 'select 88 as isolated_session;')
    const history = await page.evaluate(() => window.dbCommander.history()), profiles = (await workspace(page))?.profiles
    const form = await openSettings(page)
    const file = join(directory, 'incoming-settings.json')
    writeFileSync(file, JSON.stringify({ format: 'dbcommander-editor-settings', version: 1, settings: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 20, lineNumbers: 'off', insertSpaces: false } }))
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByLabel(/Font size/)).toHaveValue('20')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(page.getByRole('cell', { name: '88', exact: true })).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await expect.poll(async () => (await workspace(page))?.editorSettings?.fontSize).toBe(20)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    expect((await workspace(page))?.profiles).toEqual(profiles)
    await page.getByRole('tab', { name: first!.tabs[0].title, exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    await expect.poll(() => text(page)).toBe(firstText)
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run(page, 'select count(*) as rows_after_rollback from preferences_session;')
    await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.getByRole('cell', { name: '88', exact: true })).toBeVisible()
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})

test('editor settings files export applied preferences and import drafts without changing SQL', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-settings-files-ui-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    const sql = 'select private_buffer_should_not_be_exported;'
    await enter(page, sql); await expect.poll(() => text(page)).toBe(sql)
    const before = await workspace(page)
    let form = await openSettings(page)
    await form.getByLabel(/Font size/).fill('29') // Export applied preferences, not this draft.
    const file = join(directory, 'settings.json'); writeFileSync(file, 'keep existing content')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, file)
    await settingsTransfer(form, 'Export applied settings')
    await expect(form.getByRole('alert')).toContainText('already exists')
    expect(readFileSync(file, 'utf8')).toBe('keep existing content')
    rmSync(file)
    await settingsTransfer(form, 'Export applied settings')
    await expect(form.getByRole('status')).toContainText('exported')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ format: 'dbcommander-editor-settings', version: 1, settings: DEFAULT_EDITOR_SETTINGS })
    expect(readFileSync(file, 'utf8')).not.toContain(sql)
    await expect(form.getByLabel(/Font size/)).toHaveValue('29')
    // A native chooser owns the operation until it finishes; Escape cannot apply or dismiss it.
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = () => new Promise(resolve => { (globalThis as any).finishSettingsPicker = resolve }) })
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByRole('button', { name: 'Apply settings', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(form).toBeVisible()
    await app.evaluate(() => { (globalThis as any).finishSettingsPicker({ canceled: true, filePaths: [] }) })
    await expect(form.getByRole('button', { name: 'Import settings', exact: true })).toBeEnabled()
    await expect(form.getByLabel(/Font size/)).toHaveValue('29')
    const imported = { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, engineFormatting: {
      postgres: { tabSize: 4, insertSpaces: false, formatting: { expressionWidth: 20, linesBetweenQueries: 3 } }
    } }
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    writeFileSync(file, JSON.stringify({ format: 'dbcommander-editor-settings', version: 2, settings: imported }))
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByRole('alert')).toContainText('Invalid editor settings file')
    await expect(form.getByLabel(/Font size/)).toHaveValue('29')
    writeFileSync(file, JSON.stringify({ format: 'dbcommander-editor-settings', version: 1, settings: imported }))
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByRole('status')).toContainText('Custom formatting: PostgreSQL')
    await expect(form.getByLabel(/Font size/)).toHaveValue('18')
    expect(await workspace(page)).toEqual(before)
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    form = await openSettings(page); await expect(form.getByLabel(/Font size/)).toHaveValue('13')
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByLabel(/Font size/)).toHaveValue('18')
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('postgres')
    await expect(form.getByLabel(/Format indent width/)).toHaveValue('4')
    await page.screenshot({ path: testInfo.outputPath('import-editor-settings.png') })
    writeFileSync(file, '{changed after reading') // Apply uses the reviewed snapshot.
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorSettings).toEqual(imported)
    expect((await workspace(page))?.tabs).toEqual(before?.tabs)
    expect((await workspace(page))?.profiles).toEqual(before?.profiles)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    expect((await workspace(page))?.editorSettings).toEqual(imported)
    expect(await text(page)).toBe(sql)
    form = await openSettings(page)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
    writeFileSync(file, JSON.stringify({ format: 'dbcommander-editor-settings', version: 1, settings: DEFAULT_EDITOR_SETTINGS }))
    await settingsTransfer(form, 'Import settings')
    await expect(form.getByRole('status')).toContainText('Custom formatting: none')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorSettings).toEqual(DEFAULT_EDITOR_SETTINGS)
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})

test('editor settings use per-engine styles across tabs, selection formatting and restart', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-engine-formatting-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    const first = 'select 1 as untouched;', second = 'select 2 as formatted;', postgresSql = `${first}\n${second}`
    await enter(page, postgresSql)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb'); await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    await run(page, 'create temp table formatting_state(marker integer); begin; insert into formatting_state values(7); select marker from formatting_state;')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const duckdbSql = 'select marker from formatting_state;\nselect 22 as second;'
    await enter(page, duckdbSql)
    const history = await page.evaluate(() => window.dbCommander.history())
    let form = await openSettings(page)
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('postgres')
    await expect(form.getByLabel(/Format indent width/)).toBeDisabled()
    await expect(form.getByLabel(/Format indent width/)).toHaveValue('2')
    await form.getByLabel('Use custom formatting', { exact: true }).check()
    await form.getByLabel(/Format indent width/).fill('9')
    // Validation must find a bad override even when another scope is displayed.
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('global')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('PostgreSQL')
    await expect(form.getByLabel('Formatting settings for', { exact: true })).toHaveValue('postgres')
    await form.getByLabel(/Format indent width/).fill('4')
    await form.getByLabel(/Blank lines between statements/).fill('0')
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('duckdb')
    await form.getByLabel('Use custom formatting', { exact: true }).check()
    await form.getByLabel('Format indentation', { exact: true }).selectOption('tabs')
    await form.getByLabel(/Format indent width/).fill('8')
    await form.getByLabel(/Inline expression width/).fill('20')
    await form.getByLabel(/Blank lines between statements/).fill('3')
    await page.screenshot({ path: testInfo.outputPath('engine-formatting.png') })
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorSettings?.engineFormatting?.duckdb?.tabSize).toBe(8)
    expect(await text(page)).toBe(duckdbSql)
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(() => text(page)).toContain('\n\tmarker')
    expect(await text(page)).toContain(';\n\n\n\nselect')
    await expect(page.getByRole('cell', { name: '7', exact: true })).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(() => text(page)).toBe(duckdbSql)
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await enter(page, postgresSql)
    for (let i = 0; i < second.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+Alt+F')
    await expect.poll(() => text(page)).toBe(`${first}\nselect\n    2 as formatted;`)
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(() => text(page)).toBe(postgresSql)
    // Native context-menu formatting uses the same engine style as the toolbar.
    await page.keyboard.press('ArrowLeft')
    await page.locator('.monaco-editor .view-lines').click({ button: 'right' })
    const formatMenu = page.getByRole('menuitem', { name: /Format Document/ })
    await formatMenu.hover(); await page.waitForTimeout(120) // Monaco ignores mouse activation during its first 100 ms.
    await formatMenu.click()
    await expect.poll(() => text(page)).toContain('\n    1 as untouched;\nselect\n    2 as formatted;')
    // Defaults change inherited engines immediately, without replacing custom styles.
    form = await openSettings(page)
    await form.getByLabel(/Indent width/).fill('6')
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('mysql')
    await expect(form.getByLabel(/Format indent width/)).toHaveValue('6')
    await expect(form.getByLabel(/Format indent width/)).toBeDisabled()
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('postgres')
    await expect(form.getByLabel(/Format indent width/)).toHaveValue('4')
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await enter(page, '')
    await page.keyboard.press('Tab'); await page.keyboard.insertText('select 9;')
    await expect.poll(() => text(page)).toBe('      select 9;') // Typed indentation stays global.
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(() => text(page)).toBe('select\n    9;')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect((await workspace(page))?.editorSettings).toMatchObject({ tabSize: 6, engineFormatting: {
      postgres: { tabSize: 4 }, duckdb: { tabSize: 8, insertSpaces: false }
    } })
    form = await openSettings(page)
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('postgres')
    await form.getByLabel('Use custom formatting', { exact: true }).uncheck()
    await expect(form.getByLabel(/Format indent width/)).toHaveValue('6')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await workspace(page))?.editorSettings?.engineFormatting?.postgres?.tabSize).toBe(4)
    form = await openSettings(page)
    await form.getByLabel('Formatting settings for', { exact: true }).selectOption('postgres')
    await form.getByLabel('Use custom formatting', { exact: true }).uncheck()
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(() => text(page)).toBe('select\n      9;')
    expect((await workspace(page))?.editorSettings?.engineFormatting?.postgres).toBeUndefined()
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await enter(page, 'select 8;')
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(() => text(page)).toBe('select\n\t8;')
    form = await openSettings(page); await form.getByRole('button', { name: 'Reset defaults', exact: true }).click()
    await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorSettings).toEqual(DEFAULT_EDITOR_SETTINGS)
  } finally { await forceClose(app); rmSync(directory, { recursive: true, force: true }) }
})
