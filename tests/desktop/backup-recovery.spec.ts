import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openBackup } from './explorer-actions'
import { diskFullFixture } from './disk-full-fixture'
import { DatabaseSync } from 'node:sqlite'

async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    return { app, page }
  } catch (error) { await app.close().catch(() => {}); throw error }
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite')
  await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Save connection profile').uncheck()
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
  await page.evaluate(() => {
    window.dbCommander.onEvent(event => { if (event.type === 'complete') (window as any).__backupSession = event.sessionId })
    ;(window as any).__backupUpdates = []
    window.dbCommander.onBackupJob(job => (window as any).__backupUpdates.push({ id: job.id, status: job.status }))
  })
  await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText("CREATE TABLE preserved(value); INSERT INTO preserved VALUES('committed');")
  await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
}
async function backup(page: Page, file: string) {
  const job = await page.evaluate(artifact => window.dbCommander.startBackup({ sessionId: (window as any).__backupSession, action: 'backup', artifact, content: 'all', confirmed: true }), file)
  await expect.poll(async () => (await page.evaluate(() => window.dbCommander.backupJobs())).find(item => item.id === job.id)?.status).toBe('completed')
  expect(existsSync(file)).toBe(true)
  return job
}
async function close(app: ElectronApplication | undefined) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }

