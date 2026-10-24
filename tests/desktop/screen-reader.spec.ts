import { _electron as electron, test, expect, type ElectronApplication, type Page, type CDPSession, type TestInfo } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tableAction } from './explorer-actions'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-screen-reader-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const cdp = await app.context().newCDPSession(page); await cdp.send('Accessibility.enable')
    return { app, page, directory, cdp }
  } catch (error) { await close(app, directory); throw error }
}
async function close(app: ElectronApplication, directory: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('sqlite')
  await form.getByLabel('Open mode').selectOption('memory'); await form.getByLabel('Save connection profile').uncheck()
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toHaveCount(0)
}
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
async function run(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed')
}
async function tree(cdp: CDPSession, info: TestInfo, phase: string) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  const exposed = nodes.filter(node => !node.ignored).map(node => ({
    role: node.role?.value, name: node.name?.value, description: node.description?.value, value: node.value?.value,
    properties: Object.fromEntries((node.properties ?? []).map(property => [property.name, property.value.value]))
  }))
  const path = info.outputPath(`${phase}-accessibility.json`)
  writeFileSync(path, JSON.stringify(exposed, null, 2))
  await info.attach(`${phase}-accessibility.json`, { path, contentType: 'application/json' })
  return exposed
}
function node(nodes: Awaited<ReturnType<typeof tree>>, role: string, name: string | RegExp) {
  const matches = nodes.filter(node => node.role === role && (typeof name === 'string' ? node.name === name : name.test(String(node.name))))
  expect(matches, `${role} ${name} in Chromium's accessibility tree`).toHaveLength(1)
  return matches[0]
}

test('screen reader distinguishes result values, headers and virtual preview positions', async ({}, info) => {
  const { app, page, directory, cdp } = await launch()
  try {
    await connect(page)
    await run(page, "SELECT NULL AS duplicate, '' AS duplicate, 'NULL' AS literal, printf('%0600d',1) AS long_value;")
    const table = page.getByRole('table', { name: 'Query results', exact: true })
    let ax = await tree(cdp, info, 'values')
    expect(node(ax, 'table', 'Query results').description).toContain('1 row loaded')
    node(ax, 'cell', 'SQL NULL'); node(ax, 'cell', 'Empty text'); node(ax, 'cell', 'NULL')
    expect(ax.filter(node => node.role === 'columnheader').map(node => node.name)).toEqual(['Row', 'duplicate', 'duplicate', 'literal', 'long_value'])
    expect(node(ax, 'cell', /^0+…$/).description).toContain('truncated')
    await page.getByRole('button', { name: 'Columns', exact: true }).click()
    const columns = page.getByRole('dialog', { name: 'Column controls', exact: true })
    await columns.getByRole('button', { name: 'Move column 2 left', exact: true }).click()
    await columns.getByLabel('Show column 1 duplicate', { exact: true }).uncheck()
    await columns.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(table).toHaveAttribute('aria-colcount', '4')
    await expect(table.getByRole('columnheader').nth(1)).toHaveAttribute('aria-colindex', '2')
    ax = await tree(cdp, info, 'reordered-values')
    expect(node(ax, 'columnheader', 'duplicate').description).toContain('Source column 2')
    const empty = table.getByRole('cell', { name: 'Empty text', exact: true })
    await empty.focus(); await page.keyboard.press('Enter')
    const inspector = page.getByRole('dialog', { name: 'Value inspector', exact: true })
    await expect(inspector).toBeVisible()
    ax = await tree(cdp, info, 'inspector-modal')
    expect(node(ax, 'dialog', 'Value inspector').properties.modal).toBe(true)
    expect(ax.some(node => node.role === 'button' && /^Run SQL/.test(String(node.name)))).toBe(false)
    await page.screenshot({ path: info.outputPath('value-inspector.png') })
    await page.keyboard.press('Escape'); await expect(empty).toBeFocused()
    await run(page, 'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1200) SELECT i FROM n;')
    await expect(table).toHaveAttribute('aria-rowcount', '1001')
    expect(node(await tree(cdp, info, 'bounded-preview'), 'table', 'Query results').description).toContain('Limited preview')
    await table.focus(); await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown')
    await expect.poll(() => table.locator('[role=cell]:focus').getAttribute('data-result-row')).not.toBe('0')
    // Roving navigation moves by loaded rows; overscan can retain row zero for
    // the first few pages. Move to the last cell to inspect a distinct range.
    await page.keyboard.press(`${modifier}+End`)
    await expect.poll(() => table.locator('.grid-row').first().getAttribute('aria-rowindex')).not.toBe('2')
    const indices = await table.getByRole('row').evaluateAll(rows => rows.map(row => Number(row.getAttribute('aria-rowindex'))))
    expect(indices[0]).toBe(1); expect(indices[1]).toBeGreaterThan(2)
    expect(indices.slice(1).every((value, index, rows) => value <= 1001 && (!index || value === rows[index - 1] + 1))).toBe(true)
    expect(indices.length).toBeLessThan(80)
  } finally { await close(app, directory) }
})

