import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('packaged updates: Help checks metadata, opens the release page and persists dismissal', async () => {
  test.skip(!process.env.SQLCOMMANDER_TEST_EXECUTABLE, 'Requires a packaged application executable.')
  const profile = mkdtempSync(join(tmpdir(), 'dbcommander-packaged-updates-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE!), env: env as Record<string, string> })
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const page = await app.firstWindow(), banner = page.getByLabel('Application updates')
    await waitForWorkspaceReady(page)
    // Let the real startup request finish before replacing the network boundary.
    await expect.poll(() => page.evaluate(() => window.dbCommander.updateStatus()), { timeout: 15_000 }).toMatchObject({ checking: false })
    await app.evaluate(({ net, shell }) => {
      const fixture = { requests: [] as string[], opened: [] as string[] }
      ;(globalThis as any).packagedUpdateFixture = fixture
      net.fetch = async input => {
        fixture.requests.push(String(input))
        return new Response(JSON.stringify({ tag_name: 'v0.2.0', draft: false, prerelease: false }), { status: 200 })
      }
      shell.openExternal = async url => { fixture.opened.push(url) }
    })
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu()!, item = menu.getMenuItemById('check-for-updates')!
      if (!item.enabled || !menu.items.some(parent => parent.role === 'help' && parent.submenu?.items.some(child => child.id === item.id))) throw new Error('Help must expose Check for updates.')
      item.click(item, BrowserWindow.getFocusedWindow()!, {} as any)
    })
    await expect(banner).toContainText('Db Commander 0.2.0 is available.')
    await expect(banner).toContainText('Installation is manual.')
    await banner.getByRole('button', { name: 'Release notes & download' }).click()
    expect(await app.evaluate(() => (globalThis as any).packagedUpdateFixture)).toEqual({
      requests: ['https://api.github.com/repos/ziodex/db-commander/releases/latest'],
      opened: ['https://github.com/ziodex/db-commander/releases/tag/v0.2.0']
    })
    await banner.getByRole('button', { name: 'Dismiss update notification' }).click()
    await expect(banner).not.toBeVisible()
    const preferences = join(profile, 'update-settings.json')
    await expect.poll(() => existsSync(preferences) ? JSON.parse(readFileSync(preferences, 'utf8')).dismissedVersion : undefined).toBe('0.2.0')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
})
