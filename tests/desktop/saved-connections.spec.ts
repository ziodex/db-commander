import { profileAction } from './profile-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, MAX_PROFILES, type ConnectionProfile } from '../../src/shared/contracts'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try { const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible(); return { app, page } }
  catch (error) { await close(app); throw error }
}
async function close(app?: ElectronApplication) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }
async function run(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
}
async function configure(page: Page, engine: 'sqlite' | 'duckdb', name: string, file: string) {
  const form = page.getByRole('dialog')
  await form.getByLabel('Database engine').selectOption(engine); await form.getByLabel('Connection name', { exact: true }).fill(name)
  await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(file)
  return form
}
async function connected(page: Page) {
  const form = page.getByRole('dialog'); await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
  await expect(page.getByRole('button', { name: 'Connection settings', exact: true })).toBeEnabled()
}

for (const engine of ['sqlite', 'duckdb'] as const) test(`saved connections ${engine}: new and changed connections retain earlier profiles through restart`, async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-saved-connections-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    await configure(page, engine, 'First connection', join(directory, `first.${engine}`)); await connected(page)
    await run(page, "CREATE TABLE retained(value BIGINT); INSERT INTO retained VALUES(9223372036854775807);")
    const first = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles[0]
    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    await configure(page, engine, 'Second connection', join(directory, `second.${engine}`)); await connected(page)
    const afterNew = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    await page.screenshot({ path: info.outputPath('after-new-connection.png') })
    expect(afterNew.profiles).toHaveLength(2)
    expect(afterNew.profiles.find(profile => profile.id === first.id)).toEqual(first)
    await expect(page.getByRole('button', { name: 'Open First connection in new tab', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Second connection in new tab', exact: true })).toBeVisible()
    // Changing settings while attached to a saved profile must also preserve
    // that profile. Updating an existing entry has its explicit Edit action.
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await configure(page, engine, 'Third connection', join(directory, `third.${engine}`)); await connected(page)
    const afterChange = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    expect(afterChange.profiles).toHaveLength(3)
    expect(afterChange.profiles.filter(profile => afterNew.profiles.some(previous => previous.id === profile.id))).toEqual(afterNew.profiles)
    const second = afterChange.profiles.find(profile => profile.config.name === 'Second connection')!
    await profileAction(page, 'Second connection', 'Edit')
    const edit = page.getByRole('dialog'); await edit.getByLabel('Connection name', { exact: true }).fill('Renamed second')
    await edit.getByLabel('Profile folder').fill('Reporting'); await edit.getByLabel('Favorite profile').check()
    await edit.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(edit).toBeHidden()
    const afterEdit = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!
    expect(afterEdit.profiles).toHaveLength(3)
    expect(afterEdit.profiles.find(profile => profile.id === second.id)?.config).toMatchObject({ name: 'Renamed second', folder: 'Reporting', favorite: true })
    await page.getByRole('button', { name: 'Favorites only', exact: true }).click()
    await expect(page.locator('.profile-open')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Open Renamed second in new tab', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Favorites only', exact: true }).click(); await expect(page.locator('.profile-open')).toHaveCount(3)
    await page.getByRole('button', { name: 'Open First connection in new tab', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Connected')
    await run(page, 'SELECT value FROM retained;'); await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    // Reconnecting unchanged settings reuses its profile instead of making
    // duplicate entries. Password-only reconnects follow this same path.
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click(); await connected(page)
    const final = (await page.evaluate(() => window.dbCommander.loadWorkspace()))!, history = await page.evaluate(() => window.dbCommander.history())
    expect(final.profiles).toHaveLength(3); expect(final.tabs.find(tab => tab.id === final.activeTabId)?.profileId).toBe(first.id)
    await page.screenshot({ path: info.outputPath('multiple-saved-connections.png') })
    await close(app); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    const recovered = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(recovered?.profiles).toEqual(final.profiles); expect(recovered?.tabs).toEqual(final.tabs)
    await expect(page.locator('.profile-open')).toHaveCount(3)
    for (const name of ['First connection', 'Renamed second', 'Third connection']) await expect(page.getByRole('button', { name: `Open ${name} in new tab`, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    writeFileSync(info.outputPath('saved-connections.json'), JSON.stringify({ engine, profiles: final.profiles.map(profile => ({ id: profile.id, name: profile.config.name })), firstDatabasePreserved: true, explicitEditReusesId: true, unchangedReconnectReusesId: true, restartProfiles: 3, noReplay: true }, null, 2))
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

test('saved connections capacity: all profiles remain reachable and an over-limit save retains the active session', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-profile-capacity-')), file = join(directory, 'source.sqlite'), profileId = randomUUID(), tabId = randomUUID()
  const config: ConnectionProfile = { engine: 'sqlite', name: 'Source connection', host: 'local', port: 1, database: 'SQLite', user: 'local', tls: 'disable', filePath: file, sqliteMode: 'read-write' }
  const database = new DatabaseSync(file); database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('source remains connected');"); database.close()
  const profiles = [{ id: profileId, config }, ...Array.from({ length: MAX_PROFILES - 1 }, (_, index) => ({ id: randomUUID(), config: { ...DEFAULT_PROFILE, name: `Saved ${String(index).padStart(3, '0')}` } }))]
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite'))
  store.save({ version: 2, activeTabId: tabId, profiles, tabs: [{ id: tabId, title: 'Retained.sql', sql: 'SELECT never_replayed;', profile: config, profileId }] }); store.close()
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650))
    await expect(page.locator('.profile-open')).toHaveCount(MAX_PROFILES)
    const list = page.locator('.profile-list')
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 60)).toBe(true)
    const last = page.getByRole('button', { name: 'Open Source connection in new tab', exact: true })
    await last.focus(); await expect(last).toBeFocused()
    expect(await last.evaluate(element => { const list = element.closest('.profile-list')!.getBoundingClientRect(), row = element.getBoundingClientRect(); return row.top >= list.top && row.bottom <= list.bottom })).toBe(true)
    await page.keyboard.press('Enter'); await expect(page.locator('.status-text')).toHaveText('Connected')
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Connection name', { exact: true }).fill('Over limit connection')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('100 profiles')
    await page.screenshot({ path: info.outputPath('profile-capacity-guidance.png') })
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles).toEqual(profiles)
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await run(page, 'SELECT value FROM retained;'); await expect(page.getByRole('cell', { name: 'source remains connected', exact: true })).toBeVisible()
    // An explicitly session-only connection is still available at capacity.
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await form.getByLabel('Connection name', { exact: true }).fill('Session only'); await form.getByLabel('Save connection profile', { exact: true }).uncheck(); await connected(page)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles).toEqual(profiles)
    await run(page, 'SELECT value FROM retained;'); await expect(page.getByRole('cell', { name: 'source remains connected', exact: true })).toBeVisible()
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})
