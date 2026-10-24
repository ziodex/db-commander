import { fileMenu } from './file-menu'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { diskFullFixture } from './disk-full-fixture'
import { withClipboard } from './clipboard-fixture'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try { const page = await app.firstWindow(); await expect(page.locator('.monaco-editor')).toBeVisible(); return { app, page } }
  catch (error) { await close(app); throw error }
}
async function close(app?: ElectronApplication) {
  if (!app) return
  async function bounded(pending: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([pending.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) }
    finally { clearTimeout(timer) }
  }
  await bounded(app.evaluate(({ app }) => app.exit(0)))
  if (app.process().exitCode === null) app.process().kill('SIGKILL')
  await bounded(app.close())
}
async function enter(page: Page, text: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(text); await page.keyboard.press('Escape')
}
const largeBuffers = [
  { name: 'long line', sql: 'SELECT 1; -- ' + 'x'.repeat(256 * 1024) },
  { name: 'many lines', sql: 'SELECT 2;\n' + '-- large buffer\n'.repeat(60_000) }
]
async function paste(app: ElectronApplication, page: Page, text: string) {
  // Input.insertText is IME typing in Monaco: it edits each character separately.
  // Use the native paste command for bulk input, preserving original formats.
  await withClipboard(app, async () => {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
    await page.getByRole('textbox', { name: 'SQL editor', exact: true }).focus()
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+A`); await page.keyboard.press(`${modifier}+V`); await page.keyboard.press('Escape')
  })
}
const stored = (page: Page) => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)
async function expectStored(page: Page, expected: string) {
  // Keep failure reports bounded even for near-limit SQL buffers.
  await expect.poll(async () => {
    const value = await stored(page)
    return { matches: value === expected, characters: value?.length }
  }).toEqual({ matches: true, characters: expected.length })
}
const latest = 'SELECT unsaved_during_disk_full;'

async function exhaustWorkspaceWrites(page: Page, app: ElectronApplication, large: boolean) {
  let committed = await stored(page)
  if (committed === undefined) throw new Error('The fixture must have a committed workspace before exhausting the disk.')
  // A full filesystem may still have allocated tail space in SQLite's WAL.
  // Normal small edits consume that space before a write needs new blocks.
  for (let attempt = 1; attempt <= 64; attempt++) {
    const pending = large ? largeBuffers[1].sql + `-- attempt ${attempt}` : `SELECT unsaved_during_disk_full_${attempt};\n` + '-- disk pressure\n'.repeat(512)
    if (large) await paste(app, page, pending); else await enter(page, pending)
    await expect.poll(async () => await stored(page) === pending ? 'saved' : await page.getByRole('button', { name: 'Retry workspace save', exact: true }).count() ? 'failed' : 'pending').not.toBe('pending')
    if (await stored(page) === pending) committed = pending
    else return { committed, pending, attempts: attempt }
  }
  throw new Error('The workspace did not exhaust its WAL allocation within 64 bounded edits.')
}
function workspaceDirectory(volume: ReturnType<typeof diskFullFixture>) {
  // Isolate SQLite/WAL exhaustion from Chromium's own profile/cache writes.
  const directory = join(volume.root, 'profile'), file = join(volume.mount, 'workspace.sqlite')
  mkdirSync(directory); new DatabaseSync(file).close(); symlinkSync(file, join(directory, 'workspace.sqlite'))
  return directory
}

const saveScenarios = [
  { wholeProfile: false, large: false },
  { wholeProfile: true, large: false },
  { wholeProfile: true, large: true }
]
for (const { wholeProfile, large } of saveScenarios) test(`workspace disk full ${wholeProfile ? 'whole profile ' : ''}${large ? 'large buffer ' : ''}preserves committed work, cancels close, exports a rescue copy and retries`, async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real workspace exhaustion uses a bounded macOS disk image.')
  test.setTimeout(120000)
  const volume = diskFullFixture(), directory = wholeProfile ? join(volume.mount, 'profile') : workspaceDirectory(volume)
  if (wholeProfile) mkdirSync(directory)
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; const page = launched.page
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const baseline = large ? largeBuffers[0].sql : 'SELECT committed_before_disk_full;'
    if (large) await paste(app, page, baseline); else await enter(page, baseline)
    await expectStored(page, baseline)
    expect(existsSync(join(wholeProfile ? directory : volume.mount, 'workspace.sqlite-wal'))).toBe(true)
    const checkpoint = new DatabaseSync(join(directory, 'workspace.sqlite'))
    try { checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { checkpoint.close() }
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }))
    expect(paths).toEqual({ userData: directory, sessionData: directory })
    const registry = join(directory, 'sql-files.json')
    await expect.poll(() => existsSync(registry)).toBe(true)
    const registryBefore = readFileSync(registry)
    const full = volume.fill()
    const failed = await test.step(`Exhaust remaining WAL allocation with ${large ? 'large pastes' : 'small edits'}`, () => exhaustWorkspaceWrites(page, app!, large), { timeout: 60000 })
    await expect(page.locator('.error-banner')).toContainText(/database or disk is full/i)
    await expect(page.getByText('Workspace not saved', { exact: true })).toBeVisible()
    await expectStored(page, failed.committed)
    await page.screenshot({ path: info.outputPath('workspace-disk-full.png') })
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__fullClosePrompts = []
      dialog.showMessageBox = async (windowOrOptions: any, options?: any) => {
        ;(globalThis as any).__fullClosePrompts.push(options ?? windowOrOptions)
        return { response: 0, checkboxChecked: false }
      }
    })
    await (await app.browserWindow(page)).evaluate(window => window.close())
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__fullClosePrompts.map((prompt: any) => prompt.title))).toContain('Workspace not saved')
    expect(page.isClosed()).toBe(false)
    // Saving the rescue file renames the tab and schedules autosave as well as
    // an immediate workspace save. Keep renderer timers paused until the real
    // Retry click, so freeing disk space cannot let autosave remove its button.
    // Native IPC and the actual SQLite/ENOSPC path remain live.
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000))
    const rescue = join(volume.root, 'rescued.sql')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, rescue)
    await fileMenu(app!, page, 'Save')
    await expect.poll(() => { try { return readFileSync(rescue, 'utf8') } catch { return '' } }).toBe(failed.pending)
    await expect(page.getByRole('button', { name: 'Open SQL file', exact: true })).toBeEnabled()
    await expectStored(page, failed.committed)
    if (wholeProfile) {
      await expect(page.locator('.error-banner')).toContainText('The SQL file was written, but its file association could not be saved')
      expect(readFileSync(registry)).toEqual(registryBefore)
      expect((await page.evaluate(() => window.dbCommander.checkSqlFiles())).files).toEqual([])
    }
    await expect(page.getByRole('button', { name: 'Retry workspace save', exact: true })).toBeVisible()
    volume.release()
    await page.getByRole('button', { name: 'Retry workspace save', exact: true }).click()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible(); await expectStored(page, failed.pending)
    await expect(page.getByRole('button', { name: 'Retry workspace save', exact: true })).toHaveCount(0)
    await page.clock.resume()
    await close(app); app = undefined
    launched = await launch(directory); app = launched.app
    await expectStored(launched.page, failed.pending)
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
    await expect(launched.page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    const db = new DatabaseSync(join(directory, 'workspace.sqlite')); let integrity: unknown
    try { integrity = db.prepare('PRAGMA quick_check').get() } finally { db.close() }
    expect(integrity).toEqual({ quick_check: 'ok' })
    const report = info.outputPath('workspace-disk-full.json'); writeFileSync(report, JSON.stringify({ ...full, runtimeProfileOutsideVolume: !wholeProfile, committedSQLPreserved: true, failedAfterEdits: failed.attempts, rescuedCharacters: failed.pending.length, retriedCharacters: failed.pending.length, integrity }, null, 2))
    await info.attach('workspace-disk-full.json', { path: report, contentType: 'application/json' })
  } finally { await close(app); volume.dispose() }
})

test('workspace disk full reopens committed SQL despite expired history maintenance and saves after repair', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real workspace exhaustion uses a bounded macOS disk image.')
  test.setTimeout(120000)
  const volume = diskFullFixture(), directory = workspaceDirectory(volume)
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    const baseline = 'SELECT recovered_while_still_full;'
    await enter(launched.page, baseline); await expect.poll(() => stored(launched.page)).toBe(baseline)
    await close(app); app = undefined
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
    try {
      const add = db.prepare('INSERT INTO history(id,connection,sql,status,startedAt,durationMs) VALUES(?,?,?,?,?,?)')
      db.exec('BEGIN')
      for (let index = 0; index < 200; index++) add.run(`expired-${index}`, 'Disk fixture', 'SELECT ' + 'x'.repeat(8192), 'completed', '2000-01-01', 1)
      db.prepare('INSERT INTO library_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify({ enabled: true, maxEntries: 500, maxAgeDays: 1, keepFavorites: true }))
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    // Leave room for SQLite's control files; the 1.6 MiB cleanup still hits FULL.
    const full = volume.fill(128 * 1024)
    launched = await launch(directory); app = launched.app
    await expect.poll(() => stored(launched.page)).toBe(baseline)
    expect((await launched.page.evaluate(() => window.dbCommander.loadWorkspace()))?.recoveryNotice).toContain('history cleanup')
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText('recovered_while_still_full')
    await expect(launched.page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    expect((await launched.page.evaluate(() => window.dbCommander.history())).length).toBeGreaterThan(0)
    volume.release()
    // Saving a profile also writes the internally loaded workspace. Recovery
    // notices must not leak into that strictly validated persistence contract.
    await launched.page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    const form = launched.page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByLabel('Connection name').fill('Recovered workspace')
    await form.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(form).toHaveCount(0)
    expect((await launched.page.evaluate(() => window.dbCommander.loadWorkspace()))?.profiles.map(profile => profile.config.name)).toEqual(['Recovered workspace'])
    await enter(launched.page, latest)
    if (await launched.page.getByRole('button', { name: 'Retry workspace save', exact: true }).count()) await launched.page.getByRole('button', { name: 'Retry workspace save', exact: true }).click()
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    expect(await stored(launched.page)).toBe(latest)
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
    expect((await launched.page.evaluate(() => window.dbCommander.loadWorkspace()))?.recoveryNotice).toBeUndefined()
    await close(app); app = undefined
    launched = await launch(directory); app = launched.app
    await expect.poll(() => stored(launched.page)).toBe(latest)
    const report = info.outputPath('workspace-full-restart.json'); writeFileSync(report, JSON.stringify({ ...full, expiredHistoryRows: 200, recoveredSQL: baseline, retriedCharacters: latest.length }, null, 2))
    await info.attach('workspace-full-restart.json', { path: report, contentType: 'application/json' })
  } finally { await close(app); volume.dispose() }
})

for (const wholeProfile of [false, true]) test(`workspace disk full ${wholeProfile ? 'whole profile ' : ''}explains zero-space startup failure and recovers after space is freed`, async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real workspace exhaustion uses a bounded macOS disk image.')
  test.setTimeout(120000)
  const volume = diskFullFixture(), directory = wholeProfile ? join(volume.mount, 'profile') : workspaceDirectory(volume)
  if (wholeProfile) mkdirSync(directory)
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    const baseline = 'SELECT kept_during_zero_space_startup;' + (wholeProfile ? '\n' + '-- large buffer\n'.repeat(60_000) : '')
    if (wholeProfile) await paste(app, launched.page, baseline); else await enter(launched.page, baseline)
    await expectStored(launched.page, baseline)
    await close(app); app = undefined
    const file = join(wholeProfile ? directory : volume.mount, 'workspace.sqlite'), db = new DatabaseSync(file)
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() }
    const before = readFileSync(file), full = volume.fill()
    expect(full.availableBytes).toBe(0)
    launched = await launch(directory); app = launched.app
    await expect(launched.page.locator('.error-banner')).toContainText('workspace disk is full')
    await expect(launched.page.locator('.error-banner')).toContainText('reload')
    await expect(launched.page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await expect(launched.page.getByText('Workspace not loaded', { exact: true })).toBeVisible()
    await expect(launched.page.getByRole('textbox', { name: 'SQL editor', exact: true })).toHaveJSProperty('readOnly', true)
    expect(readFileSync(file)).toEqual(before)
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }))
    expect(paths).toEqual({ userData: directory, sessionData: directory })
    await launched.page.screenshot({ path: info.outputPath('workspace-zero-space-startup.png') })
    volume.release()
    await launched.page.reload()
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(launched.page.getByRole('textbox', { name: 'SQL editor', exact: true })).toHaveJSProperty('readOnly', false)
    await expectStored(launched.page, baseline)
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText('kept_during_zero_space_startup')
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
    await expect(launched.page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    const report = info.outputPath('workspace-zero-space-startup.json')
    writeFileSync(report, JSON.stringify({ ...full, runtimeProfileOutsideVolume: !wholeProfile, databaseBytesPreserved: true, recoveredCharacters: baseline.length, noSQLReplay: true }, null, 2))
    await info.attach('workspace-zero-space-startup.json', { path: report, contentType: 'application/json' })
  } finally { await close(app); volume.dispose() }
})

test('workspace large buffer pastes, edits, undo and restart remain responsive', async ({}, info) => {
  test.setTimeout(90000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-large-buffer-'))
  let app: ElectronApplication | undefined
  const samples: { characters: number; pasteMs: number; editAndSaveMs?: number }[] = []
  try {
    let launched = await launch(directory); app = launched.app
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    let expected = ''
    for (const { name, sql: text } of largeBuffers) {
      await test.step(`Paste ${name}: ${text.length} characters`, async () => {
        const start = performance.now()
        await paste(app!, launched.page, text)
        samples.push({ characters: text.length, pasteMs: performance.now() - start })
        await expectStored(launched.page, text)
        await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
        expect(performance.now() - start).toBeLessThan(10000)
      }, { timeout: 15000 })
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control', suffix = 'x'
      const started = performance.now()
      await launched.page.keyboard.press(suffix)
      expected = text + suffix
      await expectStored(launched.page, expected)
      samples.at(-1)!.editAndSaveMs = performance.now() - started
      expect(samples.at(-1)!.editAndSaveMs).toBeLessThan(5000)
      await launched.page.keyboard.press(`${modifier}+Z`)
      await expectStored(launched.page, text)
      await launched.page.keyboard.press(`${modifier}+Shift+Z`)
      await expectStored(launched.page, expected)
    }
    await close(app); app = undefined
    launched = await launch(directory); app = launched.app
    await expect(launched.page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expectStored(launched.page, expected)
    expect(await launched.page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally {
    const report = info.outputPath('large-buffer.json'); writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, paste: 'native clipboard command', maxPasteAndSaveMs: 10000, maxEditAndSaveMs: 5000, samples }, null, 2))
    await info.attach('large-buffer.json', { path: report, contentType: 'application/json' })
    await close(app); rmSync(directory, { recursive: true, force: true })
  }
})
