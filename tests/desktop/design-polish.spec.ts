import { withClipboard } from './clipboard-fixture'
import { _electron as electron, test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-design-polish-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([app.evaluate(({ app }) => app.exit(0)).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) } finally { clearTimeout(timer) }
    if (app.process().exitCode === null) app.process().kill('SIGKILL')
    await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  try {
    const page = await app.firstWindow()
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible(); await expect(page.locator('.monaco-editor')).toBeVisible()
    return { app, page, errors, close }
  } catch (error) { await close(); throw error }
}
async function preferences(page: Page) {
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Editor settings', exact: true }).click()
  return page.getByRole('dialog', { name: 'Editor settings', exact: true })
}
async function appearance(page: Page, theme: 'light' | 'dark') {
  const form = await preferences(page)
  await form.getByLabel('Appearance', { exact: true }).selectOption(theme)
  await form.getByRole('button', { name: 'Apply settings', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect.poll(() => page.locator('.monaco-editor-background').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 19, 20)')
}
async function enter(page: Page, sql: string) {
  await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
}
function contrast(first: string, second: string) {
  function luminance(color: string) {
    const channels = color.match(/[\d.]+/g)
    if (!channels || channels.length < 3) throw new Error(`Expected a resolved RGB color, received ${JSON.stringify(color)}.`)
    const rgb = channels.slice(0, 3).map(Number).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  const [a, b] = [luminance(first), luminance(second)]
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

test('design polish preserves readable themes, visible settings actions and complete connection identity', async ({}, info) => {
  test.setTimeout(120_000)
  const { app, page, errors, close } = await launch(), measurements: unknown[] = []
  try {
    await page.evaluate(async () => {
      const old = (await window.dbCommander.loadWorkspace())!
      const config = { engine: 'azure-sql' as const, name: 'Warehouse production', host: 'warehouse.example.database.windows.net', port: 1433, database: 'warehouse', user: 'analyst', tls: 'verify-full' as const, environment: 'production' as const, protected: true, folder: 'Servers' }
      await window.dbCommander.saveWorkspace({ version: 2, tabs: [{ ...old.tabs[0], sql: "-- Customer revenue overview\nSELECT count(c.id), sum(o.total), 42, 'paid' FROM customers c\nLEFT JOIN orders o ON o.id = c.id;" }], activeTabId: old.activeTabId, profiles: [{ id: crypto.randomUUID(), config }] })
    }); await page.reload(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme)
      for (const [width, height] of [[1440, 940], [1024, 700]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size as [number, number]), [width, height])
        const profile = page.getByRole('button', { name: 'Open Warehouse production in new tab', exact: true })
        await profile.focus(); await expect(profile).toHaveAttribute('aria-description', /production.*Protected connection/)
        await expect(profile).toHaveAttribute('title', /Warehouse production.*\n.*Protected connection/)
        const identity = await profile.evaluate(element => {
          const span = element.querySelector('strong')!, safety = element.querySelector('.profile-safety')!
          return { name: span.textContent, nameFits: span.scrollWidth <= span.clientWidth, safety: safety.textContent, safetyFits: safety.scrollWidth <= safety.clientWidth }
        })
        expect(identity).toEqual({ name: 'Warehouse production', nameFits: true, safety: 'productionProtected', safetyFits: true })
        // Resizing/theme changes replace Monaco's line elements. Resolve and
        // measure current nodes in one browser turn, rather than passing a
        // locator's previously resolved elements across that replacement.
        const readEditor = () => page.evaluate(() => {
          const editor = document.querySelector('.monaco-editor')!
          const tokens = [...editor.querySelectorAll('.view-line span')].filter(element => !element.children.length && element.textContent?.trim()).map(element => ({ text: element.textContent!.replace(/\u00a0/g, ' '), color: getComputedStyle(element).color }))
          const gutter = [...editor.querySelectorAll('.line-numbers')].filter(element => element.textContent?.trim()).map(element => ({ line: element.textContent!.trim(), color: getComputedStyle(element).color }))
          return { tokens, gutter }
        })
        await expect.poll(async () => {
          const { tokens, gutter } = await readEditor()
          return { comment: tokens.some(token => token.text.includes('Customer revenue')), keyword: tokens.some(token => token.text.includes('LEFT')), literal: tokens.some(token => token.text.includes("'paid'")), lines: gutter.map(row => row.line).sort(), colorsResolved: [...tokens, ...gutter].every(item => /^rgba?\(/.test(item.color)) }
        }).toEqual({ comment: true, keyword: true, literal: true, lines: ['1', '2', '3'], colorsResolved: true })
        const { tokens, gutter: numberedLines } = await readEditor()
        expect(tokens.some(token => token.text.includes('Customer revenue'))).toBe(true)
        expect(tokens.some(token => token.text.includes('LEFT'))).toBe(true)
        expect(tokens.some(token => token.text.includes("'paid'"))).toBe(true)
        if (theme === 'dark') {
          // Verify rendered roles, rather than only inspecting the token file:
          // an old component override must not silently reintroduce old colors.
          for (const [selector, background] of [
            ['.titlebar', 'rgb(25, 26, 27)'], ['.activity-bar', 'rgb(25, 26, 27)'],
            ['.sidebar', 'rgb(25, 26, 27)'], ['.editor-tabs', 'rgb(25, 26, 27)'],
            ['.editor-tab.selected', 'rgb(18, 19, 20)'], ['.query-toolbar', 'rgb(18, 19, 20)'],
            ['.results-region', 'rgb(18, 19, 20)'], ['.statusbar', 'rgb(25, 26, 27)']
          ]) await expect(page.locator(selector)).toHaveCSS('background-color', background)
          expect(tokens.find(token => token.text.includes('LEFT'))?.color).toBe('rgb(255, 123, 114)')
          expect(tokens.find(token => token.text.includes("'paid'"))?.color).toBe('rgb(165, 214, 255)')
          expect(await page.locator('.query-tab-list .material-icon').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
          expect(await page.evaluate(() => document.fonts.check('16px codicon'))).toBe(true)
        }
        const background = theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 19, 20)'
        for (const token of tokens) expect(contrast(token.color, background), `${theme}: ${token.text}`).toBeGreaterThanOrEqual(4.5)
        expect(numberedLines.map(row => row.line).sort()).toEqual(['1', '2', '3'])
        const gutter = numberedLines.map(row => row.color)
        for (const color of gutter) expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5)
        await page.screenshot({ path: info.outputPath(`workbench-${theme}-${width}.png`) })
        if (width === 1440) {
          await page.getByRole('button', { name: 'Query tools', exact: true }).click()
          await page.screenshot({ path: info.outputPath(`query-menu-${theme}.png`) }); await page.keyboard.press('Escape')
          await page.getByRole('button', { name: 'Workspace', exact: true }).click()
          await page.screenshot({ path: info.outputPath(`workspace-menu-${theme}.png`) }); await page.keyboard.press('Escape')
        }
        const form = await preferences(page)
        await expect(form.locator('legend').first()).toHaveText('Display')
        await expect(form.locator('.editor-settings-transfer')).not.toHaveAttribute('open', '')
        for (const name of ['Reset defaults', 'Cancel', 'Apply settings']) await expect(form.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
        const input = form.getByLabel(/Font size/)
        await input.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
        const colors = await input.evaluate(element => {
          const style = getComputedStyle(element), dialog = getComputedStyle(element.closest('dialog')!)
          return { focused: element.matches(':focus-visible'), focus: style.outlineColor, border: style.borderTopColor, input: style.backgroundColor, dialog: dialog.backgroundColor }
        })
        expect(colors.focused).toBe(true)
        for (const bg of [colors.input, colors.dialog]) {
          expect(contrast(colors.focus, bg)).toBeGreaterThanOrEqual(3)
          // VS Code 2026 Dark intentionally uses its subtle #333536 input border.
          if (theme === 'dark') expect(colors.border).toBe('rgb(51, 53, 54)')
          else expect(contrast(colors.border, bg)).toBeGreaterThanOrEqual(3)
        }
        await input.fill('18'); await expect(form.getByRole('button', { name: 'Apply settings', exact: true })).toBeInViewport({ ratio: 1 })
        await form.locator('.editor-settings-fields').evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 })
        await page.screenshot({ path: info.outputPath(`settings-${theme}-${width}.png`) })
        await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeFocused()
        measurements.push({ theme, width, height, identity, tokens, gutter, colors })
      }
    }
    const actions = page.getByRole('button', { name: 'Actions for Warehouse production', exact: true })
    await actions.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End')
    await expect(page.getByRole('menuitem', { name: 'Delete profile Warehouse production', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(actions).toBeFocused()
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 940); window.webContents.setZoomFactor(1.5) })
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme)
      for (const name of ['Workspace', 'Toggle sidebar', 'Toggle results', 'Commands']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
      const form = await preferences(page)
      for (const name of ['Reset defaults', 'Cancel', 'Apply settings']) await expect(form.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
      // Native capture covers the full window at a non-default Electron zoom;
      // CDP screenshots otherwise crop it using the unscaled viewport size.
      const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(info.outputPath(`settings-${theme}-zoom-150.png`), screenshot, 'base64')
      await page.keyboard.press('Escape')
    }
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    expect(errors).toEqual([])
  } finally { writeFileSync(info.outputPath('design-measurements.json'), JSON.stringify(measurements, null, 2)); await close() }
})

test('result keyboard navigation follows displayed columns across virtual rows and restores inspection focus', async ({}, info) => {
  const { page, errors, close } = await launch()
  try {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb'); await form.getByLabel('Open mode').selectOption('memory')
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await enter(page, "SELECT i AS id, 'row_' || i AS label, 9223372036854775807::BIGINT AS exact_value FROM range(1000) t(i);")
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    const table = page.getByRole('table', { name: 'Query results', exact: true }), cell = (row: number, column: number) => table.locator(`[data-result-row="${row}"][data-result-column="${column}"]`)
    const history = await page.evaluate(() => window.dbCommander.history())
    await cell(0, 0).focus(); await page.keyboard.press('ArrowRight'); await expect(cell(0, 1)).toBeFocused()
    await page.keyboard.press('ArrowDown'); await expect(cell(1, 1)).toBeFocused()
    await page.keyboard.press('End'); await expect(cell(1, 2)).toBeFocused()
    await page.keyboard.press(`${modifier}+End`); await expect(cell(999, 2)).toBeFocused()
    await expect(cell(999, 2)).toBeInViewport({ ratio: 1 })
    expect(await table.locator('.grid-row').last().locator('.row-number').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await table.getByRole('row').count()).toBeLessThan(80)
    await page.keyboard.press('Enter'); const inspector = page.getByRole('dialog', { name: 'Value inspector', exact: true })
    await expect(inspector.getByLabel('Inspected value')).toHaveValue('9223372036854775807')
    await page.keyboard.press('Escape'); await expect(cell(999, 2)).toBeFocused()
    await page.keyboard.press('Tab'); expect(await table.evaluate(element => element.contains(document.activeElement))).toBe(false)
    await page.keyboard.press('Shift+Tab'); await expect(cell(999, 2)).toBeFocused()
    await page.keyboard.press('PageUp'); await expect.poll(() => page.evaluate(() => Number((document.activeElement as HTMLElement).dataset.resultRow))).toBeLessThan(999)
    await page.keyboard.press(`${modifier}+Home`); await expect(cell(0, 0)).toBeFocused()
    await expect(cell(0, 0)).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Columns', exact: true }).click(); const columns = page.getByRole('dialog', { name: 'Column controls', exact: true })
    await columns.getByLabel('Show column 1 id', { exact: true }).uncheck(); await columns.getByLabel('Pin column 3', { exact: true }).check()
    await columns.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await table.locator('[role=cell][tabindex="0"]').count()).toBe(1)
    await cell(0, 2).focus(); await page.keyboard.press('ArrowRight'); await expect(cell(0, 1)).toBeFocused()
    await page.keyboard.press('Home'); await expect(cell(0, 2)).toBeFocused()
    await table.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => table.locator('[data-result-row="0"]').count()).toBe(0)
    await table.focus(); await expect.poll(() => page.evaluate(() => Number((document.activeElement as HTMLElement).dataset.resultRow))).toBeGreaterThan(900)
    expect(await table.locator('[role=cell][tabindex="0"]').count()).toBe(1)
    await page.screenshot({ path: info.outputPath('keyboard-result.png') })
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    expect(errors).toEqual([])
  } finally { await close() }
})

