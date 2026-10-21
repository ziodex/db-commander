import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { diskFullFixture } from './disk-full-fixture'
import type { ActivitySnapshot } from '../../src/shared/activity'

const snapshot: ActivitySnapshot = { engine: 'sqlite', database: 'local', currentSessionId: '1', scope: 'Private fixture', fetchedAt: '2026-10-18T00:00:00Z', includeSql: true, notices: [],
  sessions: { status: 'available', truncated: false, rows: Array.from({ length: 200 }, (_, id) => ({ id: String(id), user: null, database: null, application: null, client: null, state: null, command: null, ageSeconds: null, transaction: null, startedAt: null, wait: null, query: 'x'.repeat(4000), queryTruncated: false })) },
  locks: { status: 'unsupported', rows: [], truncated: false }, waits: { status: 'unsupported', rows: [], truncated: false } }

async function save(page: Page, kind: 'plan' | 'value' | 'activity', text: string) {
  return page.evaluate(async ({ kind, text, snapshot }) => {
    try {
      const file = kind === 'plan' ? await window.dbCommander.savePlan({ format: 'text', text }) : kind === 'value' ? await window.dbCommander.saveValue({ format: 'text', text }) : await window.dbCommander.saveActivity(snapshot)
      return { file, error: undefined }
    } catch (error) { return { file: undefined, error: String(error) } }
  }, { kind, text, snapshot })
}

for (const kind of ['plan', 'value', 'activity'] as const) test(`generated files ${kind}: real disk full preserves prior files, removes partial output and retries`, async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Real ENOSPC uses a bounded private macOS disk image; portable injected file faults run in the unit suite.')
  test.setTimeout(120_000)
  const volume = diskFullFixture(), directory = join(volume.root, 'profile'), destination = join(volume.mount, `${kind}.${kind === 'activity' ? 'json' : 'txt'}`)
  const previous = `Prior saved ${kind} Ω\n`, text = 'Ω'.repeat(500_000)
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const sql = 'SELECT never_executed_while_saving_generated_files;'
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql)
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0].sql)).toBe(sql)
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, destination)
    if (kind !== 'activity') writeFileSync(destination, previous)
    const full = volume.fill(128 * 1024), failed = await save(page, kind, text)
    expect(failed.error).toContain('ENOSPC')
    if (kind === 'activity') expect(existsSync(destination)).toBe(false)
    else expect(readFileSync(destination, 'utf8')).toBe(previous)
    expect(readdirSync(volume.mount).filter(name => name.startsWith('.dbcommander-'))).toEqual([])
    volume.release()
    const retried = await save(page, kind, text)
    expect(retried.error).toBeUndefined(); expect(retried.file).toBe(destination)
    const saved = readFileSync(destination, 'utf8')
    if (kind === 'activity') { expect(JSON.parse(saved)).toEqual(snapshot); expect(saved.endsWith('\n')).toBe(true) }
    else expect(saved).toBe(text)
    if (kind === 'activity') {
      expect((await save(page, kind, text)).error).toContain('EEXIST')
      expect(readFileSync(destination, 'utf8')).toBe(saved)
    }
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
    const report = info.outputPath(`${kind}-disk-full.json`)
    writeFileSync(report, JSON.stringify({ platform: process.platform, arch: process.arch, kind, ...full, previousPreserved: kind !== 'activity', failedNewFileAbsent: kind === 'activity', explicitRetry: true, finalBytes: Buffer.byteLength(readFileSync(destination, 'utf8')), noSqlReplay: true }, null, 2))
    await info.attach(`${kind}-disk-full.json`, { path: report, contentType: 'application/json' })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); volume.dispose()
  }
})
