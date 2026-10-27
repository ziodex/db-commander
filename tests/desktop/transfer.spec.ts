import { waitForWorkspaceReady } from './workspace-ready'
import { queryTool } from './workspace-actions'
import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { quoteIdentifier } from '../../src/shared/sql/common'
import { engineSchema } from '../../src/shared/contracts'

for (const engine of engineSchema.options) test(`data transfer ${engine}: mapped import, transaction decisions and full-result export`, async ({}, testInfo) => {
  test.setTimeout(180000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine === 'azure-sql' ? 'sqlserver' : engine), 'Engine not selected by Docker runner')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-browse-ui-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const page = await app.firstWindow(), name = `transfer_ui_${Date.now()}`, q = (value: string) => quoteIdentifier(value, engine)
  async function run(sql: string) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(sql); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
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

    const textType = ['sqlserver', 'azure-sql'].includes(engine) ? 'NVARCHAR' : 'VARCHAR'
    await run(`CREATE TABLE ${q(name)} (${q('id')} INTEGER PRIMARY KEY,${q('label')} ${textType}(200),${q('note')} ${textType}(40) DEFAULT 'default')`)
    const input = join(directory, 'input.csv'), output = join(directory, 'full.json')
    writeFileSync(input, 'source_id,source_label\n' + Array.from({ length: 1205 }, (_, i) => `${i},"${i === 0 ? "O'Brien, Ω" : `row ${i}`}"\n`).join(''))
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, input)
    await queryTool(page, 'Data import and export')
    const transfer = page.getByRole('dialog', { name: 'Data import and export', exact: true })
    async function configureImport() {
      await transfer.getByLabel('Transfer operation').selectOption('import')
      await transfer.getByRole('button', { name: 'Choose import file', exact: true }).click()
      const option = await transfer.getByLabel('Import target table').locator('option').filter({ hasText: name }).getAttribute('value')
      await transfer.getByLabel('Import target table').selectOption(option!)
      await transfer.getByRole('button', { name: 'Preview and map columns', exact: true }).click()
      await expect(transfer.getByRole('heading', { name: 'Column mapping', exact: true })).toBeVisible()
      await transfer.getByLabel('Map source_id', { exact: true }).selectOption('id'); await transfer.getByLabel('Map source_label', { exact: true }).selectOption('label')
      await transfer.getByRole('checkbox').check()
    }
    await configureImport()
    await page.screenshot({ path: testInfo.outputPath(`${engine}-import-mapping.png`) })
    await transfer.getByRole('button', { name: 'Import into transaction', exact: true }).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows', { timeout: 90000 })
    await expect(transfer).toContainText('Commit or Rollback')
    await transfer.getByRole('button', { name: 'Close data transfer', exact: true }).click()
    await expect(page.locator('.transaction-badge')).toHaveText('In transaction')
    await page.getByRole('button', { name: 'Rollback', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT COUNT(*) AS ${q('count')} FROM ${q(name)}`)
    await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible()
    await queryTool(page, 'Data import and export'); await configureImport()
    await transfer.getByRole('button', { name: 'Import into transaction', exact: true }).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows', { timeout: 90000 })
    await transfer.getByRole('button', { name: 'Close data transfer', exact: true }).click()
    await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.status-text')).toHaveText('Completed')
    await run(`SELECT * FROM ${q(name)} ORDER BY ${q('id')}`)
    await expect(page.getByRole('table', { name: 'Query results', exact: true })).toHaveAttribute('aria-rowcount', '1001')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
    await queryTool(page, 'Data import and export')
    await transfer.getByLabel('Data format').selectOption('json')
    await transfer.getByRole('button', { name: 'Choose export destination', exact: true }).click()
    await expect(transfer.getByLabel('SQL to execute for export')).toHaveValue(`SELECT * FROM ${q(name)} ORDER BY ${q('id')}`)
    await transfer.getByRole('checkbox').check(); await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1,205 rows', { timeout: 60000 })
    const data = JSON.parse(readFileSync(output, 'utf8'))
    expect(data.rows).toHaveLength(1205); expect(data.rows[0]).toEqual(['0', "O'Brien, Ω", 'default']); expect(data.rows.at(-1)[0]).toBe('1204')
    await page.screenshot({ path: testInfo.outputPath(`${engine}-full-export.png`) })
    // Reusing a destination fails before any query is re-executed.
    await transfer.getByRole('button', { name: 'Configure another transfer', exact: true }).click(); await transfer.getByRole('checkbox').check()
    await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(transfer.getByRole('status')).toContainText('failed'); await expect(transfer).toContainText('already exists')
    expect(JSON.parse(readFileSync(output, 'utf8')).rows).toHaveLength(1205)
    // Only the selected query enters export; an unselected DELETE must never run.
    await transfer.getByRole('button', { name: 'Close data transfer', exact: true }).click()
    const selected = `SELECT ${q('id')} FROM ${q(name)} WHERE ${q('id')}=1204`
    await page.locator('.monaco-editor').click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(`DELETE FROM ${q(name)};\n${selected}`); await page.keyboard.press('Escape')
    for (let i = 0; i < selected.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await queryTool(page, 'Data import and export')
    await expect(transfer.getByLabel('SQL to execute for export')).toHaveValue(selected)
    const selectionFile = join(directory, 'selected.csv')
    await transfer.getByLabel('New export file').fill(selectionFile)
    await transfer.getByRole('checkbox').check(); await transfer.getByRole('button', { name: 'Run and export', exact: true }).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 1 rows')
    expect(readFileSync(selectionFile, 'utf8')).toBe('"id"\r\n"1204"\r\n')
    // SQL INSERT export writes a reviewed destination without executing the file.
    await transfer.getByRole('button', { name: 'Configure another transfer', exact: true }).click()
    await transfer.getByLabel('Data format').selectOption('sql')
    await transfer.getByLabel('SQL to execute for export').fill(`SELECT * FROM ${q(name)} WHERE ${q('id')}<2 ORDER BY ${q('id')}`)
    await app.evaluate(({dialog}) => { dialog.showSaveDialog=async()=>({canceled:true,filePath:''}) })
    await transfer.getByRole('button',{name:'Choose export destination',exact:true}).click()
    await expect(transfer.getByLabel('New export file')).toHaveValue('')
    const insertsFile=join(directory,'inserts.sql'),copy=name+'_copy'
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},insertsFile)
    await transfer.getByRole('button',{name:'Choose export destination',exact:true}).click()
    await transfer.getByRole('checkbox').check()
    await expect(transfer.getByRole('button',{name:'Run and export',exact:true})).toBeDisabled()
    await transfer.getByLabel('INSERT export table',{exact:true}).fill(copy)
    await expect(transfer.getByRole('checkbox')).not.toBeChecked()
    await expect(transfer.getByLabel('INSERT destination preview')).toContainText(q(copy))
    await transfer.getByRole('checkbox').check()
    await page.screenshot({path:testInfo.outputPath(`${engine}-insert-export.png`)})
    await transfer.getByRole('button',{name:'Run and export',exact:true}).click()
    await expect(transfer.getByRole('status')).toHaveText('completed · 2 rows')
    const inserts=readFileSync(insertsFile,'utf8');expect(inserts.match(/INSERT INTO/g)).toHaveLength(2)
    await transfer.getByRole('button',{name:'Close data transfer',exact:true}).click()
    await run(`CREATE TABLE ${q(copy)} (${q('id')} INTEGER,${q('label')} ${textType}(200),${q('note')} ${textType}(40))`)
    await run(`SELECT COUNT(*) FROM ${q(copy)}`);await expect(page.getByRole('cell',{name:'0',exact:true})).toBeVisible()
    await run(inserts);if(engine==='oracle')await run('COMMIT')
    await run(`SELECT COUNT(*) FROM ${q(copy)}`);await expect(page.getByRole('cell',{name:'2',exact:true})).toBeVisible()
    await run(`SELECT ${q('label')} FROM ${q(copy)} WHERE ${q('id')}=0`);await expect(page.getByRole('cell',{name:"O'Brien, Ω",exact:true})).toBeVisible()
    await run(`DROP TABLE ${q(copy)}`)
    await queryTool(page,'Data import and export')
    // Cancellation rolls back all imported rows and keeps the same tab usable.
    writeFileSync(input, 'source_id,source_label\n' + Array.from({ length: 50000 }, (_, i) => `${10000 + i},cancel\n`).join(''))
    await configureImport(); await transfer.getByRole('button', { name: 'Import into transaction', exact: true }).click()
    await transfer.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
    await expect(transfer.getByRole('status')).toContainText('cancelled', { timeout: 60000 })
    await transfer.getByRole('button', { name: 'Close data transfer', exact: true }).click()
    await run(`SELECT COUNT(*) AS ${q('count')} FROM ${q(name)}`); await expect(page.getByRole('cell', { name: '1205', exact: true })).toBeVisible()
    await run(`DROP TABLE ${q(name)}`)
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true })
  }
})