async function connectLocal(page: Page) {
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption('duckdb'); await form.getByLabel('Open mode').selectOption('memory')
  await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function execute(page: Page, sql: string) {
  await enter(page, sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
  await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
async function savedSql(page: Page) {
  return page.evaluate(async () => { const workspace = (await window.dbCommander.loadWorkspace())!; return workspace.tabs.find(tab => tab.id === workspace.activeTabId)!.sql })
}

test('design polish keeps editing, results and chrome reachable at native 200 percent zoom', async ({}, info) => {
  test.setTimeout(120_000)
  const { app, page, errors, close } = await launch(), measurements: unknown[] = []
  try {
    await connectLocal(page); await execute(page, 'SELECT i AS id FROM range(30) t(i);')
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    const layout = await page.evaluate(async () => (await window.dbCommander.loadWorkspace())!.layout)
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme)
      for (const [width, height] of [[1440, 940], [1024, 700]]) {
        await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(...size as [number, number]); window.webContents.setZoomFactor(2) }, [width, height])
        for (const name of ['Workspace', 'Toggle sidebar', 'Toggle results', 'Commands']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
        const geometry = await page.evaluate(() => {
          const editor = document.getElementById('query-panel')!.getBoundingClientRect(), panes = document.querySelector('.query-panes')!.getBoundingClientRect()
          return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, editorHeight: editor.height, panesHeight: panes.height }
        })
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport[0]); expect(geometry.editorHeight).toBeGreaterThanOrEqual(159)
        const editorInput = page.getByRole('textbox', { name: 'SQL editor' }); await editorInput.focus()
        await expect(editorInput).toBeInViewport()
        await page.keyboard.press(`${modifier}+End`); await page.keyboard.insertText('\n-- zoom editing remains available')
        await expect.poll(() => savedSql(page)).toContain('-- zoom editing remains available')
        await page.keyboard.press(`${modifier}+Z`)
        const result = page.getByRole('cell', { name: '0', exact: true }); await result.focus(); await expect(result).toBeInViewport()
        const textFits = await result.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect(), grid = element.closest('.grid-scroll')!.getBoundingClientRect(); return text.left >= grid.left && text.right <= grid.right })
        expect(textFits).toBe(true)
        await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: 'Value inspector', exact: true }).getByLabel('Inspected value')).toHaveValue('0'); await page.keyboard.press('Escape'); await expect(result).toBeFocused()
        await page.keyboard.press('ArrowDown'); await expect(page.locator('[data-result-row="1"][data-result-column="0"]')).toBeFocused()
        await page.getByRole('textbox', { name: 'Filter database objects', exact: true }).focus(); await expect(page.getByRole('textbox', { name: 'Filter database objects', exact: true })).toBeInViewport({ ratio: 1 })
        await page.getByRole('button', { name: /^Run SQL/ }).focus(); await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeInViewport({ ratio: 1 })
        const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
        writeFileSync(info.outputPath(`zoom-${theme}-${width}.png`), screenshot, 'base64'); measurements.push({ theme, width, height, geometry })
        await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 940) })
      }
    }
    expect(await page.evaluate(async () => (await window.dbCommander.loadWorkspace())!.layout)).toEqual(layout)
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(1); expect(errors).toEqual([])
  } finally { writeFileSync(info.outputPath('zoom-measurements.json'), JSON.stringify(measurements, null, 2)); await close() }
})

