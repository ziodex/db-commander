import { _electron as electron, expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { waitForWorkspaceReady } from './workspace-ready'
import { tableNode } from './explorer-actions'

test('catalog navigation: bounded pages, lazy children, stale parents and native theme/zoom actionability', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-catalog-navigation-')), file = join(directory, 'catalog.sqlite')
  const seed = new DatabaseSync(file)
  try {
    seed.exec(Array.from({ length: 120 }, (_, i) => `CREATE TABLE table${String(i).padStart(4, '0')}(id INTEGER PRIMARY KEY,value TEXT);`).join('\n'))
    seed.exec(Array.from({ length: 120 }, (_, i) => `CREATE INDEX index${String(i).padStart(4, '0')} ON table0000(value);`).join('\n'))
  } finally { seed.close() }
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), captureRoot = process.env.SQLCOMMANDER_CATALOG_CAPTURES
  async function capture(name: string) {
    const path = captureRoot ? join(resolve(captureRoot), name + '.png') : info.outputPath(name + '.png')
    if (captureRoot) mkdirSync(resolve(captureRoot), { recursive: true })
    const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(path, Buffer.from(bytes, 'base64'))
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite'); await form.getByLabel('Open mode').selectOption('read-write'); await form.getByLabel('Database file').fill(file)
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).toBeHidden()
    const search = page.getByLabel('Filter database objects'), next = page.getByRole('button', { name: 'Next catalog page', exact: true }), previous = page.getByRole('button', { name: 'Previous catalog page', exact: true })
    await expect(next).toBeEnabled(); await expect(page.locator('.schema-object')).toHaveCount(100)
    await expect(previous).toBeDisabled()
    await page.getByRole('button', { name: 'Expand table table0000', exact: true }).click()
    const childNext = page.getByRole('button', { name: 'Next children of table0000 page', exact: true })
    await expect(childNext).toBeEnabled()
    await page.locator('.relation-children').getByText('Indexes', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Object details index0000 on table0000', exact: true })).toBeVisible()
    await capture('children-first-dark')
    await childNext.click()
    await expect(page.getByRole('button', { name: 'Previous children of table0000 page', exact: true })).toBeEnabled()
    await expect(childNext).toBeDisabled()
    await page.locator('.relation-children').getByText('Indexes', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Object details index0100 on table0000', exact: true })).toBeVisible()
    await capture('children-next-dark')
    await page.getByRole('button', { name: 'Collapse table table0000', exact: true }).click()
    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click(); await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await preferences.getByLabel('Appearance', { exact: true }).selectOption(theme); await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click(); await expect(preferences).toBeHidden()
      for (const [width, height, zoom] of [[1360, 900, 1], [1024, 700, 1.25], [1024, 700, 2]] as const) {
        await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(size.width, size.height); w.webContents.setZoomFactor(size.zoom) }, { width, height, zoom })
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom))
        await search.fill(''); await expect(next).toBeEnabled()
        const contrast = await search.evaluate(node => {
          const numbers = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number)
          const placeholder = getComputedStyle(node, '::placeholder'), text = numbers(placeholder.color)
          let element: Element | null = node, background = [255, 255, 255]
          while (element) {
            const value = numbers(getComputedStyle(element).backgroundColor)
            if (value.length === 3 || value[3] === 1) { background = value; break }
            element = element.parentElement
          }
          const alpha = (text[3] ?? 1) * Number(placeholder.opacity)
          const foreground = text.slice(0, 3).map((value, i) => value * alpha + background[i] * (1 - alpha))
          const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 }).reduce((n, value, i) => n + value * [0.2126, 0.7152, 0.0722][i], 0)
          const a = luminance(foreground), b = luminance(background)
          return { color: placeholder.color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        })
        expect(contrast.ratio, `${theme} enabled catalog placeholder: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5)
        const keyboardPaging = theme === 'dark' && zoom === 1
        if (keyboardPaging) { await next.focus(); await page.keyboard.press('Enter') } else await next.click()
        await expect(tableNode(page, 'table0100')).toHaveCount(1); await expect(page.locator('.schema-object')).toHaveCount(20)
        await capture(`next-${theme}-${width}-${Math.round(zoom * 100)}`)
        if (keyboardPaging) { await expect(previous).toBeFocused(); await page.keyboard.press('Enter') } else await previous.click()
        await expect(tableNode(page, 'table0000')).toHaveCount(1); await expect(next).toBeFocused()
        const overflow = await page.locator('.database-explorer').evaluate(node => ({ visible: node.clientWidth, content: node.scrollWidth }))
        expect(overflow.content).toBeLessThanOrEqual(overflow.visible + 1)
        await next.click({ trial: true }); await search.focus(); await capture(`catalog-${theme}-${width}-${Math.round(zoom * 100)}`)
        await search.fill('table0119'); await expect(tableNode(page, 'table0119')).toHaveCount(1)
        await expect(search).toBeFocused()
        await capture(`search-${theme}-${width}-${Math.round(zoom * 100)}`)
        await search.fill('no_such_catalog_object'); await expect(page.getByText('No visible objects match this search. Try another name or object kind.', { exact: true })).toBeVisible()
        await capture(`empty-${theme}-${width}-${Math.round(zoom * 100)}`)
      }
    }
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1360, 900); w.webContents.setZoomFactor(1) })
    await search.fill('table0119'); await expect(tableNode(page, 'table0119')).toHaveCount(1)
    const outside = new DatabaseSync(file)
    try { outside.exec('DROP TABLE table0119') } finally { outside.close() }
    await page.getByRole('button', { name: 'Expand table table0119', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'parent object is no longer visible' })).toBeVisible()
    await expect(page.getByText('No visible indexes, keys or triggers for this table.', { exact: true })).toHaveCount(0)
    await capture('stale-parent-light')
    await search.fill(''); await expect(next).toBeEnabled()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})
