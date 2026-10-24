import { openSeparateQueryTab } from './separate-query-tab'
import { profileAction } from './profile-actions'
import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const engine of ['duckdb', 'postgres'] as const) test(`${engine} saved profiles and independent query tabs`, async ({}, testInfo) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-tabs-')), path = join(directory, 'tabs.duckdb')
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible(); return page
  }
  async function enter(page: Page, sql: string) {
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql)
  }
  async function run(page: Page, sql: string, status = 'Completed') {
    await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText(status)
  }
  try {
    let page = await launch()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption(engine)
    await form.getByLabel('Connection name').fill('Team database')
    if (engine === 'duckdb') {
      await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file', { exact: true }).fill(path)
    } else {
      await form.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_PG_PORT!)
      await form.getByLabel('Database', { exact: true }).fill('dbcommander'); await form.getByLabel('User', { exact: true }).fill('dbcommander')
      await form.getByLabel('Password', { exact: true }).fill('local-test-only')
      await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'))
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Team database in new tab', exact: true })).toBeVisible()
    await run(page, 'CREATE TEMP TABLE local_to_tab(n INT); INSERT INTO local_to_tab VALUES(1)')
    await openSeparateQueryTab(page, engine === 'postgres' ? 'local-test-only' : undefined)
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await run(page, 'UPDATE local_to_tab SET n=2; SELECT n FROM local_to_tab')
    await page.getByRole('button', { name: 'Result 2', exact: true }).click()
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Query 2.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.status-text')).toHaveText('Connected'); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    // Window close must see the transaction in the inactive first tab.
    await app!.evaluate(({ BrowserWindow, dialog }) => {
      ;(globalThis as any).tabClosePrompts = []
      dialog.showMessageBox = (async (_window: unknown, options: any) => {
        ;(globalThis as any).tabClosePrompts.push(options.message)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      BrowserWindow.getAllWindows()[0].close()
    })
    await expect.poll(() => app!.evaluate(() => (globalThis as any).tabClosePrompts)).toEqual(['Queries or transactions are still open in one or more tabs.'])
    await run(page, 'SELECT * FROM local_to_tab', 'Failed')
    await run(page, 'CREATE TEMP TABLE local_to_tab(n INT); INSERT INTO local_to_tab VALUES(20); SELECT n FROM local_to_tab')
    await page.getByRole('button', { name: 'Result 3', exact: true }).click()
    await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('UPDATE local_to_tab')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(page.getByRole('cell', { name: '2', exact: true })).toBeVisible()
    const csv = join(directory, 'tab-a.csv')
    await app!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, csv)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.locator('.status-text')).toHaveText('Fetched rows exported'); expect(readFileSync(csv, 'utf8')).toContain('"2"\r\n')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await enter(page, engine === 'duckdb' ? 'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b' : 'SELECT pg_sleep(30)')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Running')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await run(page, 'SELECT 777 AS owner'); await expect(page.getByRole('cell', { name: '777', exact: true })).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    // Reordering must not switch the active session, discard results or stop an inactive query.
    const firstTab=page.getByRole('tab',{name:'Untitled.sql',exact:true}),secondTab=page.getByRole('tab',{name:'Query 2.sql',exact:true})
    const order=()=>page.getByRole('tablist',{name:'Query tabs'}).getByRole('tab').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')))
    await firstTab.focus();await page.keyboard.press('Control+Shift+ArrowRight')
    await expect.poll(order).toEqual(['Query 2.sql','Untitled.sql'])
    await expect(firstTab).toHaveAttribute('aria-selected','true');await expect(page.getByRole('cell',{name:'777',exact:true})).toBeVisible()
    await firstTab.click({button:'right'});await page.getByRole('menuitem',{name:'Move tab to start',exact:true}).click()
    await expect.poll(order).toEqual(['Untitled.sql','Query 2.sql'])
    await secondTab.dragTo(firstTab,{targetPosition:{x:4,y:12}})
    await expect.poll(order).toEqual(['Query 2.sql','Untitled.sql'])
    await expect(firstTab).toHaveAttribute('aria-selected','true');await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(secondTab).toContainText('Running')
    // Pinning an inactive/running tab must keep the active transaction and results.
    await firstTab.click({button:'right'});await page.getByRole('menuitem',{name:'Pin tab',exact:true}).click()
    await secondTab.click({button:'right'});await page.getByRole('menuitem',{name:'Pin tab',exact:true}).click()
    await expect.poll(order).toEqual(['Untitled.sql','Query 2.sql'])
    await expect(firstTab).toHaveAttribute('aria-selected','true')
    await expect(page.getByRole('cell',{name:'777',exact:true})).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await expect(secondTab).toContainText('Running')
    await expect(page.getByRole('button',{name:'Close Query 2.sql',exact:true})).toHaveCount(0)
    await secondTab.focus();await page.keyboard.press('Control+Shift+Home')
    await expect.poll(order).toEqual(['Query 2.sql','Untitled.sql'])
    await firstTab.click({button:'right'});await page.getByRole('menuitem',{name:'Unpin tab',exact:true}).click()
    await secondTab.click({button:'right'});await page.getByRole('menuitem',{name:'Unpin tab',exact:true}).click()
    // After unpinning, the existing running-query and transaction guards still apply.
    await page.screenshot({ path: testInfo.outputPath(`${engine}-independent-tabs.png`) })
    await page.getByRole('button', { name: 'Close Query 2.sql', exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('Stop this tab'); await expect(page.getByRole('dialog')).not.toBeVisible()
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Cancelled')
    await run(page, 'SELECT n FROM local_to_tab'); await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close Untitled.sql', exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('Commit or roll back'); await expect(page.getByRole('dialog')).not.toBeVisible()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run(page, 'SELECT n FROM local_to_tab'); await expect(page.locator('[role="cell"][title="1"]')).toBeVisible()
    // Editing a profile must not mutate existing sessions or be undone by duplication.
    await profileAction(page, 'Team database', 'Edit')
    await page.getByRole('dialog').getByLabel('Connection name').fill('Renamed database')
    await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Renamed database in new tab', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Connected')
    await expect(page.getByRole('button', { name: 'Open Renamed database in new tab', exact: true })).toBeVisible()
    // Connected precedes the asynchronous database/schema discovery. Closing
    // during that operation is deliberately blocked by the application.
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.getByRole('button', { name: 'Close Query 3.sql', exact: true }).click()
    await page.getByRole('dialog', { name: 'Close query tab' }).getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Query 3.sql', exact: true })).not.toBeVisible()
    // Pinning/unpinning changed the order. Select the session being checked
    // explicitly instead of assuming which neighbor closing Query 3 selects.
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await run(page, 'SELECT n FROM local_to_tab'); await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    await profileAction(page, 'Renamed database', 'Delete')
    await page.getByRole('dialog', { name: 'Delete saved profile' }).getByRole('button', { name: 'Delete profile', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open Renamed database in new tab', exact: true })).not.toBeVisible()
    await run(page, 'SELECT n FROM local_to_tab'); await expect(page.getByRole('cell', { name: '20', exact: true })).toBeVisible()
    // Save an unconnected profile, then persist both tab buffers across a restart.
    await page.getByRole('button', { name: 'New saved profile', exact: true }).click()
    const savedForm = page.getByRole('dialog')
    await savedForm.getByLabel('Database engine').selectOption(engine)
    await savedForm.getByLabel('Connection name').fill('Saved for later')
    if (engine === 'duckdb') {
      await savedForm.getByLabel('Database file', { exact: true }).fill(path)
    } else {
      await savedForm.getByLabel('Port', { exact: true }).fill(process.env.SQLCOMMANDER_PG_PORT!)
      await savedForm.getByLabel('Database', { exact: true }).fill('dbcommander'); await savedForm.getByLabel('User', { exact: true }).fill('dbcommander')
      await savedForm.getByText('Custom CA certificate', { exact: true }).click(); await savedForm.getByLabel('CA certificate PEM').fill(readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'))
    }
    await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible()
    await enter(page, "SELECT 'second recovered buffer'")
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click()
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await enter(page, "SELECT 'first recovered buffer'")
    // Quit immediately: the final text must survive the debounce interval.
    await app!.close(); app = undefined
    page = await launch()
    await expect.poll(order).toEqual(['Query 2.sql','Untitled.sql'])
    await expect(page.getByRole('tab', { name: 'Query 2.sql', exact: true })).toHaveAttribute('aria-description', /Pinned/)
    await expect(page.getByRole('button', { name: 'Close Query 2.sql', exact: true })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Untitled.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.monaco-editor')).toContainText('first recovered buffer')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('second recovered buffer')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Open Saved for later in new tab', exact: true })).toBeVisible()
    const stored = await page.evaluate(() => window.dbCommander.loadWorkspace())
    expect(stored?.tabs.map(tab=>tab.title)).toEqual(['Query 2.sql','Untitled.sql'])
    expect(stored?.tabs).toHaveLength(2); expect(stored?.tabs.every(tab => !tab.profileId)).toBe(true)
    expect(stored?.tabs.map(tab => Boolean(tab.pinned))).toEqual([true, false])
    expect(JSON.stringify(stored)).not.toContain('password'); expect(JSON.stringify(stored)).not.toContain('accessToken')
    expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from('local-test-only'))).toBe(false)
    await page.getByRole('button', { name: 'Open Saved for later in new tab', exact: true }).click()
    if (engine === 'postgres') {
      const warning = page.getByRole('dialog', { name: 'Connection failed', exact: true })
      await expect(warning).toBeVisible()
      await warning.getByRole('button', { name: 'Edit connection', exact: true }).click()
      await expect(page.getByRole('dialog').getByLabel('Password', { exact: true })).toHaveValue('')
      await page.getByRole('dialog').getByLabel('Password', { exact: true }).fill('local-test-only')
      await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    }
    await expect(page.locator('.status-text')).toHaveText('Connected')
    await run(page, 'SELECT 99 AS recovered_profile')
    await expect(page.getByRole('cell', { name: '99', exact: true })).toBeVisible()
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const recovered = app!.waitForEvent('window')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    page = await recovered
    await expect(page.getByRole('tab', { name: 'Query 3.sql', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Query 2.sql', exact: true })).toHaveAttribute('aria-description', /Pinned/)
    await expect(page.locator('.monaco-editor')).toContainText('recovered_profile')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('first recovered buffer')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toContainText('second recovered buffer')
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
