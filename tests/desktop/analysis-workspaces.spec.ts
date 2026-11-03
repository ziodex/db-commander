import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForWorkspaceReady } from './workspace-ready'
import { databaseAction, queryTool } from './workspace-actions'

test('Q2 analysis workspace compares native captures, restores diagrams and opens project SQL files', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-analysis-'))
  const profile = join(directory, 'profile'), project = join(directory, 'checkout'), database = join(directory, 'data.duckdb')
  const script = join(project, 'migrations', '01-query.sql')
  mkdirSync(join(project, 'migrations'), { recursive: true })
  writeFileSync(script, 'SELECT 7 AS project_sql;\n')
  writeFileSync(join(project, 'notes.txt'), 'Notes')
  const env: NodeJS.ProcessEnv = { ...process.env, SQLCOMMANDER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined, page: Page
  async function launch() {
    app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }),
      env: env as Record<string, string> })
    const window = await app.firstWindow()
    await waitForWorkspaceReady(window)
    return window
  }
  async function connect(mode: 'create' | 'read-write') {
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('duckdb')
    await form.getByLabel('Open mode').selectOption(mode)
    await form.getByLabel('Database file', { exact: true }).fill(database)
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  async function enter(sql: string) {
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(sql)
    await page.keyboard.press('Escape')
  }
  async function capture(name: string) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    writeFileSync(info.outputPath(name), await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()))
  }
  async function zoom(factor: number) {
    await app!.evaluate(({ BrowserWindow }, factor) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(factor)
    }, factor)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1024 / factor))
  }
  async function showProject() {
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'SQL project files', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'SQL project', exact: true })
    await expect(dialog).toBeVisible()
    return dialog
  }
  const plan = () => page.getByRole('dialog', { name: 'Query plan', exact: true })
  const diagram = () => page.getByRole('dialog', { name: 'ER diagram', exact: true })
  const table = () => diagram().getByRole('button', { name: /^Table .*q2_sales$/ })
  try {
    page = await launch(); await connect('create')
    await enter('CREATE TABLE q2_sales(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO q2_sales VALUES (1,4),(2,6);')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()

    await enter('SELECT * FROM q2_sales')
    await queryTool(page, 'Explain selected SQL')
    await plan().getByRole('button', { name: 'Get estimated plan' }).click()
    await plan().getByRole('button', { name: 'Plan tree', exact: true }).click()
    await expect(plan().getByLabel('DuckDB plan tree')).toContainText('q2_sales')
    await plan().getByRole('button', { name: 'Pin as baseline' }).click()
    await expect(plan()).toContainText('Captured plan pinned as the baseline.')
    await plan().getByRole('button', { name: 'Close query plan' }).click()

    await enter('SELECT SUM(amount) FROM q2_sales')
    await queryTool(page, 'Explain selected SQL')
    await plan().getByRole('button', { name: 'Get estimated plan' }).click()
    await plan().getByRole('button', { name: 'Compare with baseline' }).click()
    const comparison = plan().getByRole('region', { name: 'Compare captured plans' })
    await expect(comparison).toContainText('submitted SQL text differs')
    await expect(comparison.getByRole('table', { name: 'Changed operator counts' })).toContainText(/AGGREGATE/)
    await plan().getByRole('button', { name: 'Plan tree', exact: true }).click()
    await capture('q2-plan-dark.png')
    await zoom(1.25)
    await comparison.getByRole('table', { name: 'Changed operator counts' }).scrollIntoViewIfNeeded()
    await expect(comparison.getByRole('table', { name: 'Changed operator counts' })).toBeVisible()
    await capture('q2-plan-dark-125.png')
    await plan().getByRole('button', { name: 'Close query plan' }).click()
    await zoom(1)

    await databaseAction(page, 'ER diagram')
    await expect(diagram().getByText('Diagram refreshed.', { exact: true })).toBeVisible()
    await table().focus()
    await page.keyboard.press('ArrowRight')
    const position = await table().getAttribute('transform')
    await diagram().getByLabel('Show columns', { exact: true }).uncheck()
    const zoomLabel = await diagram().getByLabel('Diagram zoom').innerText()
    await diagram().getByText('Saved layouts', { exact: true }).click()
    await diagram().getByLabel('Layout name', { exact: true }).fill('Sales review')
    await diagram().getByRole('button', { name: 'Save layout', exact: true }).click()
    await expect(diagram().getByText('Diagram layout saved.', { exact: true })).toBeVisible()
    await capture('q2-diagram-dark.png')
    await diagram().getByRole('button', { name: 'Close ER diagram' }).click()

    const beforeOpen = await page.evaluate(async () => (await window.dbCommander.history()).length)
    await app!.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }) }, project)
    let browser = await showProject()
    await browser.getByRole('button', { name: 'Choose project folder…' }).click()
    await expect(browser.getByRole('button', { name: 'migrations/01-query.sql' })).toBeVisible()
    await expect(browser).not.toContainText('notes.txt')
    await browser.getByLabel('Find SQL files').fill('unknown')
    await expect(browser).toContainText('No listed files match this search.')
    await browser.getByLabel('Find SQL files').fill('migrations')
    await capture('q2-project-dark.png')
    await browser.getByRole('button', { name: 'migrations/01-query.sql' }).click()
    await expect(browser).not.toBeVisible()
    await expect(page.getByRole('tab', { name: /01-query.sql/ })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(async () => {
      const workspace = await window.dbCommander.loadWorkspace()
      return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.sql
    })).toBe('SELECT 7 AS project_sql;\n')
    expect(await page.evaluate(async () => (await window.dbCommander.history()).length)).toBe(beforeOpen)
    expect(readFileSync(script, 'utf8')).toBe('SELECT 7 AS project_sql;\n')

    await app!.close(); app = undefined
    page = await launch()
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).not.toBeVisible()
    await zoom(2)
    browser = await showProject()
    await expect(browser.getByRole('button', { name: 'migrations/01-query.sql' })).toBeVisible()
    await browser.getByRole('button', { name: 'migrations/01-query.sql' }).click({ trial: true })
    await capture('q2-project-light-200.png')
    await browser.getByRole('button', { name: 'Close', exact: true }).click()
    await zoom(1)
    await page.getByRole('tab', { name: /Untitled.sql/ }).click()
    await connect('read-write')
    await databaseAction(page, 'ER diagram')
    await expect(diagram().getByText('Diagram refreshed.', { exact: true })).toBeVisible()
    await diagram().getByText('Saved layouts (1)', { exact: true }).click()
    await diagram().getByLabel('Saved layout', { exact: true }).selectOption('Sales review')
    await diagram().getByRole('button', { name: 'Restore layout', exact: true }).click()
    await expect(diagram().getByText('Saved diagram layout restored.', { exact: true })).toBeVisible()
    await expect(table()).toHaveAttribute('transform', position!)
    await expect(diagram().getByLabel('Show columns', { exact: true })).not.toBeChecked()
    await expect(diagram().getByLabel('Diagram zoom')).toHaveText(zoomLabel)
    await zoom(2)
    await diagram().getByRole('button', { name: 'Restore layout', exact: true }).click({ trial: true })
    await capture('q2-diagram-light-200.png')
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
