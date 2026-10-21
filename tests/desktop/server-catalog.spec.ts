import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Connection, Request } from 'tedious'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'
import type { ConnectionConfig, DatabaseEvent } from '../../src/shared/contracts'
import { SERVER_CATALOG_TABLES, serverCatalogSeed, serverCatalogTable } from '../fixtures/server-catalog'
import { tableAction, tableNode } from './explorer-actions'

for (const engine of ['postgres','mysql','mariadb','sqlserver','oracle'] as const) test(`large server catalog ${engine}: explorer, details, filtering and editor response`, async ({}, info) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), 'Select the isolated local server fixture with the driver runner.')
  test.setTimeout(360000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-server-catalog-')), prefix = 'scale_' + randomUUID().replaceAll('-', '').slice(0,8) + '_'
  const variable = engine === 'postgres' ? 'PG' : engine.toUpperCase(), ca = readFileSync(process.env[`SQLCOMMANDER_${variable}_CA`]!, 'utf8')
  const config: ConnectionConfig = { engine, name: 'Private catalog fixture', host: 'localhost', port: Number(process.env[`SQLCOMMANDER_${variable}_PORT`]), database: engine === 'oracle' ? 'FREEPDB1' : 'dbcommander', user: 'dbcommander', password: engine === 'sqlserver' ? 'Local-Test-Only!2026' : 'local-test-only', tls: 'verify-full', ...(engine === 'oracle' ? {} : { ca }) }
  const events: DatabaseEvent[] = [], driver = new DriverRegistry(event => { events.push(event) })
  // Playwright's TS loader handles this private CJS decoder import differently
  // from Vite/Electron. Seed TDS DDL with Tedious directly; the app's real
  // transport/decoder remains exercised through Electron, without test patches.
  const tds = engine === 'sqlserver' ? new Connection(buildSqlServerConfig(config)) : undefined
  tds?.on('error', () => {})
  if (tds) await new Promise<void>((resolve,reject) => tds.connect(error => error ? reject(error) : resolve()))
  const session = tds ? undefined : await driver.connect(config)
  let version = session?.version
  const q = (name: string) => quoteIdentifier(name, engine), table = (index: number) => serverCatalogTable(prefix,index)
  const measurements: { profile: string; timings: Record<string, number> }[] = []
  let created = 0, failed = false
  async function run(sql: string) {
    if (tds) {
      await new Promise<void>((resolve,reject) => {
        const request = new Request(sql,error => error ? reject(error) : resolve())
        request.on('row',columns => { if (sql === 'SELECT @@VERSION') version = String(columns[0].value) })
        tds.execSqlBatch(request)
      })
      return
    }
    events.length = 0; const id = driver.start({ sessionId: session!.id, sql, maxRows: 1 }); await driver.wait(session!.id)
    const done = events.find(event => event.type === 'complete' && event.queryId === id) as Extract<DatabaseEvent, { type: 'complete' }>
    expect(done?.status, done?.error).toBe('completed')
  }
  try {
    if (tds) await run('SELECT @@VERSION')
    while (created < SERVER_CATALOG_TABLES) { const start = created; created = Math.min(SERVER_CATALOG_TABLES,start+150); await run(serverCatalogSeed(engine,prefix,start,created)) }
    await run(`CREATE VIEW ${q(prefix+'view')} AS SELECT id FROM ${q(table(0))}`)
    if (engine === 'oracle') await run(`CREATE MATERIALIZED VIEW ${q(prefix+'materialized')} AS SELECT id FROM ${q(table(0))}`)
    // Reuse this disposable catalog for a separate Azure-profile UI session.
    for (const profile of engine === 'sqlserver' ? ['sqlserver','azure-sql'] as const : [engine]) {
      const env: Record<string,string|undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(directory,profile) }; delete env.ELECTRON_RUN_AS_NODE
      let app: ElectronApplication | undefined
      const timings: Record<string,number> = {}; measurements.push({profile,timings})
      try {
        app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string,string> })
        const page = await app.firstWindow(), key = process.platform === 'darwin' ? 'Meta' : 'Control', last = table(SERVER_CATALOG_TABLES-1)
        const refresh = page.getByRole('button',{name:'Refresh schema',exact:true}), filter = page.getByLabel('Filter database objects')
        const sqlText = () => page.evaluate(async () => { const workspace = await window.dbCommander.loadWorkspace(); return workspace!.tabs.find(tab => tab.id === workspace!.activeTabId)!.sql })
        await expect(page.getByText('Saved locally',{exact:true})).toBeVisible()
        await page.getByRole('button',{name:'Connect database',exact:true}).click()
        const form = page.getByRole('dialog'); await form.getByLabel('Database engine').selectOption(profile)
        await form.getByLabel('Host',{exact:true}).fill(config.host); await form.getByLabel('Port',{exact:true}).fill(String(config.port))
        await form.getByLabel(engine === 'oracle' ? 'Service name' : 'Database',{exact:true}).fill(config.database); await form.getByLabel('User',{exact:true}).fill(config.user); await form.getByLabel('Password',{exact:true}).fill(config.password)
        if (engine !== 'oracle') { await form.getByText('Custom CA certificate',{exact:true}).click(); await form.getByLabel('CA certificate PEM').fill(ca) }
        let start = performance.now(); await form.getByRole('button',{name:'Connect',exact:true}).click(); await expect(form).not.toBeVisible({timeout:30000}); await expect(refresh).toBeEnabled()
        await expect(tableNode(page,last)).toHaveCount(1); await expect(tableNode(page,prefix+'view')).toHaveCount(1); timings.connect = performance.now()-start
        await expect(page.getByText('Schema preview limit reached; some objects or columns are omitted.',{exact:true})).toBeVisible()
        await expect(page.getByText('Catalog limit reached (2,000 objects). Some objects are omitted.',{exact:true})).toBeVisible()
        const tableCount = await page.locator('.schema-object').count(); expect(tableCount).toBeGreaterThanOrEqual(SERVER_CATALOG_TABLES+1)
        const buffer = 'SELECT 42 AS preserved; -- large server catalog'
        await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(buffer); await page.keyboard.press('Escape'); await expect.poll(sqlText).toBe(buffer)
        start = performance.now(); await refresh.click(); await expect(refresh).toBeEnabled(); await expect(tableNode(page,last)).toHaveCount(1); timings.refresh = performance.now()-start
        for (let i=0;i<3;i++) {
          start = performance.now(); await filter.fill(last); await expect(page.locator('.schema-object')).toHaveCount(1); timings[`filter${i}`] = performance.now()-start
          await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(tableCount)
        }
        await filter.fill(last); start = performance.now(); await tableAction(page,last,'Object details'); timings.inspect = performance.now()-start
        const detail = page.getByRole('dialog',{name:'Object details',exact:true})
        await expect(detail.getByLabel('Object definition')).toHaveValue(new RegExp(last)); await expect(detail.getByRole('table',{name:'Columns',exact:true}).getByRole('row')).toHaveCount(9)
        await page.screenshot({path:info.outputPath(profile+'-large-catalog-details.png')})
        await detail.getByRole('button',{name:'Close object details',exact:true}).click(); expect(await sqlText()).toBe(buffer)
        if (engine === 'oracle') {
          await filter.fill(prefix+'materialized'); await expect(page.locator('.schema-object')).toHaveCount(1)
          start = performance.now(); await tableAction(page,prefix+'materialized','Object details'); timings.materializedInspect = performance.now()-start
          await expect(detail.getByLabel('Object definition')).toHaveValue(/CREATE MATERIALIZED VIEW/)
          await expect(detail.getByText('Generated summary',{exact:true})).toBeVisible()
          await detail.getByRole('button',{name:'Close object details',exact:true}).click(); expect(await sqlText()).toBe(buffer)
          expect(timings.materializedInspect).toBeLessThan(5000)
        }
        expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
        await filter.fill(''); await expect(page.locator('.schema-object')).toHaveCount(tableCount)
        await page.locator('.monaco-editor').click(); await page.keyboard.press(`${key}+End`); start = performance.now(); await page.keyboard.type(' typing verified',{delay:10}); timings.typingInput = performance.now()-start
        await expect.poll(sqlText).toBe(buffer+' typing verified'); timings.typing = performance.now()-start; timings.typingPersistWait = timings.typing-timings.typingInput
        const source = `SELECT c. FROM ${q(table(0))} c`
        await page.keyboard.press(`${key}+A`); await page.keyboard.insertText(source); await page.keyboard.press('Escape'); await page.keyboard.press('Home')
        for (let i=0;i<'SELECT c.'.length;i++) await page.keyboard.press('ArrowRight')
        start = performance.now(); await page.keyboard.press('Control+Space'); await expect(page.locator('.suggest-widget.visible').getByText(engine === 'oracle' ? 'LABEL' : 'label',{exact:true})).toBeVisible(); timings.completion = performance.now()-start
        await page.keyboard.press('Escape'); expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
        await page.screenshot({path:info.outputPath(profile+'-large-catalog-explorer.png')})
        for (const name of ['connect','refresh']) expect(timings[name],name).toBeLessThan(10000)
        expect(timings.inspect).toBeLessThan(5000)
        for (const name of ['filter0','filter1','filter2','typing','completion']) expect(timings[name],JSON.stringify({profile,phase:name,timings})).toBeLessThan(2000)
      } finally { await app?.evaluate(({app}) => app.exit()).catch(() => {}); await app?.close().catch(() => {}) }
    }
  } catch (error) { failed = true; throw error }
  finally {
    try {
      await run(`DROP VIEW IF EXISTS ${q(prefix+'view')}`)
      if (engine === 'oracle') await run(`DROP MATERIALIZED VIEW IF EXISTS ${q(prefix+'materialized')}`)
      for (let start=0;start<created;start+=150) await run(Array.from({length:Math.min(150,created-start)},(_,offset) => `DROP TABLE IF EXISTS ${q(table(start+offset))}${engine === 'oracle' ? ' PURGE' : ''};`).join('\n'))
    } catch (error) { if (!failed) throw error; console.error('Server-catalog UI fixture cleanup failed:',engine,prefix,String(error)) }
    finally {
      if (tds && !tds.closed) await new Promise<void>(resolve => { tds.once('end',resolve); tds.close() })
      await driver.close(); rmSync(directory,{recursive:true,force:true})
      writeFileSync(info.outputPath('server-catalog.json'),JSON.stringify({engine,version,tables:SERVER_CATALOG_TABLES,measurements},null,2))
    }
  }
})