test('backup recovery: delayed history failures preserve completed status and retry without replay', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-backup-history-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await connect(page)
    // Hold only journal publication; the real SQLite backup can finish normally.
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs/promises'), rename = fs.rename
      const control = { mode: 'hold', blocked: 0, releases: [] as (() => void)[] }
      ;(globalThis as any).__backupHistoryFault = control
      fs.rename = async (...args: Parameters<typeof rename>) => {
        if (control.mode !== 'pass' && String(args[1]).endsWith('backup-jobs.json')) {
          control.blocked++
          if (control.mode === 'fail') throw Object.assign(new Error('Injected journal publication failure'), { code: 'EACCES' })
          await new Promise<void>((_resolve, reject) => control.releases.push(() => reject(Object.assign(new Error('Injected journal publication failure'), { code: 'EACCES' }))))
        }
        return rename(...args)
      }
    })
    const first = await backup(page, join(directory, 'first.sqlite'))
    await openBackup(page); await page.locator('.backup-job-list button').click()
    await expect(page.locator('.backup-status')).toHaveText('completed')
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__backupHistoryFault.blocked)).toBe(1)
    await app.evaluate(() => (globalThis as any).__backupHistoryFault.releases.shift()())
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__backupHistoryFault.blocked)).toBe(2)
    expect(await page.evaluate(() => (window as any).__backupUpdates.at(-1).status)).toBe('completed')
    await expect(page.locator('.backup-status')).toHaveText('completed')
    // Fail the remaining queued saves, then require a visible warning on the
    // current job and after a renderer reload through the public jobs API.
    await app.evaluate(() => { const control = (globalThis as any).__backupHistoryFault; control.mode = 'fail'; control.releases.splice(0).forEach((release: () => void) => release()) })
    await expect(page.locator('.backup-job-detail').getByRole('alert')).toContainText('Job history could not be saved')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.screenshot({ path: info.outputPath('backup-history-failure.png') })
    await page.reload(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await openBackup(page); await page.locator('.backup-job-list button').click()
    await expect(page.locator('.backup-status')).toHaveText('completed'); await expect(page.locator('.backup-job-detail').getByRole('alert')).toContainText('Job history could not be saved')
    await app.evaluate(() => { (globalThis as any).__backupHistoryFault.mode = 'pass' })
    const artifact = readFileSync(join(directory, 'first.sqlite'))
    await page.getByRole('button', { name: 'Retry saving job history', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.backupJobs())).every(job => !job.historyError)).toBe(true)
    await expect.poll(() => { try { return JSON.parse(readFileSync(join(directory, 'backup-jobs.json'), 'utf8')).length } catch { return 0 } }).toBe(1)
    expect(readFileSync(join(directory, 'first.sqlite'))).toEqual(artifact)
    const history = await page.evaluate(() => window.dbCommander.history())
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    expect((await page.evaluate(() => window.dbCommander.backupJobs())).map(job => ({ id: job.id, status: job.status, historyError: job.historyError }))).toEqual([
      { id: first.id, status: 'completed', historyError: undefined }
    ])
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await expect(page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
  } finally {
    await app?.evaluate(() => { const control = (globalThis as any).__backupHistoryFault; if (control) { control.mode = 'pass'; control.releases.splice(0).forEach((release: () => void) => release()) } }).catch(() => {})
    await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const contents of ['{ damaged restore history', JSON.stringify({ version: 2, jobs: [{ status: 'running', target: 'never-replay' }] })]) test(`backup recovery: preserves ${contents.startsWith('{ damaged') ? 'damaged' : 'unsupported'} history during new jobs`, async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-backup-protection-')), file = join(directory, 'backup-jobs.json')
  writeFileSync(file, contents)
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await connect(page); await backup(page, join(directory, 'safe.sqlite'))
    await openBackup(page); await page.locator('.backup-job-list button').click()
    await expect(page.locator('.backup-status')).toHaveText('completed')
    await expect(page.locator('.backup-job-detail').getByRole('alert')).toContainText('kept intact')
    await page.getByRole('button', { name: 'Retry saving job history', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry saving job history', exact: true })).toBeEnabled()
    await expect(page.locator('.backup-job-detail').getByRole('alert')).toContainText('kept intact')
    expect(readFileSync(file, 'utf8')).toBe(contents)
    await page.screenshot({ path: info.outputPath('preserved-backup-history.png') })
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    expect(readFileSync(file, 'utf8')).toBe(contents)
    expect(await page.evaluate(() => window.dbCommander.backupJobs())).toEqual([])
    await expect(page.getByRole('button', { name: 'Connect database', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    expect(existsSync(join(directory, 'never-replay'))).toBe(false)
  } finally { await close(app); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('backup recovery: whole-profile disk full preserves committed journal and retries explicitly', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real ENOSPC uses a bounded private macOS disk image; publication fault checks are portable.')
  test.setTimeout(120_000)
  const volume = diskFullFixture(), directory = join(volume.mount, 'profile'), file = join(directory, 'backup-jobs.json')
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await connect(page)
    const first = await backup(page, join(volume.root, 'baseline.sqlite'))
    await expect.poll(() => existsSync(file)).toBe(true)
    await app.close(); app = undefined
    const before = readFileSync(file)
    launched = await launch(directory); app = launched.app; page = launched.page
    await connect(page)
    const full = volume.fill()
    const second = await backup(page, join(volume.root, 'disk-full.sqlite'))
    await openBackup(page); await page.locator('.backup-job-list button').first().click()
    await expect(page.locator('.backup-status')).toHaveText('completed')
    await expect(page.locator('.backup-job-detail').getByRole('alert')).toContainText('ENOSPC')
    expect(readFileSync(file)).toEqual(before)
    const snapshot = new DatabaseSync(join(volume.root, 'disk-full.sqlite'), { readOnly: true })
    try { expect(snapshot.prepare('SELECT value FROM preserved').all()).toEqual([{ value: 'committed' }]); expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' }) }
    finally { snapshot.close() }
    await page.screenshot({ path: info.outputPath('backup-profile-disk-full.png') })
    volume.release()
    const artifact = readFileSync(join(volume.root, 'disk-full.sqlite'))
    await page.getByRole('button', { name: 'Retry saving job history', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.backupJobs())).every(job => !job.historyError)).toBe(true)
    await expect(page.locator('.backup-job-detail').getByRole('alert')).toHaveCount(0)
    const history = await page.evaluate(() => window.dbCommander.history())
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    const jobs = await page.evaluate(() => window.dbCommander.backupJobs())
    expect(jobs.map(job => job.id)).toEqual([first.id, second.id])
    expect(readFileSync(join(volume.root, 'disk-full.sqlite'))).toEqual(artifact)
    expect(jobs.every(job => job.status === 'completed' && !job.historyError)).toBe(true)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    const report = info.outputPath('backup-profile-disk-full.json')
    writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, ...full, journalPreserved: true, artifactIntegrity: 'ok', jobs: jobs.map(({ id, status }) => ({ id, status })), noReplay: true }, null, 2))
    await info.attach('backup-profile-disk-full.json', { path: report, contentType: 'application/json' })
  } finally { await close(app); volume.dispose() }
})