test('screen reader exposes editable cell state, protected keys and virtual row indices', async ({}, info) => {
  const { app, page, directory, cdp } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700))
    await connect(page)
    await run(page, "CREATE TABLE accessible_data(id INTEGER PRIMARY KEY, note TEXT DEFAULT 'fallback', computed TEXT GENERATED ALWAYS AS (coalesce(note,'missing')) STORED); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100) INSERT INTO accessible_data(id,note) SELECT i, CASE WHEN i=1 THEN NULL ELSE '' END FROM n;")
    await tableAction(page, 'accessible_data', 'Edit data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    const table = page.getByRole('table', { name: 'Editable table data', exact: true })
    await expect(table).toHaveAttribute('aria-colcount', '4')
    let ax = await tree(cdp, info, 'editable-values')
    expect(node(ax, 'textbox', 'Row 1 id').properties.readonly).toBe(true)
    expect(node(ax, 'textbox', 'Row 1 id').description).toContain('Protected primary key')
    expect(node(ax, 'textbox', 'Row 1 computed').properties.readonly).toBe(true)
    expect(node(ax, 'textbox', 'Row 1 computed').description).toContain('Protected generated column')
    expect(node(ax, 'textbox', 'Row 1 note').description).toContain('SQL NULL')
    expect(node(ax, 'textbox', 'Row 2 note').description).toContain('Empty text')
    await expect(page.getByRole('textbox', { name: 'Row 2 note', exact: true })).toHaveAttribute('placeholder', '')
    await page.getByRole('button', { name: 'Insert row', exact: true }).click()
    // Result previews above exercise keyboard scrolling; jump to the final editable rows here.
    await table.evaluate(element => { element.scrollTop = element.scrollHeight })
    const inserted = page.getByRole('textbox', { name: 'Row 101 note', exact: true }); await expect(inserted).toBeVisible()
    ax = await tree(cdp, info, 'insert-default')
    expect(node(ax, 'textbox', 'Row 101 note').description).toContain('Database default')
    expect(node(ax, 'textbox', 'Row 101 computed').description).toContain('Generated value')
    await page.getByRole('button', { name: 'Delete row 100', exact: true }).click()
    ax = await tree(cdp, info, 'deleted-row')
    expect(node(ax, 'textbox', 'Row 100 note').description).toContain('Row marked for deletion')
    expect(node(ax, 'textbox', 'Row 100 note').properties.readonly).toBe(true)
    await inserted.fill('')
    await page.getByRole('button', { name: 'Set row 101 note NULL', exact: true }).click()
    await page.getByRole('button', { name: 'Set row 101 note empty text', exact: true }).click()
    ax = await tree(cdp, info, 'staged-empty')
    expect(node(ax, 'textbox', 'Row 101 note').description).toContain('Empty text. Staged value')
    const indices = await table.getByRole('row').evaluateAll(rows => rows.map(row => Number(row.getAttribute('aria-rowindex'))))
    expect(indices[0]).toBe(1); expect(indices[1]).toBeGreaterThan(2); expect(indices.at(-1)).toBe(102)
    await expect(table.locator('.grid-row').last().getByRole('cell').nth(2)).toHaveAttribute('aria-colindex', '3')
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await page.getByRole('button', { name: 'Close data', exact: true }).click()
    await tableAction(page, 'accessible_data', 'Browse data'); await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByLabel('Rows per page').selectOption('25')
    await expect(page.locator('.page-range')).toHaveText('Rows 1–25')
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await expect(page.locator('.page-range')).toHaveText('Rows 26–50')
    const browse = page.getByRole('table', { name: 'Table data', exact: true })
    await expect(browse).toHaveAttribute('aria-rowcount', '26')
    await expect(browse.locator('.grid-row').first()).toHaveAttribute('aria-rowindex', '2')
    expect(node(await tree(cdp, info, 'browse-second-page'), 'table', 'Table data').description).toContain('rows 26 to 50')
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(1)
  } finally { await close(app, directory) }
})

