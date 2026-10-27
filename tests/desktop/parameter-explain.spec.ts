import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { queryTool } from './workspace-actions'

for (const engine of engineSchema.options) test(`parameter explain ${engine}: selected SQL, binding, confirmation and private values`, async ({}, testInfo) => {
  test.setTimeout(90000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-explain-ui-')), userData = join(directory, 'profile')
  const env: Record<string, string> = { ...process.env, SQLCOMMANDER_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const from = engine === 'oracle' ? ' FROM dual' : '', q = (s: string) => quoteIdentifier(s, engine)
  const secret = "ui-plan-secret O'Brien Ω ; DELETE FROM customers; --"
  try {
    await waitForWorkspaceReady(page)
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
    const before = await page.evaluate(() => window.dbCommander.history())
    const selection = `SELECT :value AS ${q('label')}, :id AS ${q('number')}${from}`
    const document = `DELETE FROM must_never_execute;\n${selection}`
    await enter(document)
    for (let i = 0; i < selection.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await queryTool(page, 'Explain selected SQL')
    const plan = page.getByRole('dialog', { name: 'Query plan', exact: true })
    const prompt = page.getByRole('dialog', { name: 'Query parameters', exact: true })
    await plan.getByRole('button', { name: 'Get estimated plan', exact: true }).click()
    await expect(prompt.getByLabel('Parameterized SQL')).toHaveValue(selection)
    await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
    await page.keyboard.press('Escape'); await expect(prompt).not.toBeVisible(); await expect(plan).toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
    await plan.getByRole('button', { name: 'Get estimated plan', exact: true }).click()
    await expect(prompt.getByLabel('Value for value', { exact: true })).toHaveValue('')
    await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
    await prompt.getByLabel('Type for id', { exact: true }).selectOption('integer')
    await prompt.getByLabel('Value for id', { exact: true }).fill('9223372036854775808')
    await prompt.getByRole('button', { name: 'Explain with parameters', exact: true }).click()
    await expect(prompt.getByRole('alert')).toContainText('signed 64-bit')
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
    await prompt.getByLabel('Value for id', { exact: true }).fill('9223372036854775807')
    await prompt.getByRole('button', { name: 'Explain with parameters', exact: true }).click()
    await expect(prompt).not.toBeVisible()
    await expect(plan.getByLabel('Captured plan')).toContainText('Estimated plan captured')
    await expect(plan).toContainText('Plans can include those values')
    const history = await page.evaluate(() => window.dbCommander.history())
    expect(history.length).toBe(before.length + 1)
    expect(history[0].parameters).toEqual([{ name: 'value', type: 'text' }, { name: 'id', type: 'integer' }])
    expect(JSON.stringify(history)).not.toContain(secret)
    await page.screenshot({ path: testInfo.outputPath(`${engine}-bound-plan.png`) })
    if (engine === 'postgres') {
      await plan.getByLabel('Plan mode').selectOption('analyze')
      await expect(plan.getByRole('button', { name: 'Execute and analyze', exact: true })).toBeDisabled()
      await plan.getByRole('checkbox').check()
      await plan.getByRole('button', { name: 'Execute and analyze', exact: true }).click()
      await expect(prompt.getByLabel('Value for value', { exact: true })).toHaveValue('')
      await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
      await prompt.getByLabel('Type for id', { exact: true }).selectOption('integer')
      await prompt.getByLabel('Value for id', { exact: true }).fill('5')
      await prompt.getByRole('button', { name: 'Execute and analyze with parameters', exact: true }).click()
      await expect(plan.getByLabel('Captured plan')).toContainText('SQL executed with profiling')
      await expect(plan.getByRole('button', { name: 'Execute and analyze', exact: true })).toBeDisabled()
      await plan.getByLabel('Plan mode').selectOption('estimated')
    }
    await plan.getByRole('button', { name: 'Get estimated plan', exact: true }).click()
    await expect(prompt.getByLabel('Value for value', { exact: true })).toHaveValue('')
    await expect(prompt.getByLabel('Type for id', { exact: true })).toHaveValue('text')
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await plan.getByRole('button', { name: 'Close query plan', exact: true }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => { const w = await window.dbCommander.loadWorkspace(); return w?.tabs.find(t => t.id === w.activeTabId)?.sql })).toBe(document)
    // A failed plan must not retain values from server diagnostics either.
    await enter('SELECT :value FROM no_such_bound_plan_table')
    await queryTool(page, 'Explain selected SQL')
    await plan.getByRole('button', { name: 'Get estimated plan', exact: true }).click()
    await prompt.getByLabel('Value for value', { exact: true }).fill(secret)
    await prompt.getByRole('button', { name: 'Explain with parameters', exact: true }).click()
    await expect(plan.getByLabel('Captured plan').getByRole('alert')).toContainText('diagnostics are hidden')
    await expect(plan.getByLabel('Raw query plan')).toHaveCount(0)
    expect(JSON.stringify(await page.evaluate(() => window.dbCommander.history()))).not.toContain(secret)
    await plan.getByRole('button', { name: 'Close query plan', exact: true }).click()
    await app.evaluate(({ app }) => app.exit()); await app.close()
    for (const name of readdirSync(userData).filter(name => name.startsWith('workspace'))) expect(readFileSync(join(userData, name)).includes(Buffer.from(secret))).toBe(false)
  } finally { await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
