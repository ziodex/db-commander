import { tableAction } from './explorer-actions'
import { withClipboard } from './clipboard-fixture'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`inspection ${engine}: values, column controls and composite foreign-key navigation`, async ({}, testInfo) => {
  test.setTimeout(150000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(),'dbcommander-inspect-ui-')), env: Record<string,string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string,string> })
  const page = await app.firstWindow(), name = `inspect_ui_${Date.now()}`, q = (value: string) => quoteIdentifier(value,engine), key = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function enter(sql: string) {
    // Insert complete scripts as a paste. Simulated IME insertion can trigger
    // Monaco's quote completion and append a quote to otherwise valid T-SQL.
    await withClipboard(app, async () => {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), sql)
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.press(`${key}+V`); await page.keyboard.press('Escape')
      await expect.poll(async () => (await page.evaluate(() => window.dbCommander.loadWorkspace()))!.tabs[0].sql).toBe(sql)
    })
  }
  async function run(sql: string) {
    await enter(sql); await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect.poll(async () => ({ status: await page.locator('.status-text').innerText(), errors: await page.locator('.error-banner').allTextContents() })).toEqual({ status: 'Completed', errors: [] })
    await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
  }
  const inspector = page.getByRole('dialog',{name:'Value inspector',exact:true})
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
    const parent=name+'_parent', child=name+'_child', literal=(s:string)=>(['sqlserver','azure-sql'].includes(engine)?"N'":"'")+s.replaceAll("'","''")+"'",json='{"n":9007199254740993,"n":2,"s":"Ω"}',xml='<root><value>Ω &amp; safe</value></root>'
    const long=engine==='oracle'?`RPAD(TO_CLOB('x'),30000,'x')||'tail'`:engine==='sqlite'?`replace(hex(zeroblob(15000)),'0','x')||'tail'`:['sqlserver','azure-sql'].includes(engine)?`REPLICATE(CAST('x' AS varchar(max)),30000)+'tail'`:`concat(repeat('x',30000),'tail')`
    const textType=engine==='oracle'?'CLOB':['sqlserver','azure-sql'].includes(engine)?'NVARCHAR(MAX)':['mysql','mariadb'].includes(engine)?'LONGTEXT':'TEXT'
    const binaryType=engine==='postgres'?'BYTEA':engine==='oracle'?'RAW(20)':['sqlserver','azure-sql'].includes(engine)?'VARBINARY(20)':'BLOB'
    const binary=engine==='postgres'?"decode('00ff8041','hex')":engine==='oracle'?"HEXTORAW('00ff8041')":engine==='duckdb'?"from_hex('00ff8041')":['sqlserver','azure-sql'].includes(engine)?'0x00ff8041':"X'00ff8041'"
    await run(`CREATE TABLE ${q(parent)} (${q('tenant')} INTEGER,${q('code')} VARCHAR(40),${q('label')} VARCHAR(80),PRIMARY KEY(${q('tenant')},${q('code')}))`)
    await run(`CREATE TABLE ${q(child)} (${q('id')} INTEGER PRIMARY KEY,${q('tenant')} INTEGER,${q('code')} VARCHAR(40),${q('document')} ${textType},${q('markup')} ${textType},${q('payload')} ${binaryType},${q('large')} ${textType},FOREIGN KEY(${q('tenant')},${q('code')}) REFERENCES ${q(parent)}(${q('tenant')},${q('code')}))`)
    await run(`INSERT INTO ${q(parent)} VALUES(7,'key','right');INSERT INTO ${q(parent)} VALUES(8,'key','wrong')`)
    await run(`INSERT INTO ${q(child)} VALUES(1,7,'key',${literal(json)},${literal(xml)},${binary},${long})`)
    if(engine==='oracle')await run('COMMIT')
    const query=`SELECT ${long} AS ${q('large')},${literal(json)} AS ${q('document')},${literal(xml)} AS ${q('markup')},NULL AS ${q('missing')}${engine==='oracle'?' FROM dual':''}`
    await run(query)
    const results=page.getByRole('table',{name:'Query results',exact:true}),cell=(table:typeof results,index:number)=>table.getByRole('row').nth(1).getByRole('cell').nth(index+1)
    const history=(await page.evaluate(()=>window.dbCommander.history())).length
    await cell(results,0).dblclick();await expect(inspector.getByLabel('Inspected value')).toHaveValue('x'.repeat(30000)+'tail')
    await inspector.getByRole('button',{name:'Copy displayed value',exact:true}).click();expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe('x'.repeat(30000)+'tail')
    const saved=join(directory,'value.txt');await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path})},saved)
    await inspector.getByRole('button',{name:'Save displayed value',exact:true}).click();await expect(inspector.getByText('Displayed value saved.',{exact:true})).toBeVisible();expect(readFileSync(saved,'utf8')).toBe('x'.repeat(30000)+'tail')
    await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await page.getByRole('button',{name:'Columns',exact:true}).click()
    const columns=page.getByRole('dialog',{name:'Column controls',exact:true})
    await columns.getByLabel('Show column 1 large',{exact:true}).uncheck();await columns.getByLabel('Width column 2',{exact:true}).fill('320');await columns.getByLabel('Pin column 2',{exact:true}).check()
    await columns.getByRole('button',{name:'Move column 2 right',exact:true}).click();await columns.getByRole('button',{name:'Done',exact:true}).click()
    await expect(results).toHaveAttribute('aria-colcount','4')
    await expect(results.getByRole('columnheader').nth(1)).toContainText('document')
    expect(await cell(results,0).evaluate(node=>Math.round(node.getBoundingClientRect().width))).toBe(320)
    const resize = results.getByRole('separator', { name: 'Resize column 2 document', exact: true })
    await resize.focus(); await page.keyboard.press('ArrowRight'); await expect(resize).toHaveAttribute('aria-valuenow','330')
    await expect.poll(()=>cell(results,0).evaluate(node=>Math.round(node.getBoundingClientRect().width))).toBe(330)
    await page.keyboard.press('ArrowLeft'); await expect(resize).toHaveAttribute('aria-valuenow','320')
    await cell(results,0).focus();await page.keyboard.press('Enter');await inspector.getByLabel('Value format').selectOption('json')
    await expect(inspector.getByLabel('Inspected value')).toHaveValue(/9007199254740993/);expect((await inspector.getByLabel('Inspected value').inputValue()).match(/"n"/g)).toHaveLength(2)
    await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await cell(results,1).dblclick();await inspector.getByLabel('Value format').selectOption('xml');await expect(inspector).toContainText('Valid XML');await expect(inspector.getByLabel('Inspected value')).toHaveValue(xml)
    await page.screenshot({path:testInfo.outputPath(engine+'-xml-inspector.png')})
    await inspector.getByLabel('Value format').selectOption('json');await expect(inspector.getByRole('alert')).toBeVisible();await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await cell(results,2).dblclick();await expect(inspector).toContainText('SQL NULL');await expect(inspector.getByRole('button',{name:'Copy displayed value'})).toBeDisabled();await page.keyboard.press('Escape')
    expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(history)
    await tableAction(page, `${child}`, 'Browse data');await expect(page.locator('.status-text')).toHaveText('Table loaded')
    const table=page.getByRole('table',{name:'Table data',exact:true})
    await cell(table,6).dblclick();await inspector.getByRole('button',{name:'Load live value',exact:true}).click();await expect(inspector.getByLabel('Inspected value')).toHaveValue('x'.repeat(30000)+'tail');await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await cell(table,5).dblclick();await inspector.getByRole('button',{name:'Load live value',exact:true}).click();await expect(inspector.getByLabel('Inspected value')).toHaveValue(/00ff8041/i);await inspector.getByLabel('Value format').selectOption('hex');await expect(inspector.getByLabel('Inspected value')).toHaveValue(/00 ff 80 41/);await page.screenshot({path:testInfo.outputPath(engine+'-hex-inspector.png')});await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await cell(table,2).dblclick();await inspector.getByRole('button',{name:'Find foreign keys',exact:true}).click();await inspector.getByRole('button',{name:/^Follow /}).click()
    await expect(page.locator('.status-text')).toHaveText('Referenced table loaded');await expect(table.getByRole('cell',{name:'right',exact:true})).toBeVisible();await expect(table.getByRole('cell',{name:'wrong',exact:true})).toHaveCount(0)
    await page.getByRole('button',{name:'Back to source table',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Table loaded');await expect(cell(table,2)).toHaveText('key')
    await page.getByRole('button',{name:'Close data',exact:true}).click();await expect(results.getByRole('columnheader').nth(1)).toContainText('document')
    expect((await page.evaluate(()=>window.dbCommander.loadWorkspace()))!.tabs[0].sql).toBe(query)
    // Display reordering must not change edit ordinals or discard hidden drafts.
    await tableAction(page, `${parent}`, 'Edit data');await expect(page.locator('.status-text')).toHaveText('Table loaded')
    await page.getByRole('textbox',{name:'Row 1 label',exact:true}).fill('staged')
    await page.getByRole('separator',{name:'Resize column 3 label',exact:true}).focus();await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('textbox',{name:'Row 1 label',exact:true})).toHaveValue('staged')
    await page.getByRole('button',{name:'Columns',exact:true}).click();await columns.getByRole('button',{name:'Move column 3 left',exact:true}).click();await columns.getByLabel('Show column 3 label',{exact:true}).uncheck()
    await columns.getByRole('button',{name:'Save table layout',exact:true}).click();await expect(columns.getByText('Table layout saved.',{exact:true})).toBeVisible()
    const savedLayouts=(await page.evaluate(()=>window.dbCommander.loadWorkspace()))!.tableLayouts!
    expect(savedLayouts).toHaveLength(1);expect(savedLayouts[0].layout.hidden).toEqual([2]);expect(JSON.stringify(savedLayouts)).not.toContain('staged')
    await columns.getByRole('button',{name:'Done',exact:true}).click()
    await expect(page.getByRole('button',{name:'Apply edits',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Apply edits',exact:true}).click();await expect(page.getByRole('button',{name:'Rollback',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`DROP TABLE ${q(child)}`);await run(`DROP TABLE ${q(parent)}`)
    // Duplicate aliases retain their original ordinals; XML declarations stay inert.
    const declared='<!DOCTYPE root [<!ENTITY example "not expanded">]><root>&example;</root>'
    await run(`SELECT ${literal(declared)} AS ${q('duplicate')},'second' AS ${q('duplicate')}${engine==='oracle'?' FROM dual':''}`)
    await cell(results,0).dblclick();await inspector.getByLabel('Value format').selectOption('xml')
    await expect(inspector.getByRole('alert')).toContainText('DTD and entity declarations are not processed')
    await expect(inspector.getByLabel('Inspected value')).toHaveValue(declared);await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await page.getByRole('button',{name:'Columns',exact:true}).click();await columns.getByLabel('Show column 1 duplicate',{exact:true}).uncheck();await columns.getByRole('button',{name:'Done',exact:true}).click()
    await cell(results,0).dblclick();await expect(inspector.getByLabel('Inspected value')).toHaveValue('second');await inspector.getByRole('button',{name:'Close value inspector'}).click()
    await run(Array.from({length:40},(_,i)=>`SELECT ${i} AS ${q('id')},'pinned' AS ${q('label')}${engine==='oracle'?' FROM dual':''}`).join(' UNION ALL '))
    await page.getByRole('button',{name:'Columns',exact:true}).click();await columns.getByLabel('Pin column 2',{exact:true}).check();await columns.getByRole('button',{name:'Done',exact:true}).click()
    await results.evaluate(node=>{node.scrollTop=180})
    // Sticky body cells must not paint over the header when scrolling vertically.
    const pinnedHeader=results.getByRole('columnheader').nth(1)
    await expect(pinnedHeader).toContainText('label')
    await expect.poll(()=>pinnedHeader.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role="columnheader"]')?.textContent??''})).toContain('label')
  } finally {
    // A failed UI assertion may leave edits/transactions behind. Do not let
    // the application's native Quit confirmation hide the original failure.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
