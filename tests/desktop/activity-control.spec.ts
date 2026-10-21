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
for(const engine of engineSchema.options)test(`session controls ${engine}: review, stale identity, cancellation and termination`,async({},testInfo)=>{
  test.setTimeout(180000);test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-control-ui-')),embedded=['sqlite','duckdb'].includes(engine),tds=['sqlserver','azure-sql'].includes(engine),key=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase()
  const config:ConnectionConfig={engine,name:'Control fixture',host:'localhost',port:embedded?1:Number(process.env[`SQLCOMMANDER_${key}_PORT`]),database:engine==='oracle'?'FREEPDB1':'dbcommander',user:'dbcommander',password:tds?'Local-Test-Only!2026':'local-test-only',tls:embedded?'disable':'verify-full',...(!embedded&&engine!=='oracle'?{ca:readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!,'utf8')}:{})}
  const fixture=activityMonitor(config,true),env:Record<string,string|undefined>={...process.env,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env:env as Record<string,string>}),page=await app.firstWindow(),inspector=page.getByRole('dialog',{name:'Sessions and locks',exact:true}),review=page.getByRole('dialog',{name:'Review session action',exact:true})
  let holder='',waiter='',nativeHolder='',nativeWaiter='',table='',terminated=false
  const q=(s:string)=>quoteIdentifier(s,engine),begin=engine==='oracle'?'SAVEPOINT CONTROL_UI':tds?'BEGIN TRANSACTION':'BEGIN'
  async function refresh(){await inspector.getByRole('button',{name:'Refresh sessions and locks',exact:true}).click();await expect(inspector.getByRole('status')).toHaveText('Inspection complete. No session was changed.',{timeout:30000})}
  async function select(id:string){await inspector.getByRole('button',{name:/^Sessions \(/}).click();await inspector.getByRole('button',{name:`Inspect session ${id}`,exact:true}).click()}
  async function startWait(){await execute(page,waiter,begin);await page.evaluate(async({sessionId,sql})=>{
    (window as any).__controlDone=false
    const off=window.dbCommander.onEvent(e=>{if(e.type==='complete'&&e.sessionId===sessionId){(window as any).__controlDone=e.status;off()}})
    await window.dbCommander.run({sessionId,sql,maxRows:1})
  },{sessionId:waiter,sql:`UPDATE ${table} SET ${q('value')}=12 WHERE ${q('id')}=1`})}
  async function confirm(action:'cancellation'|'termination',id:string){const button=review.getByRole('button',{name:`Apply reviewed ${action}`,exact:true});await expect(button).toBeDisabled();await review.getByLabel('I understand the transaction and connection impact.').check();await review.getByLabel('Session action confirmation').fill(`${action==='cancellation'?'CANCEL':'TERMINATE'} ${id}`);await expect(button).toBeEnabled();await button.click()}
  try {
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible({timeout:30000});await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(embedded){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,'data.db'))}
    else{await form.getByLabel('Port',{exact:true}).fill(String(config.port));await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(config.database);await form.getByLabel('User',{exact:true}).fill(fixture.config.user);await form.getByLabel('Password',{exact:true}).fill(fixture.config.password);if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(config.ca!)}}
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    const actorConfig={...config,...(embedded?{filePath:join(directory,'data.db'),sqliteMode:'read-write' as const,duckdbMode:'read-write' as const}:{})}
    holder=(await page.evaluate(c=>window.dbCommander.connect(c),actorConfig)).id
    nativeHolder=(await page.evaluate(sessionId=>window.dbCommander.inspectActivity({sessionId,includeSql:false}),holder)).currentSessionId
    if(!embedded){
      waiter=(await page.evaluate(c=>window.dbCommander.connect(c),actorConfig)).id;nativeWaiter=(await page.evaluate(sessionId=>window.dbCommander.inspectActivity({sessionId,includeSql:false}),waiter)).currentSessionId
      const schema=engine==='postgres'?'public':tds?'dbo':engine==='oracle'?'SQLCOMMANDER':'dbcommander';table=`${q(schema)}.${q('control_ui_'+Date.now())}`
      await execute(page,holder,`CREATE TABLE ${table} (${q('id')} INTEGER PRIMARY KEY,${q('value')} INTEGER)`);await execute(page,holder,`INSERT INTO ${table} VALUES(1,10)`);if(engine==='oracle')await execute(page,holder,'COMMIT')
      await execute(page,holder,begin);await execute(page,holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`);await startWait()
    }
    await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42');await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.locator('.results-region')).toContainText('42')
    const buffer=await page.locator('.monaco-editor').innerText(),history=(await page.evaluate(()=>window.dbCommander.history())).length
    await page.getByRole('button',{name:'Commands',exact:true}).click();await page.getByRole('button',{name:'Sessions and locks',exact:true}).click();await expect(inspector.getByRole('status')).toHaveText('Inspection complete. No session was changed.',{timeout:30000})
    await select(nativeHolder)
    if(embedded){await expect(inspector.getByRole('button',{name:'Review termination',exact:true})).toBeDisabled();await expect(inspector.getByLabel('Session controls')).toContainText('no server administration API')}
    else {
      if(tds)await expect(inspector.getByRole('button',{name:'Review cancellation',exact:true})).toBeDisabled()
      else {
        await select(nativeWaiter);await inspector.getByRole('button',{name:'Review cancellation',exact:true}).click();await expect(review).toBeVisible();await expect(review.getByLabel('Reviewed session command')).not.toHaveValue('')
        await page.keyboard.press('Escape');await expect(review).not.toBeVisible();await expect(inspector).toBeVisible();expect(await page.evaluate(()=>(window as any).__controlDone)).toBe(false)
        await inspector.getByRole('button',{name:'Review cancellation',exact:true}).click();await expect(review).toBeVisible()
        // Completing the reviewed query makes its cancellation ticket unusable.
        await execute(page,holder,'ROLLBACK');await expect.poll(()=>page.evaluate(()=>(window as any).__controlDone)).toBe('completed');await execute(page,waiter,'ROLLBACK')
        await confirm('cancellation',nativeWaiter);await expect(review.getByRole('alert')).toContainText('changed');await expect(review.getByRole('button',{name:'Apply reviewed cancellation',exact:true})).toBeDisabled();await review.getByRole('button',{name:'Close review',exact:true}).click()
        await execute(page,holder,begin);await execute(page,holder,`UPDATE ${table} SET ${q('value')}=11 WHERE ${q('id')}=1`);await startWait();await refresh();await select(nativeWaiter)
        await inspector.getByRole('button',{name:'Review cancellation',exact:true}).click();await expect(review).toBeVisible();await page.screenshot({path:testInfo.outputPath(`${engine}-cancel-review.png`)})
        await confirm('cancellation',nativeWaiter);await expect(review).not.toBeVisible();await expect(inspector.getByRole('status')).toContainText('Cancellation requested');await expect.poll(()=>page.evaluate(()=>(window as any).__controlDone)).not.toBe(false);expect(await page.evaluate(()=>(window as any).__controlDone)).not.toBe('completed');await execute(page,waiter,'ROLLBACK')
      }
      await refresh();await select(nativeHolder);await inspector.getByRole('button',{name:'Review termination',exact:true}).click();await expect(review).toBeVisible();await expect(review).toContainText('roll back all its uncommitted work');await page.screenshot({path:testInfo.outputPath(`${engine}-terminate-review.png`)})
      if(engine==='postgres'){
        await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(800,600);w.setSize(960,720)})
        await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(960);expect(await review.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true)
        await review.getByLabel('Session action confirmation').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('control-review-small.png')})
        await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,940))
      }
      await confirm('termination',nativeHolder);await expect(review).not.toBeVisible();await expect(inspector.getByRole('status')).toContainText('Termination requested');terminated=true
      const rollback=inspector.getByRole('region',{name:'Rollback progress inspection'});await expect(rollback).toBeVisible();await expect(rollback).toContainText(`Rollback progress · session ${nativeHolder}`);await rollback.getByRole('button',{name:'Refresh rollback progress',exact:true}).click();await expect(rollback.getByRole('button',{name:'Refresh rollback progress',exact:true})).toBeEnabled();await expect(rollback).toContainText('absence never proves rollback completed')
      if(tds){await expect.poll(()=>page.evaluate(()=>(window as any).__controlDone)).toBe('completed');await execute(page,waiter,'ROLLBACK')}
    }
    // Native fixture actions above add their own history; review/dispatch must not add source-session SQL entries.
    const entries=await page.evaluate(()=>window.dbCommander.history());expect(entries.filter(e=>/pg_(cancel|terminate)_backend|KILL (SOFT|CONNECTION)|ALTER SYSTEM (CANCEL|KILL)/i.test(e.sql))).toHaveLength(0);if(embedded)expect(entries.length).toBe(history)
    await page.keyboard.press('Escape');await expect(inspector).not.toBeVisible();await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await expect.poll(()=>page.locator('.monaco-editor').innerText()).toBe(buffer);await expect(page.locator('.results-region')).toContainText('42');await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
  } finally {
    if(holder&&!terminated)await execute(page,holder,'ROLLBACK').catch(()=>{})
    if(waiter){await expect.poll(()=>page.evaluate(()=>(window as any).__controlDone),{timeout:15000}).not.toBe(false).catch(()=>{});await execute(page,waiter,'ROLLBACK').catch(()=>{});if(table)await execute(page,waiter,`DROP TABLE ${table}`).catch(()=>{});await page.evaluate(id=>window.dbCommander.disconnect(id),waiter).catch(()=>{})}
    if(holder)await page.evaluate(id=>window.dbCommander.disconnect(id),holder).catch(()=>{})
    await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});fixture.cleanup();rmSync(directory,{recursive:true,force:true})
  }
})