test('screen reader exposes output selection, tab activity and execution announcements', async ({}, info) => {
  const { app, page, directory, cdp } = await launch()
  try {
    await connect(page); await run(page, 'SELECT 1 AS first; SELECT 2 AS second;')
    let ax = await tree(cdp, info, 'output-selection')
    expect(node(ax, 'button', /^Results/).properties.pressed).toBe('true')
    expect(node(ax, 'button', /^Messages/).properties.pressed).toBe('false')
    expect(node(ax, 'button', 'Result 1').properties.pressed).toBe('true')
    expect(node(ax, 'button', 'Result 2').properties.pressed).toBe('false')
    expect(node(ax, 'tab', 'Untitled.sql').description).toContain('Unsaved SQL changes')
    expect(node(ax, 'textbox', 'SQL editor').properties.multiline).toBe(true)
    await page.getByRole('button', { name: 'Result 2', exact: true }).click()
    ax = await tree(cdp, info, 'second-result'); expect(node(ax, 'button', 'Result 2').properties.pressed).toBe('true')
    await page.getByRole('button', { name: /^Messages/ }).click()
    ax = await tree(cdp, info, 'messages-selected'); expect(node(ax, 'button', /^Messages/).properties.pressed).toBe('true')
    await page.getByRole('tab', { name: 'Untitled.sql', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click()
    await page.getByRole('button', { name: 'Begin', exact: true }).click(); await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    ax = await tree(cdp, info, 'transaction-tab')
    expect(node(ax, 'tab', 'Untitled.sql').description).toMatch(/Pinned.*Unsaved SQL changes.*In transaction/)
    expect(node(ax, 'status', 'Execution status').properties).toMatchObject({ live: 'polite', atomic: true })
    expect(node(ax, 'status', 'Transaction status').properties).toMatchObject({ live: 'polite', atomic: true })
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await enter(page, 'SELECT * FROM missing_accessibility_fixture;'); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.error-banner')).toBeVisible()
    ax = await tree(cdp, info, 'query-error')
    expect(node(ax, 'alert', 'Application error').properties.live).toBe('assertive')
    expect(node(ax, 'status', 'Execution status').properties.live).toBe('polite')
  } finally { await close(app, directory) }
})

test('screen reader sees named connection fields and an isolated command palette', async ({}, info) => {
  const { app, page, directory, cdp } = await launch()
  try {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    let ax = await tree(cdp, info, 'connection-fields')
    expect(ax.filter(node => node.role === 'dialog' && node.properties.modal === true)).toHaveLength(1)
    node(ax, 'combobox', 'Database engine'); node(ax, 'textbox', 'Connection name'); node(ax, 'textbox', 'Host')
    expect(ax.some(node => node.role === 'textbox' && node.name === 'SQL editor')).toBe(false)
    await page.keyboard.press('Escape')
    const commands = page.getByRole('button', { name: 'Commands', exact: true })
    await commands.click()
    ax = await tree(cdp, info, 'commands-modal')
    expect(node(ax, 'dialog', 'Commands').properties.modal).toBe(true)
    node(ax, 'textbox', 'Search commands')
    expect(ax.some(node => node.role === 'button' && /^Run SQL/.test(String(node.name)))).toBe(false)
    expect(ax.some(node => node.role === 'textbox' && node.name === 'SQL editor')).toBe(false)
    await page.screenshot({ path: info.outputPath('command-palette.png') })
    await page.keyboard.press('Escape'); await expect(commands).toBeFocused()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app, directory) }
})

test('screen reader leaves routine autosave quiet and announces failed save recovery', async ({}, info) => {
  const { app, page, directory, cdp } = await launch()
  try {
    let ax = await tree(cdp, info, 'workspace-ready')
    expect(node(ax, 'status', 'Workspace save').properties.live).toBe('polite')
    // Capture only the dedicated live region; typing and successful autosaves must not mutate it.
    await page.evaluate(() => {
      const region = document.querySelector('[role="status"][aria-label="Workspace save"]')!
      ;(window as any).__saveAnnouncements = []
      new MutationObserver(() => (window as any).__saveAnnouncements.push(region.textContent)).observe(region, { childList: true, subtree: true, characterData: true })
    })
    for (const sql of ['SELECT quiet_autosave_one;', 'SELECT quiet_autosave_two;']) {
      await enter(page, sql); await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))?.tabs[0].sql).toBe(sql)
    }
    expect(await page.evaluate(() => (window as any).__saveAnnouncements)).toEqual([])
    expect(await page.getByText('Saved locally', { exact: true }).getAttribute('role')).toBeNull()
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'))
    try { db.exec("CREATE TRIGGER fail_accessibility_save BEFORE INSERT ON workspace BEGIN SELECT RAISE(FAIL, 'Screen reader save failure'); END") } finally { db.close() }
    await enter(page, 'SELECT retained_after_failed_save;')
    const feedback = page.getByRole('status', { name: 'Workspace save', exact: true })
    await expect(feedback).toContainText('Workspace not saved')
    ax = await tree(cdp, info, 'workspace-failure'); expect(node(ax, 'status', 'Workspace save').properties.atomic).toBe(true)
    const repaired = new DatabaseSync(join(directory, 'workspace.sqlite')); try { repaired.exec('DROP TRIGGER fail_accessibility_save') } finally { repaired.close() }
    await page.getByRole('button', { name: 'Retry workspace save', exact: true }).click()
    await expect(feedback).toHaveText('Workspace saved locally.')
    await enter(page, 'SELECT quiet_after_recovery;'); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(feedback).toHaveText('Workspace saved locally.')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally { await close(app, directory) }
})
