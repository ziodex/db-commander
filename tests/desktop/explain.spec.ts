import { queryTool } from './workspace-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`explain ${engine}: selected SQL, native plans, saved output and preserved results`, async ({}, testInfo) => {
  test.setTimeout(150000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(),'dbcommander-explain-ui-')), env: Record<string,string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string,string> })
  const page = await app.firstWindow(), name = `plan_ui_${Date.now()}`, q = (value: string) => quoteIdentifier(value,engine), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function enter(sql: string) { await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(sql); await page.keyboard.press('Escape') }
  async function run(sql: string) { await enter(sql); await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed'); await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled() }
  const plan = page.getByRole('dialog', { name: 'Query plan', exact: true })
  try {
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite','duckdb'].includes(engine)) { await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory,'plans.db')) }
    else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port',{exact:true}).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database',{exact:true}).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User',{exact:true}).fill('dbcommander'); await form.getByLabel('Password',{exact:true}).fill(['sqlserver','azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate',{exact:true}).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!,'utf8')) }
    }
    await form.getByRole('button',{name:'Connect',exact:true}).click(); await expect(form).not.toBeVisible()
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY, ${q('value')} INTEGER)`)
    await run(`INSERT INTO ${q(name)} VALUES(1,10)`); if (engine === 'oracle') await run('COMMIT')
    await run(engine === 'oracle' ? 'SELECT 42 AS answer FROM dual' : 'SELECT 42 AS answer')
    const sql = `SELECT a.${q('id')} FROM ${q(name)} a JOIN ${q(name)} b ON a.${q('id')}=b.${q('id')} ORDER BY a.${q('id')}; -- captured statement`
    const buffer = `DELETE FROM ${q(name)};\n${sql}`
    await enter(buffer); for (let i=0; i<sql.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    const history = await page.evaluate(() => window.dbCommander.history())
    await queryTool(page, 'Explain selected SQL')
    await expect(plan.getByLabel('Plan mode')).toHaveValue('estimated')
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length)
    await plan.getByRole('button',{name:'Get estimated plan',exact:true}).click()
    await expect(plan.getByLabel('Captured plan')).toContainText('Estimated plan captured')
    if (engine === 'postgres') {
      await expect(plan.getByLabel('PostgreSQL plan tree')).toBeVisible()
      await plan.getByRole('button',{name:/^Plan node/}).last().click(); await expect(plan.getByRole('table',{name:'Plan node details'})).toContainText('Node Type')
      const collapse = plan.getByRole('button',{name:'Collapse node 1',exact:true})
      if (await collapse.count()) { await collapse.click(); await expect(plan.getByRole('button',{name:/^Plan node/})).toHaveCount(1); await plan.getByRole('button',{name:'Expand all nodes'}).click() }
      await page.screenshot({path:testInfo.outputPath('postgres-plan-tree.png')})
      await plan.getByRole('button',{name:'Raw plan',exact:true}).click()
    }
    await expect(plan.getByLabel('Raw query plan')).toHaveValue(/.+/)
    const marker = ['mysql','mariadb'].includes(engine) ? 'query_block' : engine === 'sqlite' ? 'SEARCH' : engine === 'oracle' ? 'SELECT STATEMENT' : engine === 'duckdb' ? 'JOIN' : engine === 'postgres' ? 'Node Type' : 'ShowPlanXML'
    await expect(plan.getByLabel('Raw query plan')).toHaveValue(new RegExp(marker))
    const output = await plan.getByLabel('Raw query plan').inputValue()
    await plan.getByRole('button',{name:'Copy plan',exact:true}).click(); expect(await app.evaluate(({clipboard}) => clipboard.readText())).toBe(output)
    const path = join(directory,'plan.txt')
    await app.evaluate(({dialog},path) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:path}) },path)
    await plan.getByRole('button',{name:'Save plan',exact:true}).click(); await expect(plan.getByText('Plan saved.',{exact:true})).toBeVisible(); expect(readFileSync(path,'utf8')).toBe(output)
    if (engine === 'postgres') {
      await plan.getByLabel('Plan mode').selectOption('analyze')
      await expect(plan.getByRole('button',{name:'Execute and analyze'})).toBeDisabled()
      await plan.getByRole('checkbox').check(); await plan.getByRole('button',{name:'Execute and analyze'}).click()
      await expect(plan.getByLabel('Captured plan')).toContainText('SQL executed with profiling')
      await plan.getByRole('button',{name:'Plan tree',exact:true}).click(); await expect(plan.getByLabel('PostgreSQL plan tree')).toContainText('Actual rows')
      await page.screenshot({path:testInfo.outputPath('postgres-actual-plan.png')})
    } else await expect(plan.getByLabel('Plan mode').locator('option[value="analyze"]')).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(plan).not.toBeVisible()
    await expect(page.getByRole('cell',{name:'42',exact:true})).toBeVisible()
    expect((await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs[0].sql).toBe(buffer)
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length+(engine === 'postgres' ? 2 : 1))
    await queryTool(page, 'Explain selected SQL'); await expect(plan.getByLabel('Captured plan')).toBeVisible()
    expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(history.length+(engine === 'postgres' ? 2 : 1))
    await plan.getByRole('button',{name:'Close query plan'}).click()
    await run(`SELECT COUNT(*) AS remaining FROM ${q(name)}`); await expect(page.getByRole('table',{name:'Query results',exact:true}).locator('[role=cell][tabindex="0"]')).toHaveText('1')
    await enter('SELECT * FROM no_such_plan_table_294782'); await queryTool(page, 'Explain selected SQL'); await plan.getByRole('button',{name:'Get estimated plan'}).click()
    await expect(plan.getByLabel('Captured plan').getByRole('alert')).toBeVisible(); await expect(plan.getByLabel('Raw query plan')).toHaveCount(0)
    await plan.getByRole('button',{name:'Close query plan'}).click(); await expect(page.getByRole('table',{name:'Query results',exact:true}).locator('[role=cell][tabindex="0"]')).toHaveText('1')
    if (engine === 'postgres') {
      await enter('SELECT pg_sleep(20)'); await queryTool(page, 'Explain selected SQL')
      await plan.getByLabel('Plan mode').selectOption('analyze'); await plan.getByRole('checkbox').check(); await plan.getByRole('button',{name:'Execute and analyze'}).click()
      await plan.getByRole('button',{name:'Cancel plan',exact:true}).click(); await expect(plan.getByLabel('Captured plan')).toContainText('cancellation requested')
      await plan.getByRole('button',{name:'Close query plan'}).click()
    }
    await run(`DROP TABLE ${q(name)}`)
  } finally { await app.close(); rmSync(directory,{recursive:true,force:true}) }
})
