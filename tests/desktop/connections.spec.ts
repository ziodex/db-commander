import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('SQL Server and Azure connection controls, defaults and secret isolation', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-connections-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  try {
    const page = await application.firstWindow()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlserver')
    await expect(form.getByLabel('Port', { exact: true })).toHaveValue('1433')
    await expect(form.getByLabel('Password', { exact: true })).toBeVisible()
    await form.getByLabel('Transport security').selectOption('disable')
    await form.getByLabel('Database engine').selectOption('azure-sql')
    await expect(form.getByLabel('Port', { exact: true })).toHaveValue('1433')
    await expect(form.getByLabel('Transport security')).toHaveValue('verify-full')
    await expect(form.getByLabel('Transport security')).toBeDisabled()
    await form.getByLabel('Authentication').selectOption('entra-token')
    await expect(form.getByLabel('Password', { exact: true })).toHaveCount(0)
    await form.getByLabel('Access token', { exact: true }).fill('never-store-this-token')
    await page.screenshot({ path: testInfo.outputPath('azure-connection.png') })
    await form.getByLabel('Authentication').selectOption('sql-password')
    await form.getByLabel('Authentication').selectOption('entra-token')
    await expect(form.getByLabel('Access token', { exact: true })).toHaveValue('')
    await form.getByLabel('Access token', { exact: true }).fill('never-store-this-token')
    await form.getByLabel('Database engine').selectOption('sqlserver')
    await expect(form.getByLabel('Access token', { exact: true })).toHaveCount(0)
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from('never-store-this-token'))).toBe(false)
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }) }
})
