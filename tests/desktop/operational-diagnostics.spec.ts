import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'
import { execFileSync } from 'node:child_process'
import type { ConnectionConfig } from '../../src/shared/contracts'

async function launch(root: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(root, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  return { app, page: await app.firstWindow() }
}

async function capture(app: ElectronApplication, file: string) {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    return (await contents.capturePage()).toPNG().toString('base64')
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

async function openActivity(page: Page) {
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('button', { name: 'Sessions and locks', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sessions and locks', exact: true })
  await expect(dialog.getByRole('status')).toHaveText('Inspection complete. No session was changed.', { timeout: 30000 })
  return dialog
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Operation history', exact: true }).click()
  return page.getByRole('dialog', { name: 'Operation history', exact: true })
}

async function appearance(page: Page, app: ElectronApplication, theme: 'light' | 'dark', zoom: number) {
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
  const preferences = page.getByRole('dialog')
  await preferences.getByLabel('Appearance', { exact: true }).selectOption(theme)
  await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
  await expect(preferences).toBeHidden()
  await app.evaluate(({ BrowserWindow }, zoom) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(1100, 780)
    window.webContents.setZoomFactor(zoom)
  }, zoom)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1100 / zoom))
}

async function enter(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor').first(), input = editor.locator('textarea.inputarea')
  await expect(input).toBeEditable()
  await editor.click()
  await expect(input).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(sql)
  await page.keyboard.press('Escape')
}

for (const [theme, zoom] of [['dark', 1.25], ['light', 2]] as const) test(`A3 operations ${theme}: performance, unsupported scheduler and live private history`, async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'dbc-a3-ui-'))
  let app: ElectronApplication | undefined
  try {
    const opened = await launch(root); app = opened.app
    const { page } = opened
    await waitForWorkspaceReady(page)
    await appearance(page, app, theme, zoom)
    let history = await openHistory(page)
    await expect(history).toContainText('No operations have been recorded')
    await capture(app, info.outputPath('history-empty.png'))
    await history.getByRole('button', { name: 'Close operation history' }).click()

    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden()
    const run = page.getByRole('button', { name: /^Run SQL/ })
    await enter(page, "SELECT 'private_a3_value' AS label")
    await run.click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(run).toBeEnabled()

    const activity = await openActivity(page)
    const performance = activity.getByRole('button', { name: 'Performance', exact: true })
    await performance.focus()
    await page.keyboard.press('Enter')
    await expect(activity.getByRole('row').filter({ hasText: 'Connections open' })).toBeInViewport({ ratio: 0.9 })
    await expect(performance).toBeFocused()
    await expect(activity).toContainText('Engine-wide performance counters')
    await expect(activity).not.toContainText('private_a3_value')
    expect(await activity.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await capture(app, info.outputPath('performance.png'))
    await activity.getByRole('button', { name: 'Jobs and schedules', exact: true }).click()
    await expect(activity).toContainText('no server job scheduler')
    await expect(activity.getByRole('button', { name: 'Refresh schedules' })).toHaveCount(0)
    await capture(app, info.outputPath('scheduler-unsupported.png'))
    await activity.getByRole('button', { name: 'Close session inspection' }).click()
    await expect(page.locator('.results-region')).toContainText('private_a3_value')

    // Execute a real long-running native statement, then kill only this fixture's host.
    // The operation feed must stay visible, label the interrupted work and never replay it.
    await enter(page, 'WITH RECURSIVE n(v) AS (VALUES(0) UNION ALL SELECT v+1 FROM n WHERE v<1000000000) SELECT SUM(v) FROM n')
    await run.click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
    history = await openHistory(page)
    const running = history.getByRole('row').filter({ hasText: 'Query execution' }).first()
    await expect(running).toContainText('Running')
    await expect(running).toBeInViewport({ ratio: 0.9 })
    await expect(history.getByRole('columnheader', { name: 'Progress', exact: true })).toBeInViewport({ ratio: 0.95 })
    await capture(app, info.outputPath('history-running.png'))
    await app.evaluate(({ app }) => {
      const hosts = app.getAppMetrics().filter(item => item.name === 'Db Commander database host')
      if (hosts.length !== 1) throw new Error('Expected one owned database host.')
      process.kill(hosts[0].pid, 'SIGKILL')
    })
    await expect(history).toContainText('Outcome unknown')
    await expect(history).not.toContainText('private_a3_value')
    await expect(history).not.toContainText('WITH RECURSIVE')
    await history.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('unknown')
    await expect(history.getByRole('row')).toHaveCount(2)
    await capture(app, info.outputPath('history-unknown.png'))
    await history.getByRole('button', { name: 'Close operation history' }).click()
    await expect(run).toBeDisabled()
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('A3 scheduler SQL Server: reviewed state change, permission boundary and operation receipt', async ({}, info) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlserver'), 'Requires the disposable native TDS fixture')
  const root = mkdtempSync(join(tmpdir(), 'dbc-a3-agent-ui-'))
  const config: ConnectionConfig = { engine: 'sqlserver', name: 'Scheduler test', host: 'localhost',
    port: Number(process.env.SQLCOMMANDER_SQLSERVER_PORT), database: 'dbcommander',
    user: 'sa', password: 'Local-SA-Only!2026', tls: 'verify-full', ca: readFileSync(process.env.SQLCOMMANDER_SQLSERVER_CA!, 'utf8') }
  const project = process.env.SQLCOMMANDER_TEST_PROJECT, job = 'dbc_a3_native_review'
  if (!project || !/^dbcommander-test-\d+$/.test(project)) throw new Error('Scheduler test requires the isolated Docker runner.')
  const container = execFileSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=sqlserver',
    '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10000 }).trim()
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Expected one disposable SQL Server container.')
  const admin = (sql: string) => execFileSync('docker', ['exec', container, '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost',
    '-U', config.user, '-P', config.password, '-C', '-b', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${sql}`],
    { encoding: 'utf8', timeout: 30000 }).trim()
  let app: ElectronApplication | undefined
  try {
    admin(`EXEC msdb.dbo.sp_add_job @job_name=N'${job}',@enabled=0;
      EXEC msdb.dbo.sp_add_jobstep @job_name=N'${job}',@step_name=N'Private action',@subsystem=N'TSQL',@command=N'SELECT 987654321';
      EXEC msdb.dbo.sp_add_jobserver @job_name=N'${job}';`)
    const opened = await launch(root); app = opened.app
    const { page } = opened
    await waitForWorkspaceReady(page)
    await appearance(page, app, 'light', 1.25)
    async function connect(user: string, password: string) {
      await page.getByRole('button', { name: 'Connect database', exact: true }).click()
      const form = page.getByRole('dialog')
      await form.getByLabel('Database engine').selectOption('sqlserver')
      await form.getByLabel('Port', { exact: true }).fill(String(config.port))
      await form.getByLabel('Database', { exact: true }).fill(config.database)
      await form.getByLabel('User', { exact: true }).fill(user)
      await form.getByLabel('Password', { exact: true }).fill(password)
      await form.getByText('Custom CA certificate', { exact: true }).click()
      await form.getByLabel('CA certificate PEM').fill(config.ca!)
      await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(form).toBeHidden()
      await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    }
    await connect('dbcommander', 'Local-Test-Only!2026')
    let activity = await openActivity(page)
    await activity.getByRole('button', { name: 'Jobs and schedules', exact: true }).click()
    await expect(activity.getByRole('alert')).toContainText('catalog could not be read')
    await capture(app, info.outputPath('scheduler-unavailable.png'))
    await activity.getByRole('button', { name: 'Close session inspection' }).click()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()

    await connect(config.user, config.password)
    activity = await openActivity(page)
    await activity.getByRole('button', { name: 'Jobs and schedules', exact: true }).click()
    await expect(activity.getByRole('row').filter({ hasText: job })).toContainText('Disabled')
    await expect(activity).not.toContainText('987654321')
    await capture(app, info.outputPath('scheduler-list.png'))
    const review = activity.getByRole('button', { name: `Review enable ${job}` })
    await review.focus()
    await page.keyboard.press('Enter')
    await expect(activity.getByRole('heading', { name: `Enable job ${job}` })).toBeFocused()
    const confirmation = activity.getByLabel('Confirmation', { exact: true })
    await expect(confirmation).toHaveAccessibleDescription('Type ENABLE to apply. Reviews expire after one minute.')
    const apply = activity.getByRole('button', { name: 'Enable scheduling', exact: true })
    await expect(apply).toBeDisabled()
    await activity.getByRole('checkbox').check()
    await confirmation.fill('ENABLE')
    await expect(apply).toBeEnabled()
    await expect(apply).toBeInViewport({ ratio: 0.95 })
    await expect(activity.getByRole('button', { name: 'Back to schedules' })).toBeInViewport({ ratio: 0.95 })
    await capture(app, info.outputPath('scheduler-review.png'))
    await apply.click()
    await expect(activity.getByRole('status')).toContainText('confirmed the new enabled state')
    await expect(activity.getByRole('button', { name: 'Refresh schedules' })).toBeFocused()
    await capture(app, info.outputPath('scheduler-completed.png'))
    const enabled = admin(`SELECT CONVERT(varchar(12),enabled) FROM msdb.dbo.sysjobs WHERE name=N'${job}'`)
    expect(enabled).toBe('1')

    await page.clock.install()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(550)
    await activity.getByRole('button', { name: 'Refresh schedules' }).click()
    await activity.getByRole('button', { name: `Review disable ${job}` }).click()
    const disable = activity.getByRole('button', { name: 'Disable scheduling', exact: true })
    await activity.getByRole('checkbox').check()
    await confirmation.fill('DISABLE')
    await expect(disable).toBeEnabled()
    await expect(disable).toBeInViewport({ ratio: 0.95 })
    await capture(app, info.outputPath('scheduler-review-zoom200.png'))
    await page.clock.fastForward(61000)
    await expect(activity.getByRole('alert')).toContainText('This review expired')
    await expect(disable).toBeDisabled()
    await expect(activity.getByRole('button', { name: 'Back to schedules' })).toBeInViewport({ ratio: 0.95 })
    await expect(activity.getByRole('alert')).toBeInViewport({ ratio: 0.95 })
    await capture(app, info.outputPath('scheduler-expired-zoom200.png'))
    await activity.getByRole('button', { name: 'Back to schedules' }).click()
    expect(admin(`SELECT CONVERT(varchar(12),enabled) FROM msdb.dbo.sysjobs WHERE name=N'${job}'`)).toBe('1')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
    await activity.getByRole('button', { name: 'Close session inspection' }).click()
    const history = await openHistory(page)
    await expect(history.getByRole('row').filter({ hasText: 'Scheduler change' })).toContainText('Completed')
    await capture(app, info.outputPath('scheduler-history.png'))
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    try { admin(`IF EXISTS(SELECT 1 FROM msdb.dbo.sysjobs WHERE name=N'${job}') EXEC msdb.dbo.sp_delete_job @job_name=N'${job}';`) }
    finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  }
})

test('A3 operations combines original backup jobs and transfers while honoring query privacy', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'dbc-a3-history-'))
  let app: ElectronApplication | undefined
  try {
    const opened = await launch(root); app = opened.app
    const { page } = opened
    await waitForWorkspaceReady(page)
    const setup = await page.evaluate(async ({ archive, exported }) => {
      const api = window.dbCommander
      const config = { engine: 'sqlite' as const, name: 'private_connection', host: 'local', port: 1, user: 'local', database: 'main', password: '',
        tls: 'disable' as const, sqliteMode: 'memory' as const }
      async function execute(sessionId: string) {
        const completed = new Promise<string>(resolve => {
          const off = api.onEvent(event => {
            if (event.type === 'complete' && event.sessionId === sessionId) { off(); resolve(event.status) }
          })
        })
        await api.run({ sessionId, sql: "SELECT 'private_sql_value'", maxRows: 1 })
        return completed
      }
      const privateSession = await api.connect({ ...config, recordHistory: false })
      const profilePrivate = await execute(privateSession.id)
      await api.disconnect(privateSession.id)
      const session = await api.connect(config)
      const previous = await api.historySettings()
      await api.saveHistorySettings({ ...previous, enabled: false })
      const globallyPrivate = await execute(session.id)
      await api.saveHistorySettings(previous)
      const backup = await api.startBackup({ sessionId: session.id, action: 'backup', artifact: archive, content: 'all', confirmed: true })
      // Wait for authoritative job settlement before reserving the same owner again.
      let finished: Awaited<ReturnType<typeof api.backupJobs>>[number] | undefined
      await new Promise<void>((resolve, reject) => {
        const off = api.onBackupJob(job => { if (job.id === backup.id && job.status !== 'running') { finished = job; off(); resolve() } })
        void api.backupJobs().then(jobs => {
          const latest = jobs.find(job => job.id === backup.id && job.status !== 'running')
          if (latest) { finished = latest; off(); resolve() }
        }, error => { off(); reject(error) })
      })
      const transfer = await api.startTransfer({ sessionId: session.id, action: 'export', sql: 'SELECT 2 UNION ALL SELECT 3',
        file: exported, format: 'csv', confirmed: true })
      return { backup: finished?.status, profilePrivate, globallyPrivate, transfer: transfer.id }
    }, { archive: join(root, 'private_archive.sqlite'), exported: join(root, 'private_export.csv') })
    expect(setup).toMatchObject({ backup: 'completed', profilePrivate: 'completed', globallyPrivate: 'completed' })
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    const history = await openHistory(page)
    await expect(history.getByRole('row').filter({ hasText: 'Export data' })).toContainText('2 rows processed')
    await expect(history.getByRole('row').filter({ hasText: 'Export data' })).toContainText('Completed')
    await expect(history.getByRole('row').filter({ hasText: 'Backup' })).toContainText('Completed')
    await expect(history.getByRole('row').filter({ hasText: 'Query execution' })).toHaveCount(0)
    await expect(history).not.toContainText('private_')
    const entries = await page.evaluate(() => window.dbCommander.operationHistory())
    expect(entries.map(entry => entry.kind).sort()).toEqual(['backup', 'export'])
    expect(JSON.stringify(entries)).not.toContain('private_')
    await capture(app, info.outputPath('history-mixed.png'))
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const method = 'sql:operationHistory'
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]> })._invokeHandlers.get(method)
      if (!original) throw new Error('History handler is missing.')
      ipcMain.removeHandler(method)
      ipcMain.handle(method, () => {
        ipcMain.removeHandler(method)
        ipcMain.handle(method, original)
        throw new Error('Injected history read error')
      })
      BrowserWindow.getAllWindows()[0].webContents.send('sql:operation-history-changed')
    })
    await expect(history.getByRole('alert')).toContainText('could not be refreshed')
    await expect(history.getByRole('table')).toHaveCount(0)
    await capture(app, info.outputPath('history-read-error.png'))
    await history.getByRole('button', { name: 'Retry history' }).press('Enter')
    await expect(history.getByRole('row').filter({ hasText: 'Export data' })).toContainText('2 rows processed')
    await expect(history.getByRole('button', { name: 'Close operation history' })).toBeFocused()
    await history.getByRole('button', { name: 'Open job details' }).click()
    const details = page.getByRole('dialog', { name: 'Database backup and restore', exact: true })
    await expect(details.getByRole('heading', { name: 'Backup and restore job', exact: true })).toBeVisible()
    await expect(details).toContainText('private_archive.sqlite')
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
