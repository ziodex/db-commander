import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendTableSelect } from './explorer-actions'

for (const engine of ['sqlserver', 'azure-sql'] as const) test(`${engine} desktop connection, SQL, transaction state, cancellation and export`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlserver'), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), `dbcommander-${engine}-`))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await application.firstWindow()
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine)
    await expect(form.getByLabel('Port', { exact: true })).toHaveValue('1433')
    if (engine === 'azure-sql') {
      await expect(form.getByLabel('Transport security')).toBeDisabled()
      await form.getByLabel('Authentication').selectOption('entra-token')
      await form.getByLabel('Access token', { exact: true }).fill('private-test-token')
      await form.getByLabel('Authentication').selectOption('sql-password')
    }
    await form.getByLabel('Connection name').fill(`Docker ${engine}`)
    await form.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_SQLSERVER_PORT!)
    await form.getByLabel('Database', { exact: true }).fill('dbcommander')
    await form.getByLabel('User', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill('Local-Test-Only!2026')
    await form.getByText('Custom CA certificate', { exact: true }).click()
    await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_SQLSERVER_CA!, 'utf8'))
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.getByText('TLS verified', { exact: true })).toBeVisible()
    await expect(page.locator('.dialect-label')).toHaveText(engine === 'sqlserver' ? 'SQL Server' : 'Azure SQL')
    await appendTableSelect(page, 'customers')
    await expect(page.locator('.monaco-editor')).toContainText('[dbo].[customers]')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1250.50000000', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-workbench.png`) })
    const csvPath = join(directory, 'export.csv')
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csvPath)
    await page.getByRole('button', { name: 'Export preview', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported')
    expect(readFileSync(csvPath, 'utf8')).toContain('"Ada Lovelace"')
    async function enter(sql: string) {
      await page.locator('.monaco-editor').first().click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.insertText(sql)
    }
    async function run(sql: string) {
      await enter(sql)
      await page.getByRole('button', { name: /^Run SQL/ }).click()
      await expect(page.locator('.status-text')).toHaveText('Completed')
    }
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run('BEGIN TRANSACTION; CREATE TABLE dbo.desktop_transaction(id INT); ROLLBACK;');
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await enter("WAITFOR DELAY '00:00:30';")
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await run('SELECT TOP(2000) a.n FROM dbo.numbers a CROSS JOIN dbo.numbers b;')
    await expect(page.getByText(/Preview limit reached/)).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.profile?.engine)).toBe(engine)
    const stored = readFileSync(join(directory, 'workspace.sqlite'))
    expect(stored.includes(Buffer.from('Local-Test-Only!2026'))).toBe(false)
    expect(stored.includes(Buffer.from('private-test-token'))).toBe(false)
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }) }
})