test('design polish table actions preserve authored SQL and append quoted SELECT as one undoable edit', async () => {
  test.setTimeout(90_000)
  const { app, page, errors, close } = await launch()
  try {
    await connectLocal(page); await execute(page, 'CREATE TABLE "customer notes" (id INTEGER); INSERT INTO "customer notes" VALUES (42); SELECT 42 AS kept_result;')
    await execute(page, 'SELECT 42 AS kept_result;')
    await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
    const table = page.locator('.object-label').filter({ hasText: 'customer notes' }); await expect(table).toBeVisible()
    const draft = '-- Authored investigation; keep this SQL\nSELECT id FROM "customer notes";'
    await enter(page, draft); await expect.poll(() => savedSql(page)).toBe(draft)
    const history = await page.evaluate(() => window.dbCommander.history())
    await table.click(); await expect(page.getByRole('menu', { name: 'Explorer actions', exact: true })).toBeVisible()
    await page.keyboard.press('Escape'); await expect(table).toBeFocused(); expect(await savedSql(page)).toBe(draft)
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await table.press('Enter'); await page.getByRole('menuitem', { name: 'Append SELECT SQL for customer notes', exact: true }).click()
    await expect.poll(() => savedSql(page)).toBe(draft + '\n\nSELECT *\nFROM "memory"."main"."customer notes"\nLIMIT 1000;')
    await page.keyboard.press(`${modifier}+Z`); await expect.poll(() => savedSql(page)).toBe(draft)
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    // A valid maximum-sized buffer must remain savable when generation is rejected.
    const maximum = '--' + 'x'.repeat(999_998);
    await withClipboard(app, async () => {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), maximum)
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.press(`${modifier}+V`)
    }); await expect.poll(() => savedSql(page)).toBe(maximum)
    await table.click(); await page.getByRole('menuitem', { name: 'Append SELECT SQL for customer notes', exact: true }).click()
    await expect(page.getByRole('alert', { name: 'Application error' })).toContainText('Your SQL buffer was kept.')
    expect(await savedSql(page)).toBe(maximum); expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    expect(errors).toEqual([])
  } finally { await close() }
})

