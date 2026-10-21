import { _electron as electron, test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { queryTool } from './workspace-actions'

for (const engine of engineSchema.options) test(`parameter export ${engine}: review, binding, cancellation and private values`, async ({}, testInfo) => {
  test.setTimeout(90000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-export-ui-')), userData = join(directory, 'profile')
  const env: Record<string, string> = { ...process.env, SQLCOMMANDER_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const from = engine === 'oracle' ? ' FROM dual' : '', q = (s: string) => quoteIdentifier(s, engine)
  const secret = "ui-export-secret O'Brien Ω ; DELETE FROM customers; --", file = join(directory, 'bound.json')
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) await form.getByLabel('Open mode').selectOption('memory')
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled({ timeout: 30000 })
    async function enter(sql: string) { await page.locator('.monaco-editor').click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape') }
    await enter(`SELECT 42 AS ${q('previous')}${from}`); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText('Completed')
    const historyBefore = await page.evaluate(async () => window.dbCommander.history())
    const digits = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS n${from}`).join(' UNION ALL ')
    const sql = `SELECT n AS ${q('id')}, :value AS ${q('label')}, :exact AS ${q('exact')} FROM (SELECT a.n+10*b.n+100*c.n AS n FROM (${digits(10)}) a CROSS JOIN (${digits(10)}) b CROSS JOIN (${digits(13)}) c) numbers WHERE n<:maximum ORDER BY n`
    const selection = `SELECT :value AS ${q('label')}${from}`, document = `DELETE FROM customers;\n${selection}`
    await enter(document)
    for (let i = 0; i < selection.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await queryTool(page, 'Data import and export')
    const transfer = page.getByRole('dialog', { name: 'Data import and export', exact: true })
    await expect(transfer.getByLabel('SQL to execute for export')).toHaveValue(selection)
    await transfer.getByLabel('SQL to execute for export').fill(sql)
    await transfer.getByLabel('Data format').selectOption('json'); await transfer.getByLabel('New export file').fill(file)
    await transfer.getByRole('checkbox').check(); await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: 'Query parameters', exact: true })
    await expect(prompt.getByLabel('Parameterized SQL')).toHaveValue(sql)
    await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(transfer).toBeVisible(); expect(existsSync(file)).toBe(false)
    expect(await page.evaluate(async () => window.dbCommander.transferJobs())).toEqual([])
    await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(prompt.getByLabel('Value for value', { exact: true })).toHaveValue('')
    await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
    for (const [name, value] of [['exact', '9223372036854775808'], ['maximum', '1205']]) {
      await prompt.getByLabel(`Type for ${name}`, { exact: true }).selectOption('integer'); await prompt.getByLabel(`Value for ${name}`, { exact: true }).fill(value)
    }
    await prompt.getByRole('button', { name: 'Export with parameters', exact: true }).click()
    await expect(prompt.getByRole('alert')).toContainText('signed 64-bit'); expect(existsSync(file)).toBe(false)
    await prompt.getByLabel('Value for exact', { exact: true }).fill('9223372036854775807')
    await page.screenshot({ path: testInfo.outputPath(`${engine}-export-parameters.png`) })
    await prompt.getByRole('button', { name: 'Export with parameters', exact: true }).click()
    await expect(prompt).not.toBeVisible(); await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows')
    const data = JSON.parse(readFileSync(file, 'utf8')); expect(data.rows).toHaveLength(1205)
    expect(data.rows[0]).toEqual(['0', secret, '9223372036854775807']); expect(data.rows.at(-1)).toEqual(['1204', secret, '9223372036854775807'])
    expect(await page.evaluate(async () => window.dbCommander.history())).toEqual(historyBefore)
    expect(JSON.stringify(await page.evaluate(async () => window.dbCommander.transferJobs()))).not.toContain(secret)
    await transfer.getByRole('button', { name: 'Configure another transfer', exact: true }).click()
    await transfer.getByRole('checkbox').check(); await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(prompt.getByLabel('Value for value', { exact: true })).toHaveValue(''); await expect(prompt.getByLabel('Type for exact', { exact: true })).toHaveValue('text')
    await page.keyboard.press('Escape'); await expect(prompt).not.toBeVisible(); await expect(transfer).toBeVisible()
    await transfer.getByRole('button', { name: 'Close data transfer', exact: true }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => { const w = await window.dbCommander.loadWorkspace(); return w?.tabs.find(t => t.id === w.activeTabId)?.sql })).toBe(document)
    for (const name of readdirSync(userData).filter(name => name.startsWith('workspace.sqlite'))) expect(readFileSync(join(userData, name)).includes(Buffer.from(secret))).toBe(false)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
