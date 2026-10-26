import { waitForWorkspaceReady } from './workspace-ready'
import { profileAction } from './profile-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try { const page = await app.firstWindow(); await waitForWorkspaceReady(page); return { app, page } }
  catch (error) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); throw error }
}
async function profile(page: Page) { return (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles[0] }
async function edit(page: Page, name: string) { await profileAction(page, `${name}`, 'Edit'); return page.getByRole('dialog') }
async function save(page: Page) { await page.getByRole('dialog').getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('dialog')).toBeHidden() }
async function native(app: ElectronApplication, id: string, expected?: string, remove = false) {
  return app.evaluate(async ({ app }, { id, expected, remove }) => {
    const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { AsyncEntry } = req('@napi-rs/keyring')
    const service = 'org.dbcommander.passwords.' + req('node:crypto').createHash('sha256').update(req('node:path').resolve(app.getPath('userData'))).digest('hex').slice(0, 24)
    const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } })
    if (remove) { await entry.deleteCredential(); return true }
    const value = await entry.getPassword()
    return expected === undefined ? value === null : value !== null && JSON.parse(value).password === expected
  }, { id, expected, remove })
}
async function fault(app: ElectronApplication, methods: string[]) {
  await app.evaluate(({ app }, methods) => {
    const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const prototype = req('@napi-rs/keyring').AsyncEntry.prototype
    const state = globalThis as any
    state.originalCredentialMethods ??= Object.fromEntries(['getPassword', 'setPassword', 'deleteCredential'].map(key => [key, prototype[key]]))
    for (const [key, original] of Object.entries(state.originalCredentialMethods)) prototype[key] = methods.includes(key) ? async () => { throw new Error('Test store locked; sensitive-native-detail') } : original
  }, methods)
}
async function cleanup(app: ElectronApplication | undefined, ids: Set<string>, directory: string) {
  if (app) {
    await fault(app, []).catch(() => {})
    for (const id of ids) await native(app, id, undefined, true)
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  }
  rmSync(directory, { recursive: true, force: true })
}
async function noWorkspaceSecrets(directory: string, secrets: string[]) {
  for (const name of readdirSync(directory).filter(name => name.startsWith('workspace.sqlite'))) {
    const deadline = Date.now() + 5000
    let bytes: Buffer
    for (;;) {
      try { bytes = readFileSync(join(directory, name)); break }
      catch (error) {
        // Native SQLite briefly locks its live files on Windows. Retry only
        // that read failure; a plaintext match below must fail immediately.
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() >= deadline) throw error
        await pause(25)
      }
    }
    for (const secret of secrets) { expect(bytes.includes(Buffer.from(secret))).toBe(false); expect(bytes.includes(Buffer.from(secret, 'utf16le'))).toBe(false) }
  }
}

test('credentials native changed connections keep the original saved password and require opt-in for a new profile', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credential-profiles-')), ids = new Set<string>()
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Connection name', { exact: true }).fill('Original saved server')
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1'); await form.getByLabel('Port', { exact: true }).fill('1')
    await form.getByLabel('Password', { exact: true }).fill('original-profile-secret')
    await form.getByLabel('Remember password', { exact: true }).check(); await save(page)
    const original = await profile(page); ids.add(original.id)
    await page.getByRole('button', { name: 'Open Original saved server in new tab', exact: true }).click()
    await page.getByRole('dialog', { name: 'Connection failed', exact: true }).getByRole('button', { name: 'OK', exact: true }).click()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    form = page.getByRole('dialog'); await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked()
    await form.getByLabel('Connection name', { exact: true }).fill('Separate saved server')
    await expect(form).toContainText('A new saved connection will be added')
    await expect(form).toContainText('“Original saved server” has a saved password.')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Enter a password to remember it for the new profile')
    expect(await native(app, original.id, 'original-profile-secret')).toBe(true)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles).toEqual([original])
    await form.getByLabel('Host', { exact: true }).fill('changed.invalid')
    await expect(form).toContainText('existing saved connection and password are kept')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('existing saved password is kept')
    await page.screenshot({ path: info.outputPath('separate-profile-password-guidance.png') })
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    form = page.getByRole('dialog')
    await expect(form.getByLabel('Remember password', { exact: true })).not.toBeChecked()
    await expect(form.getByLabel('Use saved password', { exact: true })).toHaveCount(0)
    await expect(form.getByRole('button', { name: 'Remove saved password', exact: true })).toHaveCount(0)
    expect(await native(app, original.id, 'original-profile-secret')).toBe(true)
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles).toEqual([original])
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await noWorkspaceSecrets(directory, ['original-profile-secret'])
  } finally { await cleanup(app, ids, directory) }
})

