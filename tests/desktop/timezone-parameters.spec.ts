import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { queryTool } from './workspace-actions'

for (const engine of engineSchema.options) test(`timezone parameters ${engine}: exact instants, validation, export and plans`, async ({}, testInfo) => {
  test.setTimeout(120000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-timezone-ui-')), userData = join(directory, 'profile')
  // Neo formats TIMESTAMPTZ using the process offset captured at module load.
  // A fixed non-UTC zone makes the exact display assertion independent of season.
  const env: Record<string, string> = { ...process.env, SQLCOMMANDER_USER_DATA: userData, TZ: 'Etc/GMT-5' }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow(), modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const from = engine === 'oracle' ? ' FROM dual' : '', q = (s: string) => quoteIdentifier(s, engine)
  const timestamp = '2026-10-25T02:30:00.123456+02:00', utc = '2026-10-25T00:30:00.123456+00:00'
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
    const before = await page.evaluate(() => window.dbCommander.history())
    const sql = `SELECT :moment AS ${q('moment')}${from}`
    const expected = [engine==='sqlite'?utc:engine==='duckdb'?'2026-10-25 05:30:00.123456+05':'2026-10-25 00:30:00.123456'+(engine==='oracle'?'000 +00:00':engine==='postgres'?'+00':['sqlserver','azure-sql'].includes(engine)?'+00:00':'')]
    const prompt = page.getByRole('dialog', {name:'Query parameters',exact:true})
    const values = [['moment','timestamptz',timestamp]]
    async function fill() { for (const [name,type,value] of values) { await prompt.getByLabel(`Type for ${name}`,{exact:true}).selectOption(type); await prompt.getByLabel(`Value for ${name}`,{exact:true}).fill(value) } }
    await enter(sql); await page.getByRole('button',{name:/^Run SQL/}).click()
    await fill(); await page.keyboard.press('Escape'); await expect(prompt).not.toBeVisible()
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
    await expect(page.getByRole('cell',{name:'42',exact:true})).toBeVisible()
    await page.getByRole('button',{name:/^Run SQL/}).click()
    await expect(prompt.getByLabel('Value for moment',{exact:true})).toHaveValue('')
    await expect(prompt.getByLabel('Type for moment',{exact:true})).toHaveValue('text')
    await fill()
    for (const [name,invalid,message,valid] of [['moment','2026-10-25T02:30:00','followed by Z or',timestamp],['moment','2026-10-25T02:30:00-00:00','excluding -00:00',timestamp],['moment','1000-01-01T00:00:00+01:00','Both local and UTC dates',timestamp],['moment','2026-10-25T02:30:00.1234567Z','Timestamp with timezone',timestamp]]) {
      await prompt.getByLabel(`Value for ${name}`,{exact:true}).fill(invalid)
      await prompt.getByRole('button',{name:'Run with parameters',exact:true}).click()
      await expect(prompt.getByRole('alert')).toContainText(message)
      expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
      await prompt.getByLabel(`Value for ${name}`,{exact:true}).fill(valid)
    }
    await expect(prompt).toContainText('original offset is not retained')
    if(engine==='sqlite')await expect(prompt).toContainText('UTC text')
    if(['mysql','mariadb'].includes(engine))await expect(prompt).toContainText('TIMESTAMP columns use the session timezone')
    await page.screenshot({path:testInfo.outputPath(`${engine}-timezone-parameters.png`)})
    await prompt.getByRole('button',{name:'Run with parameters',exact:true}).click()
    await expect(prompt).not.toBeVisible(); await expect(page.locator('.status-text')).toHaveText('Completed')
    for(const value of expected)await expect(page.getByRole('cell',{name:value,exact:true})).toBeVisible()
    const history = await page.evaluate(() => window.dbCommander.history())
    expect(history[0].parameters).toEqual(values.map(([name,type])=>({name,type})))
    for(const value of [timestamp,utc,expected[0]])expect(JSON.stringify(history)).not.toContain(value)
    await queryTool(page,'Explain selected SQL')
    const plan=page.getByRole('dialog',{name:'Query plan',exact:true})
    await plan.getByRole('button',{name:'Get estimated plan',exact:true}).click()
    await expect(prompt.getByLabel('Type for moment',{exact:true})).toHaveValue('text'); await fill()
    await prompt.getByRole('button',{name:'Explain with parameters',exact:true}).click()
    await expect(plan.getByLabel('Captured plan')).toContainText('Estimated plan captured')
    await plan.getByRole('button',{name:'Close query plan',exact:true}).click()
    for(const value of expected)await expect(page.getByRole('cell',{name:value,exact:true})).toBeVisible()
    await queryTool(page,'Data import and export')
    const transfer=page.getByRole('dialog',{name:'Data import and export',exact:true}), file=join(directory,'timezone.json')
    await transfer.getByLabel('Data format').selectOption('json'); await transfer.getByLabel('New export file').fill(file)
    await transfer.getByRole('checkbox').check(); await transfer.getByRole('button',{name:'Run and export',exact:true}).click()
    await expect(prompt.getByLabel('Value for moment',{exact:true})).toHaveValue(''); await fill()
    await prompt.getByRole('button',{name:'Export with parameters',exact:true}).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1 rows')
    expect(JSON.parse(readFileSync(file,'utf8')).rows).toEqual([expected])
    await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click()
    // SQL text, history metadata and jobs survive; supplied values do not.
    for(const value of [timestamp,utc,expected[0]]) {
      expect(JSON.stringify(await page.evaluate(()=>window.dbCommander.history()))).not.toContain(value)
      expect(JSON.stringify(await page.evaluate(()=>window.dbCommander.transferJobs()))).not.toContain(value)
    }
    await expect.poll(async()=>page.evaluate(async()=>{const w=await window.dbCommander.loadWorkspace();return w?.tabs.find(t=>t.id===w.activeTabId)?.sql})).toBe(sql)
    await page.getByRole('button',{name:/^Run SQL/}).click()
    for(const [name] of values) { await expect(prompt.getByLabel(`Value for ${name}`,{exact:true})).toHaveValue(''); await expect(prompt.getByLabel(`Type for ${name}`,{exact:true})).toHaveValue('text') }
    await prompt.getByRole('button',{name:'Cancel',exact:true}).click()
    await app.evaluate(({app})=>app.exit()); await app.close()
    for(const name of readdirSync(userData).filter(name=>name.startsWith('workspace')))for(const value of [timestamp,utc,expected[0]])expect(readFileSync(join(userData,name)).includes(Buffer.from(value))).toBe(false)
  } finally { await app.evaluate(({app})=>app.exit()).catch(()=>{}); await app.close().catch(()=>{}); rmSync(directory,{recursive:true,force:true}) }
})
