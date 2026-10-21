import { _electron as electron, test, expect } from '@playwright/test'
import { DuckDBInstance } from '@duckdb/node-api'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { catalogProcessMemory, performanceCatalogSeed, performanceTable as catalogTable, PERFORMANCE_CATALOG_SIZES } from '../fixtures/catalog-performance'
import { tableAction, tableNode } from './explorer-actions'
import {openMysqlTransport,type MysqlTransport} from '../../src/driver/mysql-transport'

const total=PERFORMANCE_CATALOG_SIZES[1], visible=2000
type Resources={sample:number;postGcHeapBytes:number;documents:number;nodes:number;jsEventListeners:number;memory:ReturnType<typeof catalogProcessMemory>}
const engines:('sqlite'|'duckdb'|'mariadb')[]=(process.env.SQLCOMMANDER_TEST_DRIVERS??'').split(',').includes('mariadb')?['mariadb']:['sqlite','duckdb']
for (const engine of engines) test(`catalog performance ${engine}: 20000 tables, repeated refresh and responsive editor`, async ({}, testInfo) => {
  test.skip(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE!=='1','Run pnpm test:catalog-performance to opt into the large performance fixture.')
  test.setTimeout(240000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-catalog-performance-')), path = join(directory, 'catalog.db')
  let fixture:MysqlTransport|undefined,created=0
  // The core server fixture's view survives in the column preview even when
  // the rich catalog's 2000 slots are occupied by tables.
  const expectedVisible=visible+(engine==='mariadb'?1:0)
  const ca=engine==='mariadb'?readFileSync(process.env.SQLCOMMANDER_MARIADB_CA!,'utf8'):''
  // Seed a private file before the app opens it; never open a second descriptor
  // to an active DuckDB file (POSIX locks are process scoped).
  try {
    if (engine === 'sqlite') {
      const db = new DatabaseSync(path)
      try { for(let start=0;start<total;start+=150) db.exec('BEGIN;'+performanceCatalogSeed(engine,start,Math.min(total,start+150))+'COMMIT;') } finally { db.close() }
    } else if(engine==='duckdb') {
      const db = await DuckDBInstance.create(path), client = await db.connect()
      try { for(let start=0;start<total;start+=150) await client.runAndReadAll('BEGIN;'+performanceCatalogSeed(engine,start,Math.min(total,start+150))+'COMMIT;') } finally { client.closeSync(); db.closeSync() }
    } else {
      expect(process.env.SQLCOMMANDER_TEST_PROJECT).toMatch(/^dbcommander-test-\d+$/)
      fixture=await openMysqlTransport({engine,name:'Private performance fixture',host:'localhost',port:Number(process.env.SQLCOMMANDER_MARIADB_PORT),database:'dbcommander',user:'dbcommander',password:'local-test-only',tls:'verify-full',ca})
      const existing=await fixture.query("SELECT COUNT(*),MIN(TABLE_NAME),MAX(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA='dbcommander' AND TABLE_NAME REGEXP '^perf_[0-9]{5}$'")
      created=Number(existing[0][0]); expect(created).toBeLessThanOrEqual(total)
      if(created) {expect(existing[0][1]).toBe(catalogTable(0));expect(existing[0][2]).toBe(catalogTable(created-1))}
      while(created<total) { const index=created++;await fixture.query(performanceCatalogSeed(engine,index,created)) }
    }
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
    const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
    const page = await app.firstWindow(), timings: Record<string, number> = {}, resources:Resources[]=[], last = catalogTable(1900), key = process.platform === 'darwin' ? 'Meta' : 'Control'
    const cdp=await page.context().newCDPSession(page); await cdp.send('Performance.enable')
    const refresh = page.getByRole('button', { name: 'Refresh schema', exact: true }), filter = page.getByLabel('Filter database objects')
    const sqlText = () => page.evaluate(async () => { const workspace = await window.dbCommander.loadWorkspace(); return workspace!.tabs.find(tab => tab.id === workspace!.activeTabId)!.sql })
    try {
      await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Connect database', exact: true }).click()
      const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(engine)
      if(engine==='mariadb') {
        await form.getByLabel('Port',{exact:true}).fill(process.env.SQLCOMMANDER_MARIADB_PORT!)
        await form.getByLabel('Database',{exact:true}).fill('dbcommander');await form.getByLabel('User',{exact:true}).fill('dbcommander');await form.getByLabel('Password',{exact:true}).fill('local-test-only')
        await form.getByText('Custom CA certificate',{exact:true}).click();await form.getByLabel('CA certificate PEM').fill(ca)
      } else {await form.getByLabel('Open mode').selectOption('read-write'); await form.getByLabel('Database file').fill(path)}
      let start = performance.now(); await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(form).not.toBeVisible(); await expect(refresh).toBeEnabled()
      await expect(tableNode(page, last)).toHaveCount(1); timings.connect = performance.now() - start
      await expect(page.getByText('Schema preview limit reached; some objects or columns are omitted.', { exact: true })).toBeVisible()
      await expect(page.getByText('Catalog limit reached (2,000 objects). Some objects are omitted.', { exact: true })).toBeVisible()
      expect(await page.locator('.schema-object').count()).toBe(expectedVisible)
      if(engine==='mariadb')await expect(tableNode(page,'customer_projects')).toHaveCount(1)
      await expect(tableNode(page,catalogTable(total-1))).toHaveCount(0)
      let buffer = 'SELECT 42 AS preserved; -- catalog performance'
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(buffer); await page.keyboard.press('Escape')
      await expect.poll(sqlText).toBe(buffer)
      const history = await page.evaluate(() => window.dbCommander.history())
      for(let sample=0;sample<3;sample++) {
        start=performance.now(); await refresh.click()
        await Promise.all([
          expect(refresh).toBeEnabled().then(()=>{timings[`refresh${sample}`]=performance.now()-start}),
          (async()=>{
            await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+End`)
            timings[`typingStartedDuringRefresh${sample}`]=await refresh.isDisabled()?1:0
            const typed=performance.now(); await page.keyboard.type(` sample${sample}`,{delay:10}); buffer+=` sample${sample}`
            await expect.poll(sqlText).toBe(buffer); timings[`refreshTyping${sample}`]=performance.now()-typed
          })()
        ])
        await expect(tableNode(page,last)).toHaveCount(1)
        expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
        expect(timings[`refresh${sample}`]).toBeLessThan(10000); expect(timings[`refreshTyping${sample}`]).toBeLessThan(2000)
        await cdp.send('HeapProfiler.collectGarbage')
        const metrics=await cdp.send('Performance.getMetrics'), dom=await cdp.send('Memory.getDOMCounters')
        resources.push({sample,postGcHeapBytes:metrics.metrics.find(metric=>metric.name==='JSHeapUsedSize')!.value,...dom,memory:catalogProcessMemory(app.process().pid!)})
      }
      const baseline=resources[0], final=resources.at(-1)!
      expect(final.postGcHeapBytes-baseline.postGcHeapBytes).toBeLessThan(16*1024*1024)
      expect(final.nodes-baseline.nodes).toBeLessThan(1500); expect(final.jsEventListeners-baseline.jsEventListeners).toBeLessThan(300)
      if(process.platform!=='win32') {
        expect(final.memory.rssBytes-baseline.memory.rssBytes).toBeLessThan(1024*1024*1024)
        expect(final.memory.pids.length-baseline.memory.pids.length).toBeLessThanOrEqual(2)
      }
      for (let n = 0; n < 3; n++) {
        start = performance.now(); await filter.fill(last); await expect(page.locator('.schema-object')).toHaveCount(1); timings[`filter${n}`] = performance.now() - start
        await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(expectedVisible)
      }
      await filter.fill(last)
      start = performance.now(); await tableAction(page, last, 'Object details'); timings.inspect = performance.now() - start
      const detail = page.getByRole('dialog', { name: 'Object details', exact: true })
      await expect(detail.getByLabel('Object definition')).toHaveValue(new RegExp(last))
      await expect(detail.getByRole('table', { name: 'Columns', exact: true }).getByRole('row')).toHaveCount(9)
      await page.screenshot({ path: testInfo.outputPath(`${engine}-large-catalog-details.png`) })
      await detail.getByRole('button', { name: 'Close object details', exact: true }).click()
      expect(await sqlText()).toBe(buffer); expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(expectedVisible)
      await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+End`)
      start = performance.now(); await page.keyboard.type(' typing verified', { delay: 10 }); await expect.poll(sqlText).toBe(buffer + ' typing verified'); timings.typing = performance.now() - start
      const source = `SELECT c. FROM ${catalogTable(0)} c`
      await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(source); await page.keyboard.press('Escape')
      await page.keyboard.press('Home'); for (let n = 0; n < 'SELECT c.'.length; n++) await page.keyboard.press('ArrowRight')
      start = performance.now(); await page.keyboard.press('Control+Space')
      await expect(page.locator('.suggest-widget.visible').getByText('label', { exact: true })).toBeVisible(); timings.completion = performance.now() - start
      await page.keyboard.press('Escape'); expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
      await page.screenshot({ path: testInfo.outputPath(`${engine}-large-catalog-explorer.png`) })
      expect(timings.connect).toBeLessThan(10000); expect(timings.inspect).toBeLessThan(5000)
      for (const name of ['filter0','filter1','filter2','typing','completion']) expect(timings[name], name).toBeLessThan(2000)
    } finally {
      writeFileSync(testInfo.outputPath('catalog-performance.json'), JSON.stringify({ engine, tables: total, timings, resources }, null, 2))
      await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {})
    }
  } finally {
    try {if(fixture)for(let index=0;index<created;index++)await fixture.query(`DROP TABLE IF EXISTS \`${catalogTable(index)}\``)}
    finally {await fixture?.end().catch(()=>fixture?.destroy());rmSync(directory,{recursive:true,force:true})}
  }
})