test('credentials native store opt-in, restart, replacement, removal and profile deletion', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credentials-')), ids = new Set<string>()
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    expect((await page.evaluate(() => window.dbCommander.passwordStatus())).available).toBe(true)
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Connection name').fill('Vault profile')
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1'); await form.getByLabel('Port', { exact: true }).fill('1')
    await expect(form.getByLabel('Remember password', { exact: true })).not.toBeChecked()
    await form.getByLabel('Password', { exact: true }).fill('session-only-sentinel')
    await save(page)
    const id = (await profile(page)).id; ids.add(id)
    expect(await native(app, id)).toBe(true)
    form = await edit(page, 'Vault profile')
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('')
    await form.getByLabel('Password', { exact: true }).fill('first-vault-sentinel')
    await form.getByLabel('Remember password', { exact: true }).check(); await save(page)
    expect(await native(app, id, 'first-vault-sentinel')).toBe(true)
    expect((await profile(page)).credential).toBe('os-store')
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('sql:connectSavedPassword')
      ipcMain.removeHandler('sql:connectSavedPassword')
      ipcMain.handle('sql:connectSavedPassword', (event, request) => {
        ;(globalThis as any).savedConnectRequest = { profileId: request.profileId, hasPlaintext: 'password' in request.config }
        return original(event, request)
      })
    })
    await page.getByRole('button', { name: 'Open Vault profile in new tab', exact: true }).click()
    const warning = page.getByRole('dialog', { name: 'Connection failed', exact: true })
    await expect(warning).toContainText('Could not connect to Vault profile')
    await expect(warning.getByRole('alert')).not.toContainText('first-vault-sentinel')
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
    expect(await app.evaluate(() => (globalThis as any).savedConnectRequest)).toEqual({ profileId: id, hasPlaintext: false })
    expect(await native(app, id, 'first-vault-sentinel')).toBe(true)
    const warningImage = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(testInfo.outputPath('saved-connection-warning.png'), warningImage, 'base64')
    await warning.getByRole('button', { name: 'OK', exact: true }).click()
    form = await edit(page, 'Vault profile'); await form.getByLabel('Connection name').fill('Renamed vault profile'); await save(page)
    expect(await native(app, id, 'first-vault-sentinel')).toBe(true)
    form = await edit(page, 'Renamed vault profile')
    await form.getByLabel('Password', { exact: true }).fill('replacement-vault-sentinel'); await save(page)
    expect(await native(app, id, 'replacement-vault-sentinel')).toBe(true)
    form = await edit(page, 'Renamed vault profile'); await form.getByLabel('Host', { exact: true }).fill('changed.invalid')
    await form.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Enter a password')
    await form.getByLabel('Remember password', { exact: true }).uncheck(); await save(page)
    expect(await native(app, id)).toBe(true)
    form = await edit(page, 'Renamed vault profile')
    await form.getByLabel('Password', { exact: true }).fill('remove-vault-sentinel'); await form.getByLabel('Remember password', { exact: true }).check(); await save(page)
    form = await edit(page, 'Renamed vault profile')
    await form.getByRole('button', { name: 'Remove saved password', exact: true }).click()
    await expect(form.getByRole('button', { name: 'Remove saved password', exact: true })).toHaveCount(0)
    expect(await native(app, id)).toBe(true)
    await form.getByLabel('Password', { exact: true }).fill('delete-vault-sentinel'); await form.getByLabel('Remember password', { exact: true }).check(); await save(page)
    form = await edit(page, 'Renamed vault profile'); await expect(form.getByLabel('Remember password', { exact: true })).toBeChecked()
    await page.screenshot({ path: testInfo.outputPath('saved-password-controls.png') })
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await profileAction(page, 'Renamed vault profile', 'Delete')
    await page.getByRole('dialog').getByRole('button', { name: 'Delete profile', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open Renamed vault profile in new tab', exact: true })).toHaveCount(0)
    expect(await native(app, id)).toBe(true)
    await noWorkspaceSecrets(directory, ['session-only-sentinel', 'first-vault-sentinel', 'replacement-vault-sentinel', 'remove-vault-sentinel', 'delete-vault-sentinel'])
    const publicState = await page.evaluate(async () => ({ workspace: await window.dbCommander.loadWorkspace(), history: await window.dbCommander.history(), api: Object.keys(window.dbCommander) }))
    expect(JSON.stringify(publicState)).not.toMatch(/vault-sentinel|session-only-sentinel/)
    expect(publicState.api.some(key => /getPassword|resolvePassword|readPassword/.test(key))).toBe(false)
  } finally { await cleanup(app, ids, directory) }
})

