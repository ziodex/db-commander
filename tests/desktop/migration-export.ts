import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseEngine } from '../../src/shared/contracts'
import { transactionalDdl } from '../../src/shared/schema-changes'

export async function verifyMigrationExport(app: ElectronApplication, page: Page, engine: DatabaseEngine, directory: string, testInfo: TestInfo, source: 'change'|'comparison', destructive = false) {
  const parent = page.getByRole('dialog',{ name: source === 'change' ? 'Schema changes' : 'Compare schemas', exact: true })
  const before = (await page.evaluate(() => window.dbCommander.history())).length
  await parent.getByRole('button',{name:'Export migration…',exact:true}).click()
  const dialog = page.getByRole('dialog',{name:'Export migration',exact:true}), contents = dialog.getByLabel('Migration file contents')
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(parent).toBeVisible()
  await parent.getByRole('button',{name:'Export migration…',exact:true}).click()
  await dialog.getByLabel('Migration name',{exact:true}).fill('../invalid')
  await dialog.getByRole('button',{name:'Prepare migration preview',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('Use letters')
  await dialog.getByLabel('Migration name',{exact:true}).fill('reviewed_'+source)
  await dialog.getByRole('button',{name:'Prepare migration preview',exact:true}).click()
  await expect(contents).toBeVisible(); expect(await contents.inputValue()).not.toMatch(/^BEGIN|^COMMIT/m)
  await expect(dialog.getByRole('button',{name:'Export migration file',exact:true})).toBeDisabled()
  await dialog.getByLabel('I reviewed the migration file, target and transaction handling.').check()
  await dialog.getByLabel('Migration name',{exact:true}).fill('reviewed_'+source+'_final')
  await expect(contents).toHaveCount(0)
  if (transactionalDdl(engine)) await dialog.getByLabel('Migration transaction handling').selectOption('transaction')
  else expect(await dialog.getByLabel('Migration transaction handling').locator('option').count()).toBe(1)
  await dialog.getByRole('button',{name:'Prepare migration preview',exact:true}).click()
  await expect(contents).toBeVisible(); const sql = await contents.inputValue()
  expect(sql).toContain(`Engine: ${engine}`)
  if (transactionalDdl(engine)) expect(sql).toMatch(/\nCOMMIT;\n$/)
  else expect(sql).toContain('commits implicitly')
  if (source === 'comparison') expect(sql).toContain('Partial schema-comparison')
  await expect(dialog.getByLabel('I reviewed the migration file, target and transaction handling.')).not.toBeChecked()
  await dialog.getByLabel('I reviewed the migration file, target and transaction handling.').check()
  if (destructive) {
    await expect(dialog.getByRole('button',{name:'Export migration file',exact:true})).toBeDisabled()
    await dialog.getByLabel('I understand this migration includes destructive SQL.').check()
  }
  await dialog.getByText('File checksum (SHA-256)',{exact:true}).click()
  await expect(dialog.locator('.migration-checksum')).toHaveText(createHash('sha256').update(sql).digest('hex'))
  await app.evaluate(({dialog}) => { dialog.showSaveDialog = async () => ({canceled:true,filePath:''}) })
  await dialog.getByRole('button',{name:'Export migration file',exact:true}).click()
  await expect(dialog.getByRole('status')).toHaveText('Export cancelled. No file was created.')
  const existing = join(directory,'existing.sql'); writeFileSync(existing,'preserved migration')
  await app.evaluate(({dialog},file) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:file}) },existing)
  await dialog.getByRole('button',{name:'Export migration file',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('already exists'); expect(readFileSync(existing,'utf8')).toBe('preserved migration')
  const path = join(directory,`${source}-${destructive?'destructive':'forward'}.sql`)
  await app.evaluate(({dialog},file) => { dialog.showSaveDialog = async (_window: Electron.BaseWindow | Electron.SaveDialogOptions, options?: Electron.SaveDialogOptions) => {
    if (!/^\d{17}_reviewed_(change|comparison)_final\.sql$/.test((options ?? _window as Electron.SaveDialogOptions).defaultPath!)) throw new Error('Invalid suggested migration filename')
    return {canceled:false,filePath:file}
  } },path)
  await dialog.getByRole('button',{name:'Export migration file',exact:true}).click()
  await expect(dialog.getByRole('status')).toContainText(`Migration exported to ${path}`)
  expect(readFileSync(path,'utf8')).toBe(sql); expect((await page.evaluate(() => window.dbCommander.history())).length).toBe(before)
  if (!destructive) {
    if (engine === 'duckdb') {
      await app.evaluate(({BrowserWindow}) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(800,600); window.setSize(960,720) })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(960)
      await dialog.getByRole('button',{name:'Export migration file',exact:true}).scrollIntoViewIfNeeded()
      const bounds = await dialog.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(960); expect(bounds!.height).toBeLessThanOrEqual(720)
    }
    await page.screenshot({path:testInfo.outputPath(`${engine}-${source}-migration.png`)})
  }
  await dialog.getByRole('button',{name:'Close migration export',exact:true}).click()
  await expect(dialog).not.toBeVisible(); await expect(parent).toBeVisible()
  return path
}
