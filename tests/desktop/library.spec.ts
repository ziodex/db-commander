import { queryTool } from './workspace-actions'
import { _electron as electron,test,expect,type ElectronApplication,type Page } from '@playwright/test'
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { engineSchema,type ConnectionConfig } from '../../src/shared/contracts'
for(const engine of engineSchema.options)test(`library ${engine}: searchable history, retention, snippets and private bound values`,async({},testInfo)=>{
  test.setTimeout(150000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes(engine==='azure-sql'?'sqlserver':engine),'Engine not selected by Docker runner')
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-library-ui-')),env:Record<string,string>={...process.env as Record<string,string>,SQLCOMMANDER_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE
  let app:ElectronApplication|undefined,page:Page
  const key=process.platform==='darwin'?'Meta':'Control',from=engine==='oracle'?' FROM dual':'',secret="private-bind-7c129 O'Brien ; -- Ω",query=`SELECT :label AS label, :n AS n, :missing AS missing${from}`
  async function launch(){app=await electron.launch({...process.env.SQLCOMMANDER_TEST_EXECUTABLE?{executablePath:process.env.SQLCOMMANDER_TEST_EXECUTABLE}:{args:[resolve('.')]},env});page=await app.firstWindow();await expect(page.getByText('Saved locally',{exact:true})).toBeVisible()}
  async function enter(sql:string){await page.locator('.monaco-editor').click();await page.keyboard.press(`${key}+A`);await page.keyboard.insertText(sql);await page.keyboard.press('Escape')}
  const library=()=>page.getByRole('dialog',{name:'Query library',exact:true}),params=()=>page.getByRole('dialog',{name:'Query parameters',exact:true})
  async function openLibrary(){await queryTool(page, 'Query library');await expect(library()).toBeVisible()}
  async function plain(sql:string){await enter(sql);await page.getByRole('button',{name:/^Run SQL/}).click();await expect(page.locator('.status-text')).toHaveText('Completed');await expect(page.getByRole('button',{name:/^Run SQL/})).toBeEnabled()}
  try {
    await launch();await page!.getByRole('button',{name:'Connect database',exact:true}).click()
    const form=page!.getByRole('dialog');await form.getByLabel('Database engine').selectOption(engine);await form.getByLabel('Connection name',{exact:true}).fill('Library tests')
    await form.getByText('Profile options', { exact: true }).click()
    await expect(form.getByLabel('Record history for this connection')).toBeChecked()
    if(['sqlite','duckdb'].includes(engine)){await form.getByLabel('Open mode').selectOption('create');await form.getByLabel('Database file').fill(join(directory,'library.db'))}
    else{
      const prefix=engine==='postgres'?'PG':engine==='azure-sql'?'SQLSERVER':engine.toUpperCase()
      await form.getByLabel('Port',{exact:true}).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine==='oracle'?'Service name':'Database',{exact:true}).fill(engine==='oracle'?'FREEPDB1':'dbcommander');await form.getByLabel('User',{exact:true}).fill('dbcommander');await form.getByLabel('Password',{exact:true}).fill(['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only')
      if(engine!=='oracle'){await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!,'utf8'))}
    }
    await form.getByRole('button',{name:'Connect',exact:true}).click();await expect(form).not.toBeVisible()
    await plain(`SELECT 42 AS before_bind${from}`)
    await enter(query);await page!.getByRole('button',{name:/^Run SQL/}).click();await expect(params()).toBeVisible();await params().getByRole('button',{name:'Cancel',exact:true}).click()
    await expect(page!.getByRole('cell',{name:'42',exact:true})).toBeVisible();expect((await page!.evaluate(()=>window.dbCommander.history())).length).toBe(1)
    // Select only the last statement; the invalid prefix must not execute.
    await enter('DELETE FROM must_never_execute;\n'+query)
    for(let i=0;i<query.length;i++)await page!.keyboard.press('Shift+ArrowLeft')
    await page!.getByRole('button',{name:/^Run SQL/}).click();await expect(params().getByLabel('Parameterized SQL')).toHaveValue(query)
    await params().getByLabel('Value for label').fill(secret);await params().getByLabel('Type for n').selectOption('integer');await params().getByLabel('Value for n').fill('9223372036854775808');await params().getByLabel('Type for missing').selectOption('null')
    await params().getByRole('button',{name:'Run with parameters',exact:true}).click();await expect(params().getByRole('alert')).toContainText('64-bit')
    await params().getByLabel('Value for n').fill('9223372036854775807');await page!.screenshot({path:testInfo.outputPath(engine+'-parameters.png')})
    await params().getByRole('button',{name:'Run with parameters',exact:true}).click();await expect(params()).not.toBeVisible();await expect(page!.locator('.status-text')).toHaveText('Completed')
    await expect(page!.getByRole('cell',{name:secret,exact:true})).toBeVisible();await expect(page!.getByRole('cell',{name:'9223372036854775807',exact:true})).toBeVisible()
    const history=await page!.evaluate(()=>window.dbCommander.history());expect(history).toHaveLength(2);expect(history[0]).toMatchObject({engine,connection:'Library tests',sql:query,parameters:[{name:'label',type:'text'},{name:'n',type:'integer'},{name:'missing',type:'null'}]});expect(JSON.stringify(history)).not.toContain(secret)
    await openLibrary();await library().getByLabel('Search SQL',{exact:true}).fill(':label');await expect(library()).toContainText('1 matching executions')
    await library().getByText('More history filters', { exact: true }).click();await library().getByLabel('History engine').selectOption(engine);await library().getByLabel('History status').selectOption('failed');await expect(library()).toContainText('No matching history.');await library().getByLabel('History status').selectOption('completed')
    await library().locator('.library-list button').click();await expect(library().getByLabel('History SQL')).toHaveValue(query);await expect(library()).toContainText('Values were not saved.')
    await library().getByRole('button',{name:'Favorite history',exact:true}).click();await expect(library().getByRole('button',{name:'Remove history favorite',exact:true})).toBeVisible();await library().getByLabel('Favorite history only').check();await expect(library().locator('.library-list button')).toHaveCount(1);await library().locator('.library-list button').click()
    await library().getByRole('button',{name:'Make snippet',exact:true}).click();await library().getByLabel('Snippet name').fill('Lookup customer');await library().getByLabel('Snippet description').fill('Reusable bound lookup');await library().getByLabel('Favorite snippet',{exact:true}).check();await library().getByRole('button',{name:'Save snippet',exact:true}).click();await expect(library()).toContainText('Snippet saved.')
    await library().getByLabel('Search snippets').fill('customer');await library().getByLabel('Favorite snippets only').check();await expect(library().locator('.library-list button')).toHaveCount(1)
    await page!.screenshot({path:testInfo.outputPath(engine+'-library.png')})
    await library().getByRole('button',{name:'Open snippet in new tab',exact:true}).click();await expect(library()).not.toBeVisible();await expect(page!.getByRole('button',{name:/^Run SQL/})).toBeEnabled()
    expect((await page!.evaluate(()=>window.dbCommander.history())).length).toBe(2)
    await expect.poll(async()=>{const w=await page!.evaluate(()=>window.dbCommander.loadWorkspace());return w?.tabs.length}).toBe(2)
    const workspace=(await page!.evaluate(()=>window.dbCommander.loadWorkspace()))!;expect(workspace.tabs[0].sql).toBe('DELETE FROM must_never_execute;\n'+query);expect(workspace.tabs[1].sql).toBe(query);expect(JSON.stringify(workspace)).not.toContain(secret)
    await page!.getByRole('button',{name:/^Run SQL/}).click();await expect(params().getByLabel('Value for label')).toHaveValue('');await params().getByRole('button',{name:'Cancel',exact:true}).click()
    // Exercise host-side recording and pagination with actual executions on a separate session.
    const config:ConnectionConfig={...workspace.tabs[0].profile,password:['sqlserver','azure-sql'].includes(engine)?'Local-Test-Only!2026':'local-test-only',sqliteMode:'read-write',duckdbMode:'read-write'}
    await page!.evaluate(async({config,from})=>{const api=window.dbCommander,s=await api.connect(config);try{for(let i=0;i<27;i++){let off=()=>{};const done=new Promise<void>((resolve,reject)=>{off=api.onEvent(e=>{if(e.type==='complete'&&e.sessionId===s.id){off();e.status==='completed'?resolve():reject(new Error(e.error))}})});await api.run({sessionId:s.id,sql:`SELECT ${i} AS pagination${from}`,maxRows:1});await done}}finally{await api.disconnect(s.id)}}, {config,from})
    await openLibrary();await library().getByLabel('Search SQL',{exact:true}).fill('pagination');await expect(library()).toContainText('27 matching executions');await expect(library().locator('.library-list button')).toHaveCount(25);await library().getByRole('button',{name:'Next history page'}).click();await expect(library().locator('.library-list button')).toHaveCount(2);await library().getByRole('button',{name:'Previous history page'}).click();await expect(library().locator('.library-list button')).toHaveCount(25)
    await library().getByRole('button',{name:'Retention',exact:true}).click();await library().getByLabel('Maximum history entries').fill('2');await library().getByLabel('History retention days').fill('30');await library().getByRole('button',{name:'Apply history retention'}).click();await expect(library()).toContainText('History retention saved.')
    expect((await page!.evaluate(()=>window.dbCommander.searchHistory({}))).total).toBe(3)
    await library().getByLabel('Record query history',{exact:true}).uncheck();await library().getByRole('button',{name:'Apply history retention'}).click();await expect(library().getByRole('button',{name:'Apply history retention'})).toBeEnabled();await library().getByRole('button',{name:'Close query library'}).click()
    await plain(`SELECT 999 AS unrecorded${from}`);expect((await page!.evaluate(()=>window.dbCommander.searchHistory({text:'unrecorded'}))).total).toBe(0)
    if(engine==='postgres') {
      const recorded=await page!.evaluate(async config=>{const api=window.dbCommander,settings=await api.historySettings(),s=await api.connect(config);let finished=false;try{const done=new Promise<void>(resolve=>{const off=api.onEvent(e=>{if(e.type==='complete'&&e.sessionId===s.id){finished=true;off();resolve()}})});await api.run({sessionId:s.id,sql:'SELECT pg_sleep(1) AS started_private',maxRows:1});if(finished)throw new Error('Privacy timing fixture completed too early.');await api.saveHistorySettings({...settings,enabled:true});await done;return (await api.searchHistory({text:'started_private'})).total}finally{await api.saveHistorySettings(settings);await api.disconnect(s.id)}},config)
      expect(recorded).toBe(0)
    }
    if(['mysql','mariadb'].includes(engine)){await plain("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'");await enter(String.raw`SELECT '\', :label`);await page!.getByRole('button',{name:/^Run SQL/}).click();await expect(params().getByLabel('Parameterized SQL')).toHaveValue(String.raw`SELECT '\', :label`);await params().getByLabel('Value for label').fill('mode-aware');await params().getByRole('button',{name:'Run with parameters',exact:true}).click();await expect(params()).not.toBeVisible();await expect.poll(async()=>await page!.locator('.status-text').innerText()+(await page!.locator('.error-banner').count()?': '+await page!.locator('.error-banner').innerText():'')).toBe('Completed');await expect(page!.getByRole('cell',{name:'mode-aware',exact:true})).toBeVisible()}
    await openLibrary();await library().getByRole('button',{name:'Retention',exact:true}).click();await library().getByLabel('Record query history',{exact:true}).check();await library().getByRole('button',{name:'Apply history retention'}).click();await expect(library()).toContainText('History retention saved.');await library().getByLabel('Confirm clear history').check();await library().getByRole('button',{name:'Clear selected history'}).click();await expect(library()).toContainText('History cleared. Snippets were kept.');expect((await page!.evaluate(()=>window.dbCommander.searchHistory({}))).total).toBe(1)
    await library().getByRole('button',{name:'Close query library'}).click()
    await page!.evaluate(async({config,from})=>{const api=window.dbCommander,s=await api.connect({...config,recordHistory:false});try{const done=new Promise<void>(resolve=>{const off=api.onEvent(e=>{if(e.type==='complete'&&e.sessionId===s.id){off();resolve()}})});await api.run({sessionId:s.id,sql:`SELECT 1 AS profile_private${from}`,maxRows:1});await done}finally{await api.disconnect(s.id)}},{config,from})
    expect((await page!.evaluate(()=>window.dbCommander.searchHistory({}))).total).toBe(1)
    await app!.close();app=undefined;await launch()
    await openLibrary();await library().getByLabel('Favorite history only').check();await expect(library()).toContainText('1 matching executions');await library().locator('.library-list button').click();await library().getByRole('button',{name:'Open history in new tab'}).click();await expect(library()).not.toBeVisible();expect((await page!.evaluate(()=>window.dbCommander.history())).length).toBe(1)
    await openLibrary();await library().getByRole('button',{name:'Snippets',exact:true}).click();await library().locator('.library-list button').click();await expect(library().getByLabel('Snippet SQL')).toHaveValue(query);await library().getByLabel('Snippet name').fill('Updated lookup');await library().getByRole('button',{name:'Save snippet',exact:true}).click();await expect(library()).toContainText('Snippet saved.');await library().getByRole('button',{name:'Delete snippet',exact:true}).click();await expect(library().locator('.library-list button')).toHaveCount(0)
    await library().getByRole('button',{name:'Retention',exact:true}).click();await expect(library().getByLabel('Maximum history entries')).toHaveValue('2');await expect(library().getByLabel('History retention days')).toHaveValue('30');await library().getByLabel('Include history favorites when clearing').check();await library().getByLabel('Confirm clear history').check();await library().getByRole('button',{name:'Clear selected history'}).click();await expect(library()).toContainText('History cleared. Snippets were kept.');expect((await page!.evaluate(()=>window.dbCommander.history())).length).toBe(0)
    await library().getByRole('button',{name:'Close query library'}).click();await app!.close();app=undefined
    // Inspect local persistence after shutdown, including WAL or migration backups.
    for(const file of readdirSync(directory).filter(name=>name.startsWith('workspace')))expect(readFileSync(join(directory,file)).includes(Buffer.from(secret))).toBe(false)
  }finally{await app?.close();rmSync(directory,{recursive:true,force:true})}
})
