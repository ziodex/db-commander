import { _electron as electron,test,expect,type Page } from '@playwright/test'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { engineSchema,type ConnectionConfig } from '../../src/shared/contracts'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { activityMonitor } from '../activity-fixture'

async function execute(page:Page,sessionId:string,sql:string) {
  const result=await page.evaluate(({sessionId,sql})=>new Promise<{status:string;error?:string}>(async(resolve,reject)=>{
    const off=window.dbCommander.onEvent(e=>{if(e.type==='complete'&&e.sessionId===sessionId){off();resolve(e)}})
    try{await window.dbCommander.run({sessionId,sql,maxRows:20})}catch(error){off();reject(error)}
  }),{sessionId,sql})
  expect(result.status,result.error).toBe('completed')
}
for(const engine of engineSchema.options)test(`session inspection ${engine}: live locks, privacy, reports and preserved transactions`,async({},testInfo)=>{
  test.setTimeout(180000);test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-activity-ui-')),embedded=['sqlite','duckdb'].includes(engine),key=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase()
  const config:ConnectionConfig={engine,name:'Inspection fixture',host:'localhost',port:embedded?1:Number(process.env[`SQLCOMMANDER_${key}_PORT`]),database:engine==='oracle'?'FREEPDB1':'dbcommander',user:'dbcommander',password:['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only',tls:embedded?'disable':'verify-full',...(!embedded&&engine!=='oracle'?{ca:readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!,'utf8')}:{})}
  const fixture=activityMonitor(config),env:Record<string,string|undefined>={...process.env,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env:env as Record<string,string>}),page=await app.firstWindow(),dialog=page.getByRole('dialog',{name:'Sessions and locks',exact:true})
  let holder:string|undefined,waiter:string|undefined,waitingId='',table=''
  const q=(s:string)=>quoteIdentifier(s,engine),name='inspect_ui_'+Date.now(),schema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?'SQLCOMMANDER':embedded?'main':'dbcommander'
  const begin=engine==='oracle'?'SAVEPOINT INSPECT_UI':['sqlserver','azure-sql'].includes(engine)?'BEGIN TRANSACTION':'BEGIN'
  async function open(){await page.locator('.database-node.current > button').first().click({button:'right'});await page.getByRole('menuitem',{name:'Sessions and locks',exact:true}).click();await expect(dialog).toBeVisible();await expect(dialog.getByRole('status')).toHaveText('Inspection complete. No session was changed.',{timeout:30000})}
  async function refresh(){await dialog.getByRole('button',{name:'Refresh sessions and locks',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Inspection complete. No session was changed.',{timeout:30000})}
  try {
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(embedded){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,'data.db'))}
    else {await form.getByLabel('Port',{exact:true}).fill(String(fixture.config.port));await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(fixture.config.database);await form.getByLabel('User',{exact:true}).fill(fixture.config.user);await form.getByLabel('Password',{exact:true}).fill(fixture.config.password);if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(fixture.config.ca!)}}
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    const actorConfig={...config,...(embedded?{filePath:join(directory,'data.db'),sqliteMode:'read-write' as const,duckdbMode:'read-write' as const}:{})}
    holder=(await page.evaluate(c=>window.dbCommander.connect(c),actorConfig)).id
    if(!embedded) {
      waiter=(await page.evaluate(c=>window.dbCommander.connect(c),config)).id;table=`${q(schema)}.${q(name)}`
      await execute(page,holder,`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await execute(page,holder,`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await execute(page,holder,'COMMIT')
      await execute(page,holder,begin);await execute(page,holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
      waitingId=(await page.evaluate(sessionId=>window.dbCommander.inspectActivity({sessionId,includeSql:false}),waiter)).currentSessionId
      await execute(page,waiter,begin)
      await page.evaluate(async({sessionId,sql})=>{
        (window as any).__activityWaitDone=false
        const off=window.dbCommander.onEvent(e=>{if(e.type==='complete'&&e.sessionId===sessionId){(window as any).__activityWaitDone=true;off()}})
        await window.dbCommander.run({sessionId,sql,maxRows:1})
      },{sessionId:waiter,sql:`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`})
    } else await execute(page,holder,begin)
    await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42');await page.keyboard.press('Escape');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.locator('.results-region')).toContainText('42')
    const buffer=await page.locator('.monaco-editor').innerText()
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.locator('.results-region')).toContainText('42');const history=(await page.evaluate(()=>window.dbCommander.history())).length
    await open();await expect(dialog.getByLabel('Include SQL text (may contain secrets)')).not.toBeChecked();await expect(dialog.getByLabel('Session SQL text')).toHaveCount(0)
    const file=join(directory,'inspection-private.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file)
    await dialog.getByRole('button',{name:'Save inspection report',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Session and lock report saved.')
    const captured=JSON.parse(readFileSync(file,'utf8'));expect(captured.includeSql).toBe(false);expect(captured.sessions.rows.every((r:any)=>r.query===null)).toBe(true)
    await dialog.getByRole('button',{name:'Save inspection report',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('EEXIST');expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(captured)
    await refresh();await dialog.getByRole('button',{name:/^Blocking relationships/}).click()
    if(embedded){await expect(dialog.getByRole('alert')).toContainText('Not supported');expect(captured.sessions.rows.some((r:any)=>r.transaction==='transaction')).toBe(true)}
    else {await expect(dialog.getByLabel('Inspection results')).toContainText(waitingId);await dialog.getByRole('button',{name:`Inspect waiting session ${waitingId}`,exact:true}).first().click();await expect(dialog.getByLabel('Selected session details')).toContainText(waitingId)}
    await page.screenshot({path:testInfo.outputPath(`${engine}-activity.png`)})
    await dialog.getByLabel('Include SQL text (may contain secrets)').check();await expect(dialog.getByRole('button',{name:'Save inspection report',exact:true})).toBeDisabled();await refresh()
    if(!embedded){await dialog.getByRole('button',{name:/^Sessions \(/}).click();await dialog.getByRole('button',{name:`Inspect session ${waitingId}`,exact:true}).click();const text=dialog.getByLabel('Session SQL text');await expect(text).toHaveValue(new RegExp(name));await dialog.getByRole('button',{name:'Copy session SQL',exact:true}).click();expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(await text.inputValue());await dialog.getByRole('button',{name:'Show selected session locks',exact:true}).click();await expect(dialog.getByLabel('Inspection results')).toContainText(waitingId)}
    const shownFile=join(directory,'inspection-sql.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},shownFile);await dialog.getByRole('button',{name:'Save inspection report',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Session and lock report saved.');expect(JSON.parse(readFileSync(shownFile,'utf8')).includeSql).toBe(true)
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true,filePath:''})});await dialog.getByRole('button',{name:'Save inspection report',exact:true}).click();await expect(dialog.getByRole('button',{name:'Save inspection report',exact:true})).toBeEnabled()
    await dialog.getByLabel('Filter sessions and locks').fill('no-such-session-xyz');if(!embedded)await expect(dialog.getByLabel('Inspection results').locator('tbody tr')).toHaveCount(0);await dialog.getByLabel('Filter sessions and locks').fill('')
    if(engine==='duckdb'){await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(800,600);w.setSize(960,720)});await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(960);expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);await page.screenshot({path:testInfo.outputPath('activity-small.png')})}
    expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(history)
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await expect.poll(()=>page.locator('.monaco-editor').innerText()).toBe(buffer);await expect(page.locator('.results-region')).toContainText('42')
    await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await page.getByRole('button',{name:'Commands',exact:true}).click();await page.getByRole('button',{name:'Sessions and locks',exact:true}).click();await expect(dialog).toBeVisible();await expect(dialog.getByLabel('Include SQL text (may contain secrets)')).not.toBeChecked();await dialog.getByRole('button',{name:'Close session inspection',exact:true}).click()
  } finally {
    if(holder)await execute(page,holder,'ROLLBACK').catch(()=>{})
    if(waiter){await expect.poll(()=>page.evaluate(()=>(window as any).__activityWaitDone),{timeout:15000}).toBe(true).catch(()=>{});await execute(page,waiter,'ROLLBACK').catch(()=>{});await page.evaluate(id=>window.dbCommander.disconnect(id),waiter).catch(()=>{})}
    if(holder){if(table)await execute(page,holder,`DROP TABLE ${table}`).catch(()=>{});await page.evaluate(id=>window.dbCommander.disconnect(id),holder).catch(()=>{})}
    await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
})