test('design polish library reflows at 200 percent and explains filter and empty states', async ({}, info) => {
  test.setTimeout(90_000)
  const { app, page, errors, close } = await launch()
  try {
    await connectLocal(page); const sql = 'SELECT 42 AS library_recovery;'; await execute(page, sql)
    const history = await page.evaluate(() => window.dbCommander.history())
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme)
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 700); window.webContents.setZoomFactor(2) })
      await page.getByRole('button', { name: 'Query tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Query library', exact: true }).click()
      const library = page.getByRole('dialog', { name: 'Query library', exact: true })
      await expect(library.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(library.locator('.library-more-filters')).not.toHaveAttribute('open', '')
      await library.getByLabel('Search SQL', { exact: true }).fill('no_matches_here'); await expect(library).toContainText('No matching history.')
      await library.getByRole('button', { name: 'Clear history filters', exact: true }).click(); await expect(library.locator('.library-list button')).toHaveCount(1)
      await library.locator('.library-list button').click()
      const open = library.getByRole('button', { name: 'Open history in new tab', exact: true }); await open.focus(); await expect(open).toBeInViewport({ ratio: 1 })
      const actionFits = await open.evaluate(element => { const bounds = element.getBoundingClientRect(), parent = element.closest('.library-detail')!.getBoundingClientRect(); return bounds.left >= parent.left && bounds.right <= parent.right + 1 })
      expect(actionFits).toBe(true)
      await expect(library.getByRole('button', { name: 'Close query library', exact: true })).toBeInViewport({ ratio: 1 })
      const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(info.outputPath(`library-zoom-${theme}.png`), screenshot, 'base64')
      await library.getByRole('button', { name: 'Snippets', exact: true }).click(); await expect(library).toContainText('No saved snippets yet.')
      await expect(library.getByRole('button', { name: 'Snippets', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await library.getByLabel('Search snippets', { exact: true }).fill('not_saved'); await expect(library).toContainText('No matching snippets.')
      await library.getByRole('button', { name: 'Clear snippet filters', exact: true }).click(); await expect(library.getByLabel('Search snippets', { exact: true })).toHaveValue('')
      await library.getByRole('button', { name: 'History', exact: true }).click(); await library.getByRole('button', { name: 'Open history in new tab', exact: true }).click()
      await expect(library).toBeHidden(); await expect.poll(() => savedSql(page)).toBe(sql)
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 940) })
    }
    expect(errors).toEqual([])
  } finally { await close() }
})

