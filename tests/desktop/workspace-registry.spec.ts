import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { constants, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_PROFILE, type Workspace } from '../../src/shared/contracts'

for (const kind of ['fifo', 'invalid-utf8'] as const) test(`workspace registry recovery ${kind}: preserves both workspaces, opens primary and recovers after explicit repair`, async ({}, info) => {
  test.skip(kind === 'fifo' && process.platform === 'win32', 'POSIX named pipes are not ordinary Windows files.')
  test.setTimeout(60_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-registry-recovery-')), secondaryId = randomUUID(), file = join(directory, 'windows.json')
  const primarySql = 'SELECT retained_primary_window;', secondarySql = 'SELECT retained_secondary_window;'
  const seed = (root: string, sql: string) => {
    const store = new WorkspaceStore(join(root, 'workspace.sqlite')), id = randomUUID()
    const workspace: Workspace = { version: 2, activeTabId: id, profiles: [], tabs: [{ id, title: 'Recovered.sql', sql, profile: DEFAULT_PROFILE }] }
    try { store.save(workspace) } finally { store.close() }
  }
  seed(directory, primarySql); seed(join(directory, 'windows', secondaryId), secondarySql)
  const original = Buffer.from(JSON.stringify([{ id: 'primary', name: 'Primary' }, { id: secondaryId, name: 'Analysis Ω' }]))
  const damaged = Buffer.from(original); damaged[damaged.indexOf(Buffer.from('Ω'))] = 0xff
  if (kind === 'fifo') execFileSync('mkfifo', [file]); else writeFileSync(file, damaged)
  const secondaryFile = join(directory, 'windows', secondaryId, 'workspace.sqlite'), secondaryBytes = readFileSync(secondaryFile)
  let app: ElectronApplication | undefined
  async function launch() {
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow({ timeout: 5000 })
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    return page
  }
  async function close() { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); app = undefined }
  try {
    let primary = await launch()
    expect((await primary.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(primarySql)
    await expect(primary.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await primary.getByRole('button', { name: 'Workspace', exact: true }).click()
    await primary.getByRole('menuitem', { name: 'Workspace windows', exact: true }).click()
    const dialog = primary.getByRole('dialog', { name: 'Workspace windows', exact: true })
    await expect(dialog.getByRole('alert')).toContainText('saved workspaces have been kept')
    await expect(dialog.getByRole('button', { name: 'Create window', exact: true })).toBeDisabled()
    await expect(primary.evaluate(id => window.dbCommander.openWorkspaceWindow(id), secondaryId)).rejects.toThrow('saved workspaces have been kept')
    if (kind === 'fifo') expect(lstatSync(file).isFIFO()).toBe(true); else expect(readFileSync(file)).toEqual(damaged)
    expect(readFileSync(secondaryFile)).toEqual(secondaryBytes)
    await primary.screenshot({ path: info.outputPath(`${kind}-registry-preserved.png`) })
    expect(await primary.evaluate(() => window.dbCommander.history())).toEqual([])
    await close()
    // Repair is explicit and takes effect on restart; neither workspace is reset.
    unlinkSync(file); writeFileSync(file, original)
    primary = await launch()
    expect((await primary.evaluate(() => window.dbCommander.workspaceWindows())).windows).toHaveLength(2)
    const opened = app!.waitForEvent('window')
    await primary.evaluate(id => window.dbCommander.openWorkspaceWindow(id), secondaryId)
    const secondary = await opened
    await expect(secondary.getByText('Saved locally', { exact: true })).toBeVisible()
    expect((await secondary.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(secondarySql)
    expect((await primary.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(primarySql)
    for (const page of [primary, secondary]) {
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    }
    writeFileSync(info.outputPath(`${kind}-registry-recovery.json`), JSON.stringify({ platform: process.platform, kind, primaryRecovered: true, secondaryPreservedHash: createHash('sha256').update(secondaryBytes).digest('hex'), explicitRepairRecoveredBoth: true, noSqlReplay: true }, null, 2))
  } finally {
    // Let the old blocked reader finish when reproducing the startup regression.
    if (kind === 'fifo' && lstatSync(file).isFIFO()) { const drain = await open(file, constants.O_RDWR | constants.O_NONBLOCK); await drain.writeFile('[]'); await drain.close() }
    await close(); rmSync(directory, { recursive: true, force: true })
  }
})
