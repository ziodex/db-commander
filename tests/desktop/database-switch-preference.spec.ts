import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionInfo } from '../../src/shared/contracts'

test('database-switch confirmation is optional while tab ownership, failure recovery and transaction guards stay intact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-switch-preference-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: env as Record<string, string> })
  const page = await app.firstWindow()
  const database = (name: string) => page.getByRole('button', { name: `Switch to database ${name}`, exact: true })
  const confirmation = page.getByRole('dialog', { name: 'Switch database', exact: true })
  const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
  const checkbox = preferences.getByRole('checkbox', { name: 'Confirm before switching databases', exact: true })
  async function settings() {
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    await preferences.getByRole('tab', { name: 'Tabs', exact: true }).click()
  }
  try {
    await waitForWorkspaceReady(page)
    // Deterministic server replies exercise renderer flow without requiring a local DB server.
    await app.evaluate(({ ipcMain }) => {
      const sessions = new Map<string, SessionInfo>(), control = globalThis as any
      control.switchCalls = []
      const handlers: Record<string, Parameters<typeof ipcMain.handle>[1]> = {
        connect(_event, config) {
          const session: SessionInfo = { ...config, id: crypto.randomUUID(), database: 'main', tls: false, transaction: 'idle', version: 'fixture' }
          sessions.set(session.id, session); return session
        },
        databases(_event, id) { return { current: sessions.get(id)!.database, databases: ['main', 'other', 'denied'], switchable: true } },
        schema(_event, id) { return { database: sessions.get(id)!.database, objects: [], source: 'session', fetchedAt: new Date().toISOString(), truncated: false } },
        async switchDatabase(_event, request) {
          control.switchCalls.push(request)
          if (request.database === 'denied') throw new Error('Access to the selected database was denied.')
          if (control.holdSwitch) await new Promise<void>(resolve => { control.releaseSwitch = resolve })
          const session = { ...sessions.get(request.sessionId)!, id: crypto.randomUUID(), database: request.database }
          sessions.set(session.id, session)
          if (!request.retainSource) sessions.delete(request.sessionId)
          return session
        },
        editGrid() { return {} },
        disconnect(_event, id) { sessions.delete(id) },
        run(event, request) {
          const session = sessions.get(request.sessionId)!
          session.transaction = request.sql === 'BEGIN' ? 'transaction' : 'idle'
          event.sender.send('sql:event', { type: 'complete', sessionId: session.id, queryId: request.queryId, transaction: session.transaction, status: 'completed', durationMs: 1 })
        }
      }
      for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(`sql:${name}`); ipcMain.handle(`sql:${name}`, handler) }
    })
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Connection name', { exact: true }).fill('Switch test')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden(); await expect(database('other')).toBeEnabled()
    await database('other').click(); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Keep current database', exact: true }).click()
    expect(await app.evaluate(() => (globalThis as any).switchCalls)).toHaveLength(0)
    await database('other').click()
    await confirmation.getByRole('button', { name: 'Switch database', exact: true }).click()
    await expect(confirmation).toBeHidden(); await expect(page.locator('.target-label')).toHaveText('other')
    await settings(); await expect(checkbox).toBeChecked(); await checkbox.uncheck()
    await preferences.getByRole('button', { name: 'Cancel', exact: true }).click()
    await database('main').click(); await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Keep current database', exact: true }).click()
    await settings(); await expect(checkbox).toBeChecked(); await checkbox.uncheck()
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()

    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await app.evaluate(() => { (globalThis as any).holdSwitch = true })
    await database('main').click()
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).releaseSwitch)).toBe('function')
    await expect(confirmation).toHaveCount(0)
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await app.evaluate(() => { (globalThis as any).holdSwitch = false; (globalThis as any).releaseSwitch() })
    await expect(page.locator('.target-label')).toHaveText('other')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.locator('.target-label')).toHaveText('main')
    const calls = await app.evaluate(() => (globalThis as any).switchCalls)
    expect(calls).toHaveLength(2); expect(calls[1]).toMatchObject({ database: 'main', retainSource: true })
    await database('denied').click()
    await expect(page.getByText('Access to the selected database was denied.', { exact: true })).toBeVisible()
    await expect(page.locator('.target-label')).toHaveText('main'); await expect(confirmation).toHaveCount(0)
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(database('other')).toBeDisabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await expect(database('other')).toBeEnabled()
    await settings(); await expect(checkbox).not.toBeChecked()
    await preferences.getByRole('button', { name: 'Reset defaults', exact: true }).click()
    await expect(checkbox).toBeChecked()
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await database('other').click(); await expect(confirmation).toBeVisible()
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
