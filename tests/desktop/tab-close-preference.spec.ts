import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('tab-close confirmation can be disabled without bypassing connection and transaction checks', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-tab-close-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow(), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  const confirmation = page.getByRole('dialog', { name: 'Close query tab', exact: true })
  const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
  const checkbox = preferences.getByRole('checkbox', { name: 'Confirm before closing a tab', exact: true })
  const tab = (name: string) => page.getByRole('tab', { name, exact: true })
  const close = (name: string) => page.getByRole('button', { name: `Close ${name}`, exact: true }).click()
  async function settings() {
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    await preferences.getByRole('tab', { name: 'Tabs', exact: true }).click()
  }
  async function run(sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
    await close('Untitled.sql'); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Keep tab', exact: true }).click()
    await settings(); await expect(checkbox).toBeChecked(); await checkbox.uncheck()
    await preferences.getByRole('button', { name: 'Cancel', exact: true }).click()
    await close('Untitled.sql'); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Keep tab', exact: true }).click()
    await settings(); await expect(checkbox).toBeChecked(); await checkbox.uncheck()
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(info.outputPath('tab-close-preference.png'), screenshot, 'base64')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).toBeHidden()

    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb')
    await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).toBeHidden()
    await run("CREATE TEMP TABLE kept_connection AS SELECT 'Still connected' AS message")
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(tab('Query 2.sql')).toHaveAttribute('aria-selected', 'true')
    // An inactive owner closes directly, leaving the active tab's live session intact.
    await close('Untitled.sql'); await expect(tab('Untitled.sql')).toHaveCount(0)
    await expect(confirmation).toHaveCount(0)
    await expect(tab('Query 2.sql')).toHaveAttribute('aria-selected', 'true')
    await run('SELECT message FROM kept_connection')
    await expect(page.getByRole('cell', { name: 'Still connected', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await close('Query 2.sql')
    await expect(page.getByText('Commit or roll back this tab’s transaction before closing it.', { exact: true })).toBeVisible()
    await expect(tab('Query 2.sql')).toBeVisible(); await expect(confirmation).toHaveCount(0)
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await close('Query 2.sql'); await expect(tab('Query 2.sql')).toHaveCount(0)
    await expect(tab('Untitled.sql')).toHaveAttribute('aria-selected', 'true')
    await expect(confirmation).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()

    await settings(); await expect(checkbox).not.toBeChecked()
    await preferences.getByRole('button', { name: 'Reset defaults', exact: true }).click()
    await expect(checkbox).toBeChecked()
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await close('Untitled.sql'); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(confirmation).toBeHidden(); await expect(tab('Untitled.sql')).toBeVisible()
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
