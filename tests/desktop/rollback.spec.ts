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
  }),{sessionId,sql});expect(result.status,result.error).toBe('completed')
}
for(const engine of engineSchema.options)test(`rollback inspection ${engine}: retained transaction, manual refresh and preserved editor`,async({},testInfo)=>{
  test.setTimeout(180000);test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-rollback-ui-')),embedded=['sqlite','duckdb'].includes(engine),tds=['sqlserver','azure-sql'].includes(engine),key=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase()
  const config:ConnectionConfig={engine,name:'Rollback fixture',host:'localhost',port:embedded?1:Number(process.env[`SQLCOMMANDER_${key}_PORT`]),database:engine==='oracle'?'FREEPDB1':'dbcommander',user:'dbcommander',password:tds?'Local-Test-Only!2026':'local-test-only',tls:embedded?'disable':'verify-full',...(!embedded&&engine!=='oracle'?{ca:readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!,'utf8')}:{})}
  const fixture=activityMonitor(config);fixture.enableRollback()
  const env:Record<string,string|undefined>={...process.env,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env:env as Record<string,string>}),page=await app.firstWindow(),inspector=page.getByRole('dialog',{name:'Sessions and locks',exact:true}),panel=inspector.getByRole('region',{name:'Rollback progress inspection'})
  let holder='',nativeHolder='',table=''
  const q=(s:string)=>quoteIdentifier(s,engine),begin=engine==='oracle'?'SAVEPOINT ROLLBACK_UI':tds?'BEGIN TRANSACTION':'BEGIN'
  async function open(){await expect(page.getByRole('button',{name:'Refresh schema',exact:true})).toBeEnabled({timeout:60000});await page.getByRole('button',{name:'Commands',exact:true}).click();await page.getByRole('button',{name:'Sessions and locks',exact:true}).click();await expect(inspector.getByRole('status')).toHaveText('Inspection complete. No session was changed.',{timeout:30000})}
  async function select(){await inspector.getByRole('button',{name:`Inspect session ${nativeHolder}`,exact:true}).click()}
  async function refresh(){await panel.getByRole('button',{name:'Refresh rollback progress',exact:true}).click();await expect(panel.getByRole('button',{name:'Refresh rollback progress',exact:true})).toBeEnabled()}
  try {
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(embedded){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,'data.db'))}
    else{await form.getByLabel('Port',{exact:true}).fill(String(config.port));await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(config.database);await form.getByLabel('User',{exact:true}).fill(fixture.config.user);await form.getByLabel('Password',{exact:true}).fill(fixture.config.password);if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(config.ca!)}}
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    const actorConfig={...config,...(embedded?{filePath:join(directory,'data.db'),sqliteMode:'read-write' as const,duckdbMode:'read-write' as const}:{})}
    holder=(await page.evaluate(c=>window.dbCommander.connect(c),actorConfig)).id
    nativeHolder=(await page.evaluate(sessionId=>window.dbCommander.inspectActivity({sessionId,includeSql:false}),holder)).currentSessionId
    if(!embedded){
      const schema=engine==='postgres'?'public':tds?'dbo':engine==='oracle'?'DBCOMMANDER':'dbcommander';table=`${q(schema)}.${q('rollback_ui_'+Date.now())}`
      await execute(page,holder,`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await execute(page,holder,`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await execute(page,holder,'COMMIT')
      await execute(page,holder,begin);await execute(page,holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`)
    }
    await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42');await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.locator('.results-region')).toContainText('42')
    const buffer=await page.locator('.monaco-editor').innerText(),history=(await page.evaluate(()=>window.dbCommander.history())).length
    await open();await select();await inspector.getByRole('button',{name:'Inspect rollback progress',exact:true}).click();await expect(panel).toBeVisible();await expect(panel.getByRole('heading',{name:/^Rollback progress/})).toBeInViewport();await expect(panel).toBeFocused()
    await expect(panel).toContainText(embedded?'Progress inspection not supported':'Transaction observed');await expect(panel).toContainText('No percentage or estimated completion time is available.');await expect(panel).toContainText('absence never proves rollback completed')
    if(embedded)await expect(panel).toContainText('No transaction identity was captured')
    const identity=embedded?'':await panel.locator('.rollback-identity').innerText()
    await refresh();expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(history)
    if(!embedded){
      await expect(panel.locator('.rollback-identity')).toHaveText(identity)
      await execute(page,holder,'ROLLBACK')
      await expect(async()=>{await refresh();await expect(panel).toContainText('Captured transaction no longer visible')}).toPass({timeout:10000})
      await execute(page,holder,begin);await execute(page,holder,`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`)
      await refresh();await expect(panel).toContainText('Captured transaction no longer visible');await expect(panel.locator('.rollback-identity')).toHaveText(identity)
      await inspector.getByRole('button',{name:'Refresh sessions and locks',exact:true}).click();await expect(inspector.getByRole('status')).toHaveText('Inspection complete. No session was changed.');await expect(panel.locator('.rollback-identity')).toHaveText(identity)
      await select();await inspector.getByRole('button',{name:'Inspect rollback progress',exact:true}).click();await expect(panel).toContainText('Transaction observed');await expect(panel.locator('.rollback-identity')).not.toHaveText(identity)
    }
    await panel.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`${engine}-rollback.png`)})
    if(engine==='postgres'||engine==='duckdb'){
      await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(800,600);w.setSize(960,720)})
      await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(960);expect(await inspector.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true)
      await panel.getByRole('button',{name:'Refresh rollback progress',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`${engine}-rollback-small.png`)})
    }
    await panel.getByRole('button',{name:'Dismiss rollback inspection',exact:true}).click();await expect(panel).not.toBeVisible()
    await page.keyboard.press('Escape');await expect(inspector).not.toBeVisible();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await expect.poll(()=>page.locator('.monaco-editor').innerText()).toBe(buffer);await expect(page.locator('.results-region')).toContainText('42')
    await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await open();await expect(panel).not.toBeVisible();await page.keyboard.press('Escape')
  } finally {
    if(holder){await execute(page,holder,'ROLLBACK').catch(()=>{});if(table)await execute(page,holder,`DROP TABLE ${table}`).catch(()=>{});await page.evaluate(id=>window.dbCommander.disconnect(id),holder).catch(()=>{})}
    await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
})
