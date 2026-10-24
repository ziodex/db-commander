import { openSeparateQueryTab } from './separate-query-tab'
import { _electron as electron, test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  return { app, page }
}
async function close(app?: ElectronApplication) { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}) }
const workspace = (page: Page) => page.evaluate(() => window.dbCommander.loadWorkspace())
async function enter(page: Page, sql: string, editor = page.locator('.monaco-editor')) {
  await editor.click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function viewCommand(page: Page, action: string) {
  await page.getByRole('button', { name: 'Editor views', exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function run(page: Page, sql: string, editor?: Locator) {
  // Connected is reported before the new tab's database/schema discovery ends.
  // Wait for executable readiness before sending a shortcut, which is disabled
  // during discovery and otherwise gets dropped on faster desktop workers.
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  await enter(page, sql, editor); await page.keyboard.press(`${modifier}+Enter`)
  await expect.poll(async () => ({ status: await page.locator('.status-text').innerText(), errors: await page.locator('.error-banner').allTextContents() })).toEqual({ status: 'Completed', errors: [] })
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled(); if (await page.locator('.result-tabs button').count()) await page.locator('.result-tabs button').last().click()
}

test('split editor views retain buffers, ordering, focus, sizes and layout after restart', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-views-'))
  let app: ElectronApplication | undefined
  try {
    let launched = await launch(directory); app = launched.app; let page = launched.page
    await enter(page, 'select 1 as first;')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'select 2 as second;')
    await page.getByRole('button', { name: 'New query tab', exact: true }).click(); await enter(page, 'select 3 as third;')
    await expect.poll(async () => (await workspace(page))?.tabs[2]?.sql).toBe('select 3 as third;')
    const original = (await workspace(page))!, [first, second, third] = original.tabs
    await page.getByRole('tab', { name: first.title, exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Split editor side by side', exact: true }).click()
    await expect(page.locator('.monaco-editor')).toHaveCount(2)
    await expect.poll(async () => (await workspace(page))?.editorViews?.tabIds).toEqual([third.id, first.id])
    const view = (id: string) => page.locator(`#query-view-${id}`)
    await expect(view(third.id)).toContainText('select 3')
    await enter(page, 'select 11 as updated;', view(first.id).locator('.monaco-editor'))
    await expect.poll(async () => (await workspace(page))?.activeTabId).toBe(first.id)
    await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.tabs.find(tab => tab.id === first.id)?.sql).toContain('\n')
    // Dragging the global tab strip changes order, not split ownership or SQL.
    await page.getByRole('tab', { name: third.title, exact: true }).dragTo(page.getByRole('tab', { name: second.title, exact: true }), { targetPosition: { x: 4, y: 12 } })
    await expect.poll(async () => (await workspace(page))?.tabs.map(tab => tab.id)).toEqual([first.id, third.id, second.id])
    expect((await workspace(page))?.editorViews?.tabIds).toEqual([third.id, first.id])
    await page.getByRole('tab', { name: second.title, exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.editorViews?.tabIds).toEqual([third.id, second.id])
    await page.getByLabel('Query in view 2', { exact: true }).selectOption(first.id)
    await expect(view(first.id).locator('.monaco-editor')).toBeVisible()
    await view(first.id).getByRole('button', { name: 'Active', exact: true }).click()
    await page.keyboard.press(`${modifier}+Z`)
    await expect.poll(async () => (await workspace(page))?.tabs.find(tab => tab.id === first.id)?.sql).toBe('select 11 as updated;')
    await page.keyboard.press('F6')
    await expect.poll(async () => (await workspace(page))?.activeTabId).toBe(third.id)
    await page.getByLabel('Query in view 1', { exact: true }).selectOption(first.id)
    await expect.poll(async () => (await workspace(page))?.activeTabId).toBe(first.id)
    expect((await workspace(page))?.editorViews?.tabIds).toEqual([third.id, first.id]) // Never two editors on one model.
    const divider = page.getByRole('separator', { name: 'Resize query views 1 and 2', exact: true })
    await divider.focus(); await page.keyboard.press('ArrowRight'); await expect(divider).toHaveAttribute('aria-valuenow', '52')
    const rectangle = (await divider.boundingBox())!
    await page.mouse.move(rectangle.x + 3, rectangle.y + 10); await page.mouse.down(); await page.mouse.move(rectangle.x + 70, rectangle.y + 10)
    await page.keyboard.press('Escape'); await page.mouse.up(); await expect(divider).toHaveAttribute('aria-valuenow', '52')
    await viewCommand(page, 'Split editor side by side'); await expect(page.locator('.monaco-editor')).toHaveCount(3)
    await viewCommand(page, 'Split editor stacked'); await expect(page.locator('.monaco-editor')).toHaveCount(4)
    await page.getByRole('button', { name: 'Editor views', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Split editor stacked', exact: true })).toBeDisabled(); await page.keyboard.press('Escape')
    await expect.poll(async () => (await workspace(page))?.editorViews?.orientation).toBe('horizontal')
    await page.getByRole('separator', { name: 'Resize query views 1 and 2', exact: true }).focus(); await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await workspace(page))?.editorViews?.weights).toEqual([27, 23, 25, 25])
    const saved = (await workspace(page))!
    expect(saved.tabs).toHaveLength(4)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('split-editors.png') })
    await app.close(); app = undefined
    launched = await launch(directory); app = launched.app; page = launched.page
    await expect(page.locator('.monaco-editor')).toHaveCount(4)
    expect((await workspace(page))?.editorViews).toEqual(saved.editorViews)
    expect((await workspace(page))?.tabs).toEqual(saved.tabs)
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Hide query view 1', exact: true }).click(); await expect(page.locator('.monaco-editor')).toHaveCount(3)
    expect((await workspace(page))?.tabs).toHaveLength(4)
    await viewCommand(page, 'Single editor view'); await expect(page.locator('.monaco-editor')).toHaveCount(1)
    await expect.poll(async () => (await workspace(page))?.editorViews).toBeUndefined()
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})

test('split editor views route selected and current SQL to independent duckdb sessions', async () => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-editor-sessions-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(directory); app = launched.app; const page = launched.page
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('duckdb'); await connection.getByLabel('Open mode').selectOption('memory')
    await connection.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(connection).not.toBeVisible()
    await openSeparateQueryTab(page)
    await run(page, 'create temp table split_session(n integer); insert into split_session values(22); select n from split_session;')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click()
    await run(page, 'create temp table split_session(n integer); begin; insert into split_session values(11); select n from split_session;')
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('tab', { name: 'Query 2.sql', exact: true }).click()
    await expect.poll(async () => (await workspace(page))?.tabs.length).toBe(2)
    const [first, second] = (await workspace(page))!.tabs
    await viewCommand(page, 'Split editor side by side')
    await expect(page.locator('.monaco-editor')).toHaveCount(2)
    const editor = (id: string) => page.locator(`#query-view-${id} .monaco-editor`)
    await enter(page, 'select n from split_session;', editor(first.id))
    await page.keyboard.press(`${modifier}+Shift+Enter`)
    await expect(page.getByRole('cell', { name: '11', exact: true })).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    const selected = 'select n from split_session;'
    await enter(page, `select missing_column;\n${selected}`, editor(second.id))
    for (let i = 0; i < selected.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press(`${modifier}+Enter`)
    await expect(page.getByRole('cell', { name: '22', exact: true })).toBeVisible()
    await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    const history = await page.evaluate(() => window.dbCommander.history())
    expect(history[0].sql).toBe(selected)
    await page.locator(`#query-view-${first.id}`).getByRole('button', { name: 'Focus', exact: true }).click()
    await expect(page.getByRole('cell', { name: '11', exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Close ${first.title}`, exact: true }).click()
    await expect(page.locator('.error-banner')).toContainText('transaction')
    await page.locator(`#query-view-${first.id}`).getByRole('button', { name: /Hide query view/ }).click()
    await expect(page.locator('.monaco-editor')).toHaveCount(1)
    await expect(page.getByRole('cell', { name: '22', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: first.title, exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('Autocommit')
    await run(page, 'select count(*) as remaining from split_session;')
    await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible()
  } finally { await close(app); rmSync(directory, { recursive: true, force: true }) }
})
