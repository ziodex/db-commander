import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { engineSchema } from '../../src/shared/contracts'
import { builderTableKey } from '../../src/shared/query-builder'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { tableNode } from './explorer-actions'

for(const engine of engineSchema.options) test(`visual query builder ${engine}: joins, grouping, parameters and independent SQL tab`,async({},testInfo)=>{
  test.setTimeout(180000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-builder-ui-')),env:Record<string,string|undefined>={...process.env,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env:env as Record<string,string>}),page=await app.firstWindow()
  const q=(s:string)=>quoteIdentifier(s,engine),prefix='builder_ui_'+Date.now(),parent=prefix+'_parent',child=prefix+'_child',embedded=['sqlite','duckdb'].includes(engine)
  const schema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?'DBCOMMANDER':embedded?'main':'dbcommander',catalog=engine==='duckdb'?'data':undefined
  const full=(name:string)=>[catalog,schema,name].filter((s):s is string=>!!s).map(q).join('.'),dialog=page.getByRole('dialog',{name:'Visual query builder',exact:true})
  async function run(sql:string){await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled();await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(sql);await page.keyboard.press('Escape');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()}
  async function open(){await tableNode(page,parent).click({button:'right'});await page.getByRole('menuitem',{name:`Build query from ${parent}`,exact:true}).click();await expect(dialog).toBeVisible()}
  async function review(){await dialog.getByRole('button',{name:'Review builder SQL',exact:true}).click();await expect(dialog.getByLabel('Builder SQL preview')).toBeVisible({timeout:30000});await expect(dialog.getByRole('status')).toHaveText('SQL reviewed against current schema. No query executed.')}
  try {
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(embedded){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,'data.db'))}
    else{const key=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase();await form.getByLabel('Port',{exact:true}).fill(process.env[`SQLCOMMANDER_${key}_PORT`]!);await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(engine==='oracle'?'FREEPDB1':'dbcommander');await form.getByLabel('User',{exact:true}).fill('dbcommander');await form.getByLabel('Password',{exact:true}).fill(['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only');if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!,'utf8'))}}
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    await run(`CREATE TABLE ${full(parent)} (${q('id')} INTEGER,${q('label')} VARCHAR(40))`);await run(`CREATE TABLE ${full(child)} (${q('parent_id')} INTEGER,${q('amount')} INTEGER)`)
    await run(`INSERT INTO ${full(parent)} VALUES (1,'one')`);await run(`INSERT INTO ${full(parent)} VALUES (2,'two')`);await run(`INSERT INTO ${full(child)} VALUES (1,10)`);await run(`INSERT INTO ${full(child)} VALUES (1,20)`);if(engine==='oracle')await run('COMMIT')
    await page.getByLabel('Filter database objects').fill(prefix)
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await open()
    await expect(dialog.getByRole('button',{name:'Review builder SQL',exact:true})).toBeDisabled();await expect(dialog.getByRole('alert')).toContainText(/Commit or roll back/)
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42');const buffer=await page.locator('.monaco-editor').innerText(),history=(await page.evaluate(()=>window.dbCommander.history())).length
    await open();await expect(dialog.getByLabel('Output 1 column')).toHaveValue(JSON.stringify([0,'id']))
    await dialog.getByLabel('Join table',{exact:true}).selectOption(builderTableKey({catalog,schema,name:child}));await dialog.getByRole('button',{name:'Add join',exact:true}).click();await dialog.getByLabel('Join t2 type').selectOption('left')
    await expect(dialog.getByLabel('Query sources')).toContainText(`t2 · ${child}`)
    await dialog.getByRole('button',{name:'Add join key t2',exact:true}).click();await expect(dialog.getByLabel('Join t2 key 2 left')).toHaveValue(JSON.stringify([0,'id']));await dialog.getByRole('button',{name:'Remove join t2 key 2',exact:true}).click()
    await dialog.getByRole('button',{name:'Remove output 1',exact:true}).click();await dialog.getByLabel('Output 1 alias').fill('customer')
    await dialog.getByRole('button',{name:'Add output',exact:true}).click();await dialog.getByLabel('Output 2 column').selectOption(JSON.stringify([1,'amount']));await dialog.getByLabel('Output 2 aggregate').selectOption('sum');await dialog.getByLabel('Output 2 alias').fill('total')
    await dialog.getByRole('button',{name:'Add filter',exact:true}).click();await dialog.getByLabel('Filter 1 operator').selectOption('gte');await dialog.getByLabel('Filter 1 parameter').fill('min_id')
    await dialog.getByRole('button',{name:'Add HAVING condition',exact:true}).click();await dialog.getByLabel('Having 1 operator').selectOption('gte');await dialog.getByLabel('Having 1 parameter').fill('min_total')
    await dialog.getByRole('button',{name:'Add sort',exact:true}).click();await dialog.getByLabel('Sort 1 output').selectOption('1');await dialog.getByLabel('Sort 1 direction').selectOption('desc')
    await dialog.getByLabel('DISTINCT output rows').check();await dialog.getByLabel('Builder row limit').fill('2')
    await dialog.getByLabel('Filter 1 parameter').fill('invalid-name');await dialog.getByRole('button',{name:'Review builder SQL',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('parameter name');await expect(dialog.getByLabel('Builder SQL preview')).toHaveCount(0)
    await dialog.getByLabel('Filter 1 parameter').fill('min_id');await review()
    const preview=dialog.getByLabel('Builder SQL preview');expect(await preview.inputValue()).toContain('LEFT JOIN');expect(await preview.inputValue()).toContain('GROUP BY');expect(await preview.inputValue()).toContain('HAVING SUM(')
    await dialog.getByLabel('Builder row limit').fill('1');await expect(preview).toHaveCount(0);await review()
    await dialog.getByRole('button',{name:'Refresh builder schema',exact:true}).click();await expect(preview).toHaveCount(0);await expect(dialog.getByRole('button',{name:'Review builder SQL',exact:true})).toBeEnabled();await review()
    const sql=await preview.inputValue();expect(sql).toContain(':min_id');expect(sql).toContain(':min_total');expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(history)
    await dialog.getByRole('button',{name:'Copy builder SQL',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Builder SQL copied.');expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(sql)
    const path=join(directory,'visual-query.sql');await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path})},path);await dialog.getByRole('button',{name:'Save builder SQL',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Builder SQL saved.');expect(readFileSync(path,'utf8')).toBe(sql)
    await page.screenshot({path:testInfo.outputPath(`${engine}-query-builder-review.png`)})
    await dialog.getByLabel('Builder base table').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`${engine}-query-builder-design.png`)})
    if(engine==='duckdb'){await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(800,600);w.setSize(960,720)});await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(960);await dialog.getByRole('button',{name:'Open SQL in new tab',exact:true}).scrollIntoViewIfNeeded();const bounds=await dialog.boundingBox();expect(bounds!.width).toBeLessThanOrEqual(960);expect(bounds!.height).toBeLessThanOrEqual(720);expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);await page.screenshot({path:testInfo.outputPath('query-builder-small.png')})}
    await dialog.getByRole('button',{name:'Open SQL in new tab',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.getByRole('tab',{name:'visual-query.sql',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled();expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(history)
    await page.getByRole('button',{name:/^Run SQL/}).click();const params=page.getByRole('dialog',{name:'Query parameters',exact:true});await expect(params).toBeVisible()
    for(const name of ['min_id','min_total']){await params.getByLabel(`Type for ${name}`).selectOption('integer');await params.getByLabel(`Value for ${name}`).fill('1')}
    await params.getByRole('button',{name:'Run with parameters',exact:true}).click();await expect(params).not.toBeVisible();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.locator('.results-region')).toContainText('one');await expect(page.locator('.results-region')).toContainText('30')
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('tab',{name:'Untitled.sql',exact:true}).click();await expect(page.locator('.transaction-badge')).not.toHaveText('In transaction');await expect.poll(()=>page.locator('.monaco-editor').innerText()).toBe(buffer);await expect(page.locator('.results-region')).toContainText('42')
    await page.getByRole('tab',{name:'visual-query.sql',exact:true}).click();await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await page.getByRole('tab',{name:'Untitled.sql',exact:true}).click();await run(`DROP TABLE ${full(child)}`);await run(`DROP TABLE ${full(parent)}`)
    // The database menu and command palette open a fresh design as well.
    await page.locator('.database-node.current > button').first().click({button:'right'});await page.getByRole('menuitem',{name:'Visual query builder',exact:true}).click();await expect(dialog.getByLabel('Builder base table')).toHaveValue('');await dialog.getByRole('button',{name:'Close query builder',exact:true}).click()
    await page.getByRole('button',{name:'Commands',exact:true}).click();await page.getByRole('button',{name:'Visual query builder',exact:true}).click();await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible()
  } finally {await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});rmSync(directory,{recursive:true,force:true})}
})