test('design polish gives JSON recovery guidance and semantic failure colors in both themes', async () => {
  const { page, errors, close } = await launch()
  try {
    await connectLocal(page)
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme); await execute(page, "SELECT 'Denmark' AS country;")
      const cell = page.getByRole('cell', { name: 'Denmark', exact: true }); await cell.focus(); await page.keyboard.press('Enter')
      const inspector = page.getByRole('dialog', { name: 'Value inspector', exact: true }); await inspector.getByLabel('Value format').selectOption('json')
      await expect(inspector.getByRole('alert')).toHaveText('This value is not valid JSON. Choose Text to inspect the original value.')
      await expect(inspector.getByLabel('Inspected value')).toHaveValue('Denmark'); await expect(inspector.getByRole('button', { name: 'Copy displayed value', exact: true })).toBeDisabled()
      await inspector.getByLabel('Value format').selectOption('text'); await expect(inspector.getByRole('alert')).toHaveCount(0)
      await expect(inspector.getByRole('button', { name: 'Copy displayed value', exact: true })).toBeEnabled(); await page.keyboard.press('Escape'); await expect(cell).toBeFocused()
      const deepJson = '['.repeat(101) + '0' + ']'.repeat(101)
      await execute(page, `SELECT '${deepJson}' AS deep_json;`)
      const deepCell = page.getByRole('cell', { name: deepJson, exact: true }); await deepCell.focus(); await page.keyboard.press('Enter')
      await inspector.getByLabel('Value format').selectOption('json'); await expect(inspector.getByRole('alert')).toHaveText('JSON exceeds the 100-level formatting limit. Use Text.')
      await expect(inspector.getByLabel('Inspected value')).toHaveValue(deepJson); await page.keyboard.press('Escape'); await expect(deepCell).toBeFocused()
      const invalid = 'SELECT * FROM missing_design_review_table;'; await enter(page, invalid); await page.getByRole('button', { name: /^Run SQL/ }).click()
      await expect(page.locator('.status-text')).toHaveText('Failed'); await page.getByRole('button', { name: /^Messages/ }).click()
      const colors = await page.locator('.message-status').evaluate(element => { const style = getComputedStyle(element), probe = document.createElement('span'); element.append(probe); probe.style.color = 'var(--danger)'; const danger = getComputedStyle(probe).color; probe.style.color = 'var(--success)'; const success = getComputedStyle(probe).color; probe.remove(); return { color: style.color, danger, success } })
      expect(colors.color).toBe(colors.danger); expect(colors.color).not.toBe(colors.success); await expect.poll(() => savedSql(page)).toBe(invalid)
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click(); await page.getByRole('button', { name: /^Results/ }).click()
    }
    expect(errors).toEqual([])
  } finally { await close() }
})

