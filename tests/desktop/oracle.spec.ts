import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Oracle desktop service connection, SQL, PL/SQL, transactions, cancellation and export', async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('oracle'), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-oracle-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  try {
    const page = await application.firstWindow()
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('oracle')
    await expect(form.getByLabel('Port', { exact: true })).toHaveValue('1521')
    await expect(form.getByLabel('Service name', { exact: true })).toHaveValue('FREEPDB1')
    await expect(form.getByText('Custom CA certificate', { exact: true })).not.toBeVisible()
    await form.getByLabel('Connection name').fill('Docker Oracle')
    await form.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_ORACLE_PORT!)
    await form.getByLabel('User', { exact: true }).fill('dbcommander')
    await form.getByLabel('Password', { exact: true }).fill('local-test-only')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.getByText('TLS verified', { exact: true })).toBeVisible()
    await expect(page.locator('.dialect-label')).toHaveText('Oracle Database')
    await expect(page.locator('.transaction-badge')).toHaveText('Manual commit mode')
    const customers = page.locator('.schema-list').getByRole('button', { name: 'CUSTOMERS DBCOMMANDER', exact: true })
    // Connection badges can render before Monaco applies the provider's SQL.
    await expect(page.locator('.monaco-editor')).toContainText("SYS_CONTEXT('USERENV', 'SERVICE_NAME')")
    const welcome = await page.locator('.monaco-editor').innerText()
    await customers.click(); expect(await page.locator('.monaco-editor').innerText()).toBe(welcome)
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace')
    await customers.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Append SELECT SQL for CUSTOMERS', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('FETCH FIRST 1000 ROWS ONLY')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible()
    const csvPath = join(directory, 'oracle.csv')
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csvPath)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
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
    await expect(page.locator('.transaction-badge')).toHaveText('Manual commit mode')
    await run("BEGIN DBMS_OUTPUT.PUT_LINE('Hello from Oracle'); END;\n/\nSELECT wide_int, precise FROM data_types;")
    await page.getByRole('button', { name: 'Result 2', exact: true }).click()
    await expect(page.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '12345678901234567890.123456789012345678', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('oracle-workbench.png') })
    await enter('SELECT sum(a.n+b.n+c.n) FROM numbers a CROSS JOIN numbers b CROSS JOIN numbers c;')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await run('SELECT n FROM numbers ORDER BY n;')
    await expect(page.getByText(/Preview limit reached/)).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.dbCommander.loadWorkspace())?.tabs[0]?.profile?.engine)).toBe('oracle')
    expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from('local-test-only'))).toBe(false)
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Disconnected')
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }) }
})
