import { waitForWorkspaceReady } from './workspace-ready'
import { queryTool } from './workspace-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for(const engine of engineSchema.options)test(`JSON import ${engine}: preview, mapping, exact round trip and atomic failure`,async({},testInfo)=>{
  test.setTimeout(180000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-json-ui-')),userData=join(directory,'profile')
  const env:Record<string,string>={...process.env,SQLCOMMANDER_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE
  const app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env})
  const page=await app.firstWindow(), name='json_ui_'+Date.now(), copy=name+'_copy',q=(s:string)=>quoteIdentifier(s,engine)
  const input=join(directory,'input.json'),output=join(directory,'output.json'),exact='9007199254740993.12345678',max='9223372036854775807',secret="JSON import private O'Brien Ω 😀"
  const content=(rows:unknown[])=>JSON.stringify({columns:['source_id','source_label','amount','note','skip'].map(name=>({name})),rows})
  const rows=Array.from({length:1205},(_,i)=>[i===0?max:String(i),i===0?secret:'row '+i,exact,i===0?null:i===1?'':'\\N','unused'])
  async function run(sql:string){
    await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    await page.locator('.monaco-editor').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText(sql);await page.keyboard.press('Escape')
    await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine)
    if(['sqlite','duckdb'].includes(engine))await form.getByLabel('Open mode').selectOption('memory')
    else {
      const prefix=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase()
      await form.getByLabel('Port',{exact:true}).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(engine==='oracle'?'FREEPDB1':'dbcommander')
      await form.getByLabel('User',{exact:true}).fill('dbcommander');await form.getByLabel('Password',{exact:true}).fill(['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only')
      if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!,'utf8'))}
    }
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible()
    const text=['sqlserver','azure-sql'].includes(engine)?'NVARCHAR':engine==='oracle'?'VARCHAR2':'VARCHAR'
    for(const table of [name,copy])await run(`CREATE TABLE ${q(table)} (${q('id')} ${engine==='oracle'?'NUMBER(19)':'BIGINT'} NOT NULL PRIMARY KEY,${q('label')} ${text}(200),${q('amount')} ${engine==='sqlite'?'TEXT':engine==='oracle'?'NUMBER(24,8)':'DECIMAL(24,8)'},${q('note')} ${text}(40),${q('omitted')} INTEGER DEFAULT 7)`)
    await run(engine==='oracle'?'SELECT 42 FROM dual':'SELECT 42')
    const before=await page.evaluate(()=>window.dbCommander.history())
    const transfer=page.getByRole('dialog',{name:'Data import and export',exact:true})
    await queryTool(page,'Data import and export')
    async function choose(file:string,target=name){
      await transfer.getByLabel('Transfer operation').selectOption('import');await transfer.getByLabel('Data format').selectOption('json')
      const option=await transfer.getByLabel('Import target table').locator('option').filter({hasText:new RegExp(target+'$')}).getAttribute('value')
      await transfer.getByLabel('Import target table').selectOption(option!)
      await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async(windowOrOptions: Electron.BaseWindow | Electron.OpenDialogOptions, suppliedOptions?: Electron.OpenDialogOptions)=>{
        const options = suppliedOptions ?? windowOrOptions as Electron.OpenDialogOptions
        if(!options?.filters?.some(f=>f.extensions.includes('json')))throw new Error('JSON filter missing')
        return {canceled:false,filePaths:[file]}
      }},file)
      await transfer.getByRole('button',{name:'Choose import file',exact:true}).click()
    }
    async function preview(){
      await transfer.getByRole('button',{name:'Preview and map columns',exact:true}).click()
      await expect(transfer.getByRole('heading',{name:'Column mapping',exact:true})).toBeVisible()
      if(await transfer.getByLabel('Map source_id',{exact:true}).count()){
        await transfer.getByLabel('Map source_id',{exact:true}).selectOption('id');await transfer.getByLabel('Map source_label',{exact:true}).selectOption('label')
        await expect(transfer.getByLabel('Map skip',{exact:true})).toHaveValue('')
      }
      await transfer.getByRole('checkbox').check()
    }
    await transfer.getByLabel('Transfer operation').selectOption('import');await transfer.getByLabel('Data format').selectOption('json')
    await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]})})
    await transfer.getByRole('button',{name:'Choose import file',exact:true}).click();await expect(transfer.getByLabel('Import file',{exact:true})).toHaveValue('')
    writeFileSync(input,content([[9007199254740992,'bad',exact,null,'skip']]))
    await choose(input);await transfer.getByRole('button',{name:'Preview and map columns',exact:true}).click()
    await expect(transfer.getByRole('alert')).toContainText('Quote numeric values')
    await expect(transfer.getByRole('button',{name:'Import into transaction',exact:true})).toBeDisabled()
    writeFileSync(input,content(rows));await preview()
    await expect(transfer).toContainText('Column type metadata is informational')
    await expect(transfer.getByRole('heading',{name:'First 10 data records',exact:true})).toBeVisible()
    await transfer.getByLabel('Map note',{exact:true}).selectOption('');await expect(transfer.getByRole('checkbox')).not.toBeChecked()
    await transfer.getByLabel('Map note',{exact:true}).selectOption('note');await transfer.getByRole('checkbox').check()
    expect(await page.evaluate(()=>window.dbCommander.history())).toEqual(before)
    await page.screenshot({path:testInfo.outputPath(`${engine}-json-import.png`)})
    // A reviewed file changed before execution must be refused without importing rows.
    writeFileSync(input,content(rows)+' ')
    await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click()
    await expect(transfer.getByRole('status')).toContainText('failed');await expect(transfer).toContainText('changed')
    await transfer.getByRole('button',{name:'Configure another transfer',exact:true}).click();await preview()
    await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows',{timeout:60000})
    await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction');await expect(page.getByRole('cell',{name:'42',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT COUNT(*) FROM ${q(name)}`);await expect(page.getByRole('cell',{name:'0',exact:true})).toBeVisible()
    await queryTool(page,'Data import and export');await choose(input);await preview()
    await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click();await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows',{timeout:60000})
    await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click();await page.getByRole('button',{name:'Commit',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT * FROM ${q(name)} ORDER BY ${q('id')} DESC`)
    await expect(page.getByRole('cell',{name:max,exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:secret,exact:true})).toBeVisible()
    await queryTool(page,'Data import and export');await transfer.getByLabel('Data format').selectOption('json');await transfer.getByLabel('New export file').fill(output)
    await transfer.getByRole('checkbox').check();await transfer.getByRole('button',{name:'Run and export',exact:true}).click();await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows',{timeout:60000})
    expect(JSON.parse(readFileSync(output,'utf8')).rows[0]).toEqual([max,secret,exact,null,'7'])
    await transfer.getByRole('button',{name:'Configure another transfer',exact:true}).click();await choose(output,copy);await preview()
    await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click();await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows',{timeout:60000})
    await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click();await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT COUNT(*) FROM ${q(copy)}`);await expect(page.getByRole('cell',{name:'0',exact:true})).toBeVisible()
    const valid=Array.from({length:11},(_,i)=>[String(9000+i),'new',exact,null,'skip'])
    writeFileSync(input,content([...valid,['9999',true,exact,null,'skip']]))
    await queryTool(page,'Data import and export');await choose(input);await preview();await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click()
    await expect(transfer.getByRole('status')).toContainText('failed');await expect(transfer).toContainText('entire import was rolled back')
    await transfer.getByRole('button',{name:'Configure another transfer',exact:true}).click()
    writeFileSync(input,content(Array.from({length:50000},(_,i)=>[String(10000+i),'cancel',exact,null,'skip'])))
    await choose(input);await preview();await transfer.getByRole('button',{name:'Import into transaction',exact:true}).click();await transfer.getByRole('button',{name:'Cancel transfer',exact:true}).click()
    await expect(transfer.getByRole('status')).toContainText('cancelled',{timeout:60000});await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click()
    await run(`SELECT COUNT(*) FROM ${q(name)}`);await expect(page.getByRole('cell',{name:'1205',exact:true})).toBeVisible()
    for(const value of [secret,exact,max])expect(JSON.stringify(await page.evaluate(()=>window.dbCommander.history()))).not.toContain(value)
    await run(`DROP TABLE ${q(copy)}`);await run(`DROP TABLE ${q(name)}`)
    await expect(page.getByText('Saved locally',{exact:true})).toBeVisible()
    await app.evaluate(({app})=>app.exit());await app.close()
    for(const file of readdirSync(userData).filter(f=>f.startsWith('workspace')))for(const value of [secret,exact,max])expect(readFileSync(join(userData,file)).includes(Buffer.from(value))).toBe(false)
  } finally {await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});rmSync(directory,{recursive:true,force:true})}
})