test('design polish syntax and object search stay readable in active and selected states', async ({}, info) => {
  test.setTimeout(90_000)
  const { page, errors, close } = await launch(), measurements: unknown[] = []
  try {
    await connectLocal(page)
    for (const theme of ['dark', 'light'] as const) {
      await appearance(page, theme); await enter(page, "-- Selected comment\nSELECT COUNT(id), SUM(total), 42, 'paid' FROM customers WHERE total >= 1;")
      const readTokens = () => page.evaluate(() => [...document.querySelectorAll('.monaco-editor .view-line span')].filter(element => !element.children.length && element.textContent?.trim()).map(element => ({ text: element.textContent!.replace(/\u00a0/g, ' '), color: getComputedStyle(element).color })))
      // Monaco tokenizes asynchronously; query and measure live nodes in one turn.
      await expect.poll(async () => (await readTokens()).map(token => token.text)).toContain('COUNT')
      const background = await page.locator('.monaco-editor-background').first().evaluate(element => getComputedStyle(element).backgroundColor)
      const line = await page.locator('.view-overlays .current-line').first().evaluate(element => getComputedStyle(element).backgroundColor)
      const normal = await readTokens(); measurements.push({ theme, background, line, normal }); expect(normal.some(token => token.text.includes('42'))).toBe(true); expect(normal.some(token => token.text.includes('COUNT'))).toBe(true)
      for (const token of normal) for (const surface of [background, line]) expect(contrast(token.color, surface), `${theme} active: ${token.text}`).toBeGreaterThanOrEqual(4.5)
      await page.keyboard.press(`${modifier}+A`)
      await expect(page.locator('.selected-text').first()).toBeVisible()
      for (const focused of [true, false]) {
        if (!focused) await page.getByRole('button', { name: 'Commands', exact: true }).focus()
        await expect.poll(() => page.locator('.selected-text').first().evaluate(element => Boolean(element.closest('.focused')))).toBe(focused)
        const selected = await page.locator('.selected-text').first().evaluate(element => getComputedStyle(element).backgroundColor)
        const tokens = await readTokens()
        for (const token of tokens) expect(contrast(token.color, selected), `${theme} selected ${focused}: ${token.text}`).toBeGreaterThanOrEqual(4.5)
        measurements.push({ theme, focused, selected, tokens })
        await page.screenshot({ path: info.outputPath(`selection-${theme}-${focused ? 'active' : 'inactive'}.png`) })
      }
      const search = await page.locator('.schema-search').evaluate(element => { const style = getComputedStyle(element), probe = document.createElement('span'); element.append(probe); probe.style.background = 'var(--surface)'; const surface = getComputedStyle(probe).backgroundColor; probe.remove(); return { border: style.borderTopColor, surface } })
      expect(contrast(search.border, search.surface)).toBeGreaterThanOrEqual(3); measurements.push({ theme, background, line, normal, search })
    }
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([]); expect(errors).toEqual([])
  } finally { writeFileSync(info.outputPath('state-contrast.json'), JSON.stringify(measurements, null, 2)); await close() }
})
