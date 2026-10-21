import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'
import { openBackup } from './explorer-actions'
import { verifyMigrationExport } from './migration-export'

for(const engine of engineSchema.options) test(`schema comparison ${engine}: context menus, review SQL, save and target session`,async({},testInfo)=>{
  test.setTimeout(240000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-compare-ui-')),env:Record<string,string|undefined>={...process.env,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env:env as Record<string,string>}),page=await app.firstWindow()
  const q=(s:string)=>quoteIdentifier(s,engine),prefix='cmp_ui_'+Date.now(),name=prefix+'_table',extra=prefix+'_extra',embedded=['sqlite','duckdb'].includes(engine),separateSchema=['postgres','sqlserver','azure-sql'].includes(engine)
  const sourceSchema=engine==='postgres'?'public':['sqlserver','azure-sql'].includes(engine)?'dbo':engine==='oracle'?'DBCOMMANDER':['mysql','mariadb'].includes(engine)?'dbcommander':'main'
  const targetSchema=separateSchema?prefix:engine==='oracle'?'DBCOMMANDER_COMPARE':['mysql','mariadb'].includes(engine)?'comparison_target':'main'
  const full=(schema:string,n:string)=>`${q(schema)}.${q(n)}`
  async function run(sql:string){await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled();await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(sql);await page.keyboard.press('Escape');await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()}
  async function configure(target=false){
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(embedded){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,target?'target.db':'source.db'))}
    else{const key=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase();await form.getByLabel('Port',{exact:true}).fill(process.env[`SQLCOMMANDER_${key}_PORT`]!);await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(engine==='oracle'?'FREEPDB1':target&&['mysql','mariadb'].includes(engine)?'comparison_target':'dbcommander');await form.getByLabel('User',{exact:true}).fill(target&&engine==='oracle'?'dbcommander_compare':'dbcommander');await form.getByLabel('Password',{exact:true}).fill(['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only');if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${key}_CA`]!,'utf8'))}}
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
  }
  const dialog=page.getByRole('dialog',{name:'Compare schemas',exact:true})
  try{
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect database',exact:true}).click();await configure()
    await run(`CREATE TABLE ${full(sourceSchema,name)} (${q('id')} INTEGER,${q('added column')} INTEGER)`)
    await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42')
    const originalBuffer=await page.locator('.monaco-editor').innerText()
    await page.getByRole('button',{name:'New query tab',exact:true}).click();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    if(!separateSchema){await page.getByRole('button',{name:'Connection settings',exact:true}).click();await configure(true)}
    else await run(`CREATE SCHEMA ${q(targetSchema)}`)
    await run(`CREATE TABLE ${full(targetSchema,name)} (${q('id')} INTEGER)`);await run(`CREATE TABLE ${full(targetSchema,extra)} (${q('id')} INTEGER)`)
    await page.getByLabel('Filter database objects').fill(prefix)
    // No repeated row action buttons; keyboard and pointer menus expose the same actions.
    await expect(page.locator('.schema-object-actions')).toHaveCount(0)
    // In a shared database both namespaces are visible; select the target-qualified row.
    const targetRow=page.getByRole('button',{name:`${name} ${engine==='duckdb'?'target.':''}${targetSchema}`,exact:true})
    await targetRow.evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:innerWidth-1,clientY:innerHeight-1})))
    const menu=page.getByRole('menu');await expect(menu).toBeVisible()
    const rectangle=await menu.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    expect(rectangle!.x+rectangle!.width).toBeLessThanOrEqual(viewport.width);expect(rectangle!.y+rectangle!.height).toBeLessThanOrEqual(viewport.height)
    await page.locator('.statusbar').click();await expect(menu).not.toBeVisible()
    await targetRow.focus();await page.keyboard.press('Shift+F10');await expect(page.getByRole('menu')).toBeVisible();await expect(page.getByRole('menuitem',{name:`Object details ${name}`,exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:`Append SELECT SQL for ${name}`,exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:`Browse data ${name}`,exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(targetRow).toBeFocused()
    await targetRow.click({button:'right'});await page.getByRole('menuitem',{name:`Object details ${name}`,exact:true}).click();await expect(page.getByRole('dialog',{name:'Object details',exact:true})).toContainText(name);await page.getByRole('button',{name:'Close object details',exact:true}).click()
    await openBackup(page);await expect(page.getByRole('dialog',{name:'Database backup and restore',exact:true})).toContainText(engine==='oracle'?'freepdb1':embedded?'target':['mysql','mariadb'].includes(engine)?'comparison_target':'dbcommander');await page.getByRole('button',{name:'Close backup dialog',exact:true}).click()
    await page.locator('.database-node.current > button').first().click({button:'right'});await page.getByRole('menuitem',{name:'Compare schemas',exact:true}).click()
    await dialog.getByLabel('Source schema',{exact:true}).fill(sourceSchema);await dialog.getByLabel('Target schema',{exact:true}).fill(targetSchema);await dialog.getByLabel('Object name contains',{exact:true}).fill(prefix)
    if(engine==='duckdb'){await dialog.getByLabel('Source catalog').fill('source');await dialog.getByLabel('Target catalog').fill('target')}
    const before=(await page.evaluate(()=>window.dbCommander.history())).length
    await dialog.getByRole('button',{name:'Compare schemas',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText(/objects compared/,{timeout:60000})
    expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(before)
    await expect(dialog.getByRole('button',{name:`${name} · table · changed`,exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:`${extra} · table · target-only`,exact:true})).toBeVisible()
    const preview=dialog.getByLabel('Comparison SQL preview'),sql=await preview.inputValue();expect(sql).toContain('ALTER TABLE');expect(sql.split('\n').some(line=>line.startsWith('DROP TABLE'))).toBe(false)
    await dialog.getByLabel('Include destructive DROP TABLE suggestions; I understand these remove target data.').check();expect((await preview.inputValue()).split('\n').some(line=>line.startsWith('DROP TABLE'))).toBe(true);await dialog.getByLabel('Include destructive DROP TABLE suggestions; I understand these remove target data.').uncheck()
    await dialog.getByLabel('Object name contains').fill(prefix+'_none');await expect(preview).toHaveCount(0);await dialog.getByLabel('Object name contains').fill(prefix);await dialog.getByRole('button',{name:'Compare schemas',exact:true}).click();await expect(preview).toBeVisible({timeout:60000})
    await dialog.getByRole('button',{name:'Copy comparison SQL',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('SQL copied.');expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(await preview.inputValue())
    const file=join(directory,'comparison.sql');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file);await dialog.getByRole('button',{name:'Save comparison SQL',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Comparison SQL saved.');expect(readFileSync(file,'utf8')).toBe(await preview.inputValue())
    await dialog.getByRole('button',{name:'Export migration…',exact:true}).click()
    const migrationDialog=page.getByRole('dialog',{name:'Export migration',exact:true})
    await migrationDialog.getByRole('button',{name:'Prepare migration preview',exact:true}).click()
    await expect(migrationDialog.getByRole('alert')).toContainText('No included executable SQL')
    await migrationDialog.getByRole('button',{name:'Close migration export',exact:true}).click()
    await dialog.getByLabel(`Include table ${extra}`,{exact:true}).uncheck()
    const migrationFile=await verifyMigrationExport(app,page,engine,directory,testInfo,'comparison')
    await page.screenshot({path:testInfo.outputPath('schema-comparison.png')})
    if(engine==='duckdb'){
      await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(800,600);window.setSize(960,720)})
      await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(960)
      await expect(dialog).toBeVisible()
      const bounds=await dialog.boundingBox();expect(bounds!.width).toBeLessThanOrEqual(960);expect(bounds!.height).toBeLessThanOrEqual(720)
      await dialog.getByRole('button',{name:'Open SQL in target tab',exact:true}).scrollIntoViewIfNeeded()
      await page.screenshot({path:testInfo.outputPath('schema-comparison-small.png')})
    }
    await dialog.getByRole('button',{name:'Open SQL in target tab',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.getByRole('tab',{name:'schema-comparison.sql',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled();expect((await page.evaluate(()=>window.dbCommander.history())).length).toBe(before)
    await run(readFileSync(migrationFile,'utf8'));await run(`SELECT ${q('added column')} FROM ${full(targetSchema,name)}`)
    await page.getByRole('tab',{name:'Untitled.sql',exact:true}).click();await expect.poll(()=>page.locator('.monaco-editor').innerText()).toBe(originalBuffer);await expect(page.locator('.results-region')).toContainText('42')
    await run(`DROP TABLE ${full(sourceSchema,name)}`)
    await page.getByRole('tab',{name:'Query 2.sql',exact:true}).click();await run(`DROP TABLE ${full(targetSchema,name)}`);await run(`DROP TABLE ${full(targetSchema,extra)}`);if(separateSchema)await run(`DROP SCHEMA ${q(targetSchema)}`)
  }finally{await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});rmSync(directory,{recursive:true,force:true})}
})