test('credentials unavailable, failed writes/deletes and missing secrets fail without plaintext fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credentials-failure-')), ids = new Set<string>()
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await fault(app, ['getPassword'])
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    let form = page.getByRole('dialog'); await form.getByLabel('Connection name').fill('Unavailable vault')
    await expect(form.getByLabel('Remember password', { exact: true })).toBeDisabled()
    await expect(form).toContainText('unavailable or locked')
    await form.getByLabel('Password', { exact: true }).fill('unsaved-vault-sentinel'); await save(page)
    const id = (await profile(page)).id; ids.add(id)
    expect((await profile(page)).credential).toBeUndefined()
    await fault(app, [])
    form = await edit(page, 'Unavailable vault')
    await form.getByLabel('Password', { exact: true }).fill('failed-write-sentinel'); await form.getByLabel('Remember password', { exact: true }).check()
    await fault(app, ['setPassword'])
    await form.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Password was not saved')
    await expect(form.getByRole('alert')).not.toContainText('sensitive-native-detail')
    expect(await native(app, id)).toBe(true)
    await fault(app, []); await save(page)
    expect(await native(app, id, 'failed-write-sentinel')).toBe(true)
    await fault(app, ['deleteCredential'])
    await profileAction(page, 'Unavailable vault', 'Delete')
    await page.getByRole('dialog').getByRole('button', { name: 'Delete profile', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('.error-banner')).toContainText('saved-password cleanup is pending')
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.profiles).toEqual([])
    expect(await native(app, id, 'failed-write-sentinel')).toBe(true)
    await expect(page.locator('.error-banner')).not.toContainText('sensitive-native-detail')
    await fault(app, [])
    // Reopening/reloading retries the durable cleanup before another password
    // can be saved under the same profile ID.
    await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(await native(app, id)).toBe(true)
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    form = page.getByRole('dialog'); await form.getByLabel('Connection name').fill('Unavailable vault')
    await form.getByLabel('Password', { exact: true }).fill('replacement-sentinel'); await form.getByLabel('Remember password', { exact: true }).check()
    await save(page)
    const replacementId = (await profile(page)).id; ids.add(replacementId)
    await native(app, replacementId, undefined, true)
    await page.getByRole('button', { name: 'Open Unavailable vault in new tab', exact: true }).click()
    const warning = page.getByRole('dialog', { name: 'Connection failed', exact: true })
    await expect(warning.getByRole('alert')).toContainText('saved password is missing')
    await warning.getByRole('button', { name: 'Edit connection', exact: true }).click()
    form = page.getByRole('dialog')
    await form.getByRole('button', { name: 'Remove saved password', exact: true }).click()
    await expect(form.getByLabel('Use saved password', { exact: true })).toHaveCount(0)
    await noWorkspaceSecrets(directory, ['unsaved-vault-sentinel', 'failed-write-sentinel', 'replacement-sentinel'])
    await form.getByLabel('Database engine').selectOption('azure-sql'); await form.getByLabel('Authentication').selectOption('entra-token')
    await expect(form.getByLabel('Remember password', { exact: true })).toHaveCount(0)
    await form.getByLabel('Database engine').selectOption('sqlite'); await expect(form.getByLabel('Remember password', { exact: true })).toHaveCount(0)
  } finally { await cleanup(app, ids, directory) }
})

