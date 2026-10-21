import assert from 'node:assert/strict'
import { _electron as electron, expect } from '@playwright/test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { captureStartupDiagnostics } from '../../scripts/release/startup-diagnostics.mjs'

const password = 'installer-test-only-password'
export function installedLaunchOptions(executable, directory, inherited = process.env) {
  const env = { ...inherited, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const disabled = inherited.SQLCOMMANDER_INSTALL_TEST_NO_SANDBOX === '1'
  if (disabled && !(inherited.CI === 'true' && inherited.SQLCOMMANDER_DISPOSABLE_INSTALL_TEST === '1')) throw new Error('Unsandboxed installer tests require the explicit disposable CI container.')
  return { executablePath: executable, env, timeout: 60_000, chromiumSandbox: !disabled, args: disabled ? ['--no-sandbox'] : [] }
}
export async function openInstalled(executable, directory, version, arch) {
  const options = installedLaunchOptions(executable, directory)
  const app = await electron.launch(options)
  const diagnostics = captureStartupDiagnostics(app, directory)
  try {
    const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), arch: process.arch, packaged: app.isPackaged }))
    assert.deepEqual(info, { version, arch, packaged: true })
    assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), !options.chromiumSandbox, 'Installed Chromium sandbox mode must match the qualification policy.')
    const page = await app.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.monaco-editor')).toBeVisible()
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    return { app, page }
  } catch (error) {
    console.error('Installed startup diagnostics:', await diagnostics())
    // Installer-only path failures must show both the module and Chromium URL.
    console.error('Installed startup context:', await app.evaluate(({ app, BrowserWindow }) => ({
      applicationPath: app.getAppPath(), rendererUrls: BrowserWindow.getAllWindows().map(window => window.webContents.getURL()),
    })).catch(() => 'unavailable'))
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {}); await app.close().catch(() => {}); throw error
  }
}

async function query(page, config, sql) {
  return page.evaluate(async ({ config, sql }) => {
    const api = window.dbCommander, session = await api.connect(config), rows = []
    try {
      const complete = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Installed native engine timed out.')) }, 30_000)
        const off = api.onEvent(event => {
          if (!('sessionId' in event) || event.sessionId !== session.id) return
          if (event.type === 'rows') rows.push(...event.rows)
          if (event.type === 'complete') { clearTimeout(timer); off(); resolve(event) }
        })
      })
      await api.run({ sessionId: session.id, sql, maxRows: 10 })
      const result = await complete
      if (result.status !== 'completed' || result.transaction !== 'idle') throw new Error('Installed native query failed or left a transaction.')
      return rows
    } finally { await api.disconnect(session.id) }
  }, { config, sql })
}

function config(engine, directory, create) {
  return { engine, name: `Installer ${engine}`, host: 'local', port: 1, user: 'local', database: engine, password: '', tls: 'disable',
    filePath: join(directory, `${engine}.db`), ...(engine === 'sqlite' ? { sqliteMode: create ? 'create' : 'read-write' } : { duckdbMode: create ? 'create' : 'read-write' }) }
}
async function snapshot(page) {
  return page.evaluate(async () => ({ workspace: await window.dbCommander.loadWorkspace(), snippets: await window.dbCommander.snippets({}), history: await window.dbCommander.history() }))
}

async function checkCredential(app, id, remove = false) {
  const valid = await app.evaluate(async ({ app }, { id, password, remove }) => {
    const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { AsyncEntry } = req('@napi-rs/keyring')
    const service = 'org.dbcommander.passwords.' + req('node:crypto').createHash('sha256').update(req('node:path').resolve(app.getPath('userData'))).digest('hex').slice(0, 24)
    const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } })
    if (remove) { await entry.deleteCredential(); return true }
    const value = await entry.getPassword()
    return value !== null && JSON.parse(value).password === password
  }, { id, password, remove })
  assert.equal(valid, true, 'The saved OS credential must survive replacement/reinstallation.')
}

export async function seedInstalled({ app, page }, directory, profileId) {
  const tabId = randomUUID(), otherId = randomUUID()
  await page.evaluate(async ({ profileId, tabId, otherId }) => {
    const profile = { engine: 'postgres', name: 'Installer profile', host: 'example.invalid', port: 5432, database: 'sample', user: 'test-only', tls: 'verify-full' }
    await window.dbCommander.saveWorkspace({ version: 2, activeTabId: otherId, profiles: [{ id: profileId, config: profile }],
      tabs: [{ id: tabId, title: 'Unfinished.sql', sql: 'SELECT 123;', profile, profileId }, { id: otherId, title: 'Second.sql', sql: '-- Never replay this buffer\nSELECT 456;', profile, profileId }],
      layout: { sidebarVisible: false, sidebarWidth: 280, resultsVisible: true, resultsHeight: 300, resultsMaximized: false } })
    await window.dbCommander.saveSnippet({ name: 'Retained snippet', description: 'Installer fixture', sql: 'SELECT 789;', favorite: true })
  }, { profileId, tabId, otherId })
  await page.reload(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.evaluate(async ({ profileId, password }) => window.dbCommander.saveProfilePassword(profileId, password), { profileId, password })
  await page.reload(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  for (const engine of ['sqlite', 'duckdb']) {
    const rows = await query(page, config(engine, directory, true), 'CREATE TABLE installer_data(value BIGINT); INSERT INTO installer_data VALUES(9223372036854775807); SELECT value FROM installer_data;')
    assert.deepEqual(rows, [['9223372036854775807']])
  }
  await checkCredential(app, profileId)
  return { profileId, ...(await snapshot(page)) }
}

export async function verifyInstalled({ app, page }, directory, expected) {
  // Check before any intentional SQL: opening an upgraded workspace must not
  // reconnect profiles or append replayed SQL to history.
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  assert.deepEqual(await snapshot(page), { workspace: expected.workspace, snippets: expected.snippets, history: expected.history })
  await checkCredential(app, expected.profileId)
  for (const engine of ['sqlite', 'duckdb']) assert.deepEqual(await query(page, config(engine, directory, false), 'SELECT value FROM installer_data;'), [['9223372036854775807']])
  return { profileId: expected.profileId, ...(await snapshot(page)) }
}
export async function noPlaintextPassword(directory) {
  for (const name of (await readdir(directory)).filter(name => name.startsWith('workspace.sqlite'))) {
    const content = await readFile(join(directory, name))
    assert.equal(content.includes(Buffer.from(password)), false, 'Workspace files must not contain the saved password.')
  }
}
export async function removeCredential(app, profileId) { await checkCredential(app, profileId, true) }
export async function closeInstalled(app) { await app.close() }
