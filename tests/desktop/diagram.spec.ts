import { databaseAction } from './workspace-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`ER diagram ${engine}: selected tables, ordered keys, layout, export and preserved state`, async ({}, testInfo) => {
  test.setTimeout(120000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-er-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), name = `er_ui_${Date.now()}`, q = (value: string) => quoteIdentifier(value, engine)
  async function run(sql: string) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
    if (['sqlite', 'duckdb'].includes(engine)) {
      await form.getByLabel('Open mode').selectOption('create'); await form.getByLabel('Database file').fill(join(directory, 'data.db'))
    } else {
      const prefix = engine === 'postgres' ? 'PG' : engine === 'azure-sql' ? 'SQLSERVER' : engine.toUpperCase()
      await form.getByLabel('Port', { exact: true }).fill(process.env[`SQLCOMMANDER_${prefix}_PORT`]!)
      await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database', { exact: true }).fill(engine === 'oracle' ? 'FREEPDB1' : 'dbcommander')
      await form.getByLabel('User', { exact: true }).fill('dbcommander'); await form.getByLabel('Password', { exact: true }).fill(['sqlserver', 'azure-sql'].includes(engine) ? 'Local-Test-Only!2026' : 'local-test-only')
      if (engine !== 'oracle') { await form.getByText('Custom CA certificate', { exact: true }).click(); await form.getByLabel('CA certificate PEM').fill(readFileSync(process.env[`SQLCOMMANDER_${prefix}_CA`]!, 'utf8')) }
    }
    await form.getByRole('button', { name: 'Connect', exact: true }).click(); await expect(form).not.toBeVisible()
    const parent=name+" p'<&",child=name+'_child',unused=name+'_plain'
    await run(`CREATE TABLE ${q(parent)} (${q('a')} INTEGER NOT NULL,${q('b')} INTEGER NOT NULL,${q('self a')} INTEGER,${q('self b')} INTEGER,PRIMARY KEY(${q('a')},${q('b')}),CONSTRAINT ${q(name+'_self')} FOREIGN KEY(${q('self a')},${q('self b')}) REFERENCES ${q(parent)}(${q('a')},${q('b')}))`)
    await run(`CREATE TABLE ${q(child)} (${q('id')} INTEGER PRIMARY KEY,${q('a')} INTEGER,${q('b')} INTEGER,CONSTRAINT ${q(name+'_fk')} FOREIGN KEY(${q('b')},${q('a')}) REFERENCES ${q(parent)}(${q('a')},${q('b')}))`)
    await run(`CREATE TABLE ${q(unused)} (${q('note')} VARCHAR(80))`)
    await page.evaluate(()=>{const off=window.dbCommander.onEvent(e=>{if(e.type==='complete'){(window as unknown as {erSession:string}).erSession=e.sessionId;off()}})})
    await run(engine==='oracle'?'SELECT 42 AS preserved FROM dual':'SELECT 42 AS preserved')
    const diagram=page.getByRole('dialog',{name:'ER diagram',exact:true}),escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    const table=(name:string)=>diagram.getByRole('button',{name:new RegExp(`^Table .*${escape(name)}$`)})
    if(engine==='duckdb'){
      // Simulate a concurrent API caller without relying on a fake database or private Electron internals.
      const sessionId=await page.evaluate(async()=>{const id=(window as unknown as {erSession:string}).erSession;await window.dbCommander.run({sessionId:id,sql:'SELECT sum(sin(a.range+b.range)) FROM range(1000000) a CROSS JOIN range(1000000) b',maxRows:1});return id})
      await databaseAction(page, 'ER diagram')
      await expect(diagram.getByRole('alert')).toContainText(/query|operation/)
      await expect(diagram.getByLabel(new RegExp(`^Include .*${escape(child)}$`))).toBeVisible()
      await page.evaluate(async id=>{const done=new Promise<void>(resolve=>{const off=window.dbCommander.onEvent(e=>{if(e.type==='complete'&&e.sessionId===id){off();resolve()}})});await window.dbCommander.cancel(id);await done},sessionId)
      await diagram.getByRole('button',{name:'Clear selection',exact:true}).click()
      await diagram.getByLabel(new RegExp(`^Include .*${escape(child)}$`)).check()
      await diagram.getByRole('button',{name:'Load selected tables',exact:true}).click()
      await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.',{timeout:30000})
      await expect(diagram.getByRole('alert')).toHaveCount(0)
      await diagram.getByRole('button',{name:'Close ER diagram',exact:true}).click()
      await run('SELECT 42 AS preserved')
    }
    const buffer=await page.locator('.monaco-editor').innerText(),history=await page.evaluate(()=>window.dbCommander.history())
    await databaseAction(page, 'ER diagram')
    await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.',{timeout:30000})
    await expect(diagram.getByRole('alert')).toHaveCount(0)
    await diagram.getByRole('button',{name:'Clear selection',exact:true}).click()
    await diagram.getByLabel('Find available tables',{exact:true}).fill(name)
    await diagram.getByLabel(new RegExp(`^Include .*${escape(child)}$`)).check()
    await diagram.getByRole('button',{name:'Load selected tables',exact:true}).click()
    await expect(diagram.locator('.diagram-source')).toContainText('1 tables · 1 relationships')
    await expect(table(parent)).toHaveCount(0)
    await diagram.locator('.diagram-relations button').first().click()
    await expect(diagram.getByRole('region',{name:'Relationship details'})).toContainText('b → a')
    await expect(diagram.getByRole('region',{name:'Relationship details'})).toContainText('a → b')
    await expect(diagram.getByRole('region',{name:'Relationship details'})).toContainText('outside the selected diagram')
    await diagram.getByRole('button',{name:'Add referenced tables',exact:true}).click()
    await diagram.getByRole('button',{name:'Load selected tables',exact:true}).click()
    await expect(diagram.locator('.diagram-source')).toContainText('2 tables · 2 relationships')
    await expect(table(parent)).toBeVisible();await expect(table(unused)).toHaveCount(0)
    await expect(diagram.locator('.diagram-edge')).toHaveCount(2)
    await expect(table(parent)).toContainText('PK a');await expect(table(child)).toContainText('FK b')
    await diagram.getByLabel('Find in diagram',{exact:true}).fill(child)
    await expect(table(parent)).toHaveAttribute('opacity','0.3');await expect(table(child)).toHaveAttribute('opacity','1')
    await diagram.getByLabel('Find in diagram',{exact:true}).fill('')
    const zoom=await diagram.getByLabel('Diagram zoom',{exact:true}).innerText()
    await diagram.getByRole('button',{name:'Zoom in diagram',exact:true}).click();expect(await diagram.getByLabel('Diagram zoom',{exact:true}).innerText()).not.toBe(zoom)
    await diagram.getByRole('button',{name:'Fit diagram',exact:true}).click()
    const original=await table(child).getAttribute('transform')
    await table(child).focus();await page.keyboard.press('ArrowRight');expect(await table(child).getAttribute('transform')).not.toBe(original)
    const beforeDrag=await table(child).getAttribute('transform'),box=(await table(child).boundingBox())!
    await page.mouse.move(box.x+box.width/2,box.y+12);await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+40,{steps:6});await page.mouse.up()
    expect(await table(child).getAttribute('transform')).not.toBe(beforeDrag)
    await diagram.getByLabel('Show columns',{exact:true}).uncheck();await expect(table(child)).not.toContainText('FK b')
    await diagram.getByLabel('Show columns',{exact:true}).check()
    const positions=await table(child).getAttribute('transform')
    await diagram.getByRole('button',{name:'Refresh diagram',exact:true}).click();await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.',{timeout:30000});await expect(table(child)).toHaveAttribute('transform',positions!)
    const file=join(directory,'diagram.svg')
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file)
    await diagram.getByRole('button',{name:'Save diagram SVG',exact:true}).click();await expect(diagram.locator('p[role=status]')).toHaveText('Diagram saved.')
    const svg=readFileSync(file,'utf8');expect(svg).toContain('&lt;&amp;');expect(svg).toContain('b, a');expect(svg).not.toContain('foreignObject')
    expect(await page.evaluate(svg=>{const doc=new DOMParser().parseFromString(svg,'image/svg+xml');return doc.querySelector('parsererror')?.textContent??''},svg)).toBe('')
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true,filePath:''})})
    await diagram.getByRole('button',{name:'Save diagram SVG',exact:true}).click();await expect(diagram).toBeVisible()
    expect(await diagram.locator('.diagram-details').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`${engine}-er-diagram.png`)})
    await page.setViewportSize({width:960,height:720});await expect(diagram.getByRole('button',{name:'Close ER diagram',exact:true})).toBeVisible();await diagram.getByRole('button',{name:'Fit diagram',exact:true}).click()
    expect(await diagram.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`${engine}-er-small.png`)})
    await page.keyboard.press('Escape');await expect(diagram).not.toBeVisible()
    expect(await page.locator('.monaco-editor').innerText()).toBe(buffer);expect(await page.evaluate(()=>window.dbCommander.history())).toEqual(history)
    await expect(page.getByRole('cell',{name:'42',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Begin',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await databaseAction(page, 'ER diagram');await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.',{timeout:30000})
    await diagram.getByRole('button',{name:'Close ER diagram',exact:true}).click();await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button',{name:'Rollback',exact:true}).click();await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`ALTER TABLE ${q(child)} ADD ${q('fresh column')} INTEGER`)
    await databaseAction(page, 'ER diagram');await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.',{timeout:30000});await expect(table(child)).toContainText('fresh column')
    await diagram.getByRole('button',{name:'Close ER diagram',exact:true}).click()
    await run(`DROP TABLE ${q(child)}`);await run(`DROP TABLE ${q(parent)}`);await run(`DROP TABLE ${q(unused)}`)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