for (const tunneled of [false, true]) test(`credentials postgres ${tunneled ? 'SSH encrypted key and ' : ''}saved authentication, shared sessions and explicit reconnect after recovery`, async () => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('postgres'), 'PostgreSQL Docker fixture not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credentials-postgres-')), ids = new Set<string>()
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    let form = page.getByRole('dialog')
    await form.getByLabel('Connection name').fill('Saved PostgreSQL')
    await form.getByLabel('Port', { exact: true }).fill(tunneled ? '5432' : process.env.SQLCOMMANDER_PG_PORT!)
    await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Database', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill('local-test-only')
    await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'))
    if (tunneled) {
      await form.getByText('SSH tunnel', { exact: true }).click(); await form.getByLabel('Use SSH tunnel').check(); await form.getByLabel('SSH host', { exact: true }).fill('127.0.0.1'); await form.getByLabel('SSH port', { exact: true }).fill(process.env.SQLCOMMANDER_SSH_PORT!)
      await form.getByLabel('SSH user', { exact: true }).fill('tunnel'); await form.getByLabel('SSH host-key fingerprint').fill(process.env.SQLCOMMANDER_SSH_FINGERPRINT!)
      await form.getByLabel('Database host from SSH server').fill('postgres')
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog }, process.env.SQLCOMMANDER_SSH_KEY!)
      await form.getByRole('button', { name: 'Choose SSH key', exact: true }).click(); await expect(form.getByLabel('SSH private key path')).toHaveValue(process.env.SQLCOMMANDER_SSH_KEY!)
      await form.getByLabel('SSH key passphrase').fill('local-key-passphrase')
    }
    await form.getByLabel('Remember password', { exact: true }).check()
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    const id = (await profile(page)).id; ids.add(id)
    expect(await native(app, id, 'local-test-only')).toBe(true)
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Open Saved PostgreSQL in new tab', exact: true }).click()
    if (tunneled) {
      await page.getByRole('dialog', { name: 'Connection failed', exact: true }).getByRole('button', { name: 'OK', exact: true }).click()
      await page.getByRole('button', { name: 'Connect database', exact: true }).click()
      form = page.getByRole('dialog'); await expect(form.getByLabel('Use saved password', { exact: true })).toBeChecked()
      await expect(form.getByLabel('Password', { exact: true })).toHaveValue('')
      await expect(form.getByLabel('SSH key passphrase')).toHaveValue(''); await form.getByLabel('SSH key passphrase').fill('local-key-passphrase')
      await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    }
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    async function run(sql: string) {
      await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql)
      await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    }
    await run('CREATE TEMP TABLE credential_session(n INT); INSERT INTO credential_session VALUES(77)')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await run("SELECT count(*) AS count FROM pg_tables WHERE tablename='credential_session' AND schemaname = pg_my_temp_schema()::regnamespace::text")
    await expect(page.locator('[data-result-row="0"][data-result-column="0"]')).toHaveText('1')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click(); await run('SELECT n FROM credential_session')
    await expect(page.getByRole('cell', { name: '77', exact: true })).toBeVisible()
    form = await edit(page, 'Saved PostgreSQL'); await form.getByRole('button', { name: 'Remove saved password', exact: true }).click()
    await expect(form.getByRole('button', { name: 'Remove saved password', exact: true })).toHaveCount(0)
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await run('SELECT 123 AS still_connected'); await expect(page.getByRole('cell', { name: '123', exact: true })).toBeVisible()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const recovered = app.waitForEvent('window'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await recovered; await waitForWorkspaceReady(page)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await noWorkspaceSecrets(directory, ['local-test-only', 'local-key-passphrase', 'BEGIN OPENSSH PRIVATE KEY'])
  } finally { await cleanup(app, ids, directory) }
})

test('credentials native: failed profile persistence preserves the saved password until a successful retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credential-save-failure-')), ids = new Set<string>()
  let app: ElectronApplication | undefined, blocker: DatabaseSync | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    let form = page.getByRole('dialog'); await form.getByLabel('Connection name').fill('Save failure profile')
    await form.getByLabel('Password', { exact: true }).fill('durability-sentinel'); await form.getByLabel('Remember password', { exact: true }).check()
    await save(page)
    const original = await profile(page); ids.add(original.id)
    blocker = new DatabaseSync(join(directory, 'workspace.sqlite'))
    blocker.exec("CREATE TRIGGER reject_profile_save BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT, 'simulated workspace save failure'); END;")
    form = await edit(page, 'Save failure profile')
    await form.getByLabel('Host', { exact: true }).fill('different.invalid')
    await form.getByLabel('Remember password', { exact: true }).uncheck()
    await form.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('simulated workspace save failure')
    expect(await profile(page)).toEqual(original)
    expect(await native(app, original.id, 'durability-sentinel')).toBe(true)
    blocker.exec('DROP TRIGGER reject_profile_save'); blocker.close(); blocker = undefined
    await save(page)
    expect((await profile(page)).config.host).toBe('different.invalid')
    expect((await profile(page)).credential).toBeUndefined()
    expect(await native(app, original.id)).toBe(true)
    await noWorkspaceSecrets(directory, ['durability-sentinel'])
  } finally { blocker?.close(); await cleanup(app, ids, directory) }
})

test('credentials native: pending cleanup blocks password replacement until it can settle safely', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-credential-cleanup-')), ids = new Set<string>()
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Connection name').fill('Cleanup ordering')
    await form.getByLabel('Password', { exact: true }).fill('cleanup-old-sentinel'); await form.getByLabel('Remember password', { exact: true }).check()
    await save(page)
    const id = (await profile(page)).id; ids.add(id)
    await fault(app, ['deleteCredential'])
    const removal = await page.evaluate(async id => {
      try { await window.dbCommander.removeProfilePassword(id); return '' } catch (error) { return (error as Error).message }
    }, id)
    expect(removal).toContain('cleanup is pending')
    const replacement = await page.evaluate(async id => {
      try { await window.dbCommander.saveProfilePassword(id, 'cleanup-new-sentinel'); return '' } catch (error) { return (error as Error).message }
    }, id)
    expect(replacement).toContain('cleanup is pending')
    expect(await native(app, id, 'cleanup-old-sentinel')).toBe(true)
    await fault(app, [])
    await page.evaluate(id => window.dbCommander.saveProfilePassword(id, 'cleanup-new-sentinel'), id)
    await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(await native(app, id, 'cleanup-new-sentinel')).toBe(true)
    await noWorkspaceSecrets(directory, ['cleanup-old-sentinel', 'cleanup-new-sentinel'])
  } finally { await cleanup(app, ids, directory) }
})
