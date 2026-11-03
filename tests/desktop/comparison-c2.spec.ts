import { _electron as electron, expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { tableNode } from './explorer-actions'
import { openConnectionSettings } from './profile-actions'
import { waitForWorkspaceReady } from './workspace-ready'

test('C2 comparison inventories, dependency order and reviewed synchronization', async ({}, info) => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-c2-'))
  const source = join(directory, 'source.sqlite'), target = join(directory, 'target.sqlite')
  for (const [file, isTarget] of [[source, false], [target, true]] as const) {
    const database = new DatabaseSync(file)
    try {
      database.exec('BEGIN; CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);')
      for (let index = 0; index < 56; index++) database.exec(`CREATE TABLE inventory_${String(index).padStart(3, '0')}(id INTEGER PRIMARY KEY)`)
      if (isTarget) database.exec('CREATE TABLE a_parent(id INTEGER PRIMARY KEY); CREATE TABLE z_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES a_parent(id) ON DELETE CASCADE);')
      const insert = database.prepare('INSERT INTO items VALUES (?, ?)')
      for (let id = 1; id <= 240; id++) insert.run(id === 240 && isTarget ? 241 : id, id === 2 ? (isTarget ? 'old target' : 'new source') : 'same')
      database.exec('COMMIT')
    } finally { database.close() }
  }
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: join(directory, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }),
    env: env as Record<string, string>
  })
  const page = await app.firstWindow()
  const captureRoot = process.env.SQLCOMMANDER_C2_CAPTURES
  async function capture(name: string) {
    // Let Electron paint the committed layout and scroll position before capture.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    if (captureRoot) mkdirSync(captureRoot, { recursive: true })
    const path = captureRoot ? join(captureRoot, name + '.png') : info.outputPath(name + '.png')
    const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(path, Buffer.from(bytes, 'base64'))
  }
  async function connect(file: string) {
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('sqlite')
    await form.getByLabel('Open mode').selectOption('read-write')
    await form.getByLabel('Database file').fill(file)
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  }
  try {
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    await connect(source)
    await page.getByRole('button', { name: 'New query tab', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await openConnectionSettings(page)
    await connect(target)

    await page.locator('.database-node.current > button').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Compare schemas', exact: true }).click()
    const schemas = page.getByRole('dialog', { name: 'Compare schemas', exact: true })
    await schemas.getByRole('button', { name: 'Compare inventory' }).click()
    await expect(schemas.getByRole('heading', { name: 'Visible object inventory' })).toBeFocused()
    await expect(schemas.getByRole('status')).toContainText('59 visible object names compared')
    await expect(schemas.getByRole('group', { name: 'Compared objects' }).getByRole('checkbox')).toHaveCount(25)
    await schemas.getByRole('button', { name: 'Next objects' }).click()
    await expect(schemas.getByRole('navigation', { name: 'Compared object pages' })).toContainText('page 2 of 3')
    await capture('inventory-dark')
    await schemas.getByLabel('Show objects').selectOption('target-only')
    await schemas.getByLabel('Select definition for table a_parent').check()
    await schemas.getByRole('button', { name: 'Compare selected definitions' }).click()
    const destructive = schemas.getByLabel('Include destructive DROP TABLE suggestions; I understand these remove target data.')
    await destructive.check()
    await expect(schemas.getByRole('alert')).toContainText('main.z_child still references it')
    await expect(schemas.getByRole('button', { name: 'Export migration…' })).toBeDisabled()
    expect(await schemas.getByLabel('Comparison SQL preview').inputValue()).not.toMatch(/^DROP TABLE/m)
    await capture('dependency-block-dark')
    await schemas.getByRole('button', { name: 'Compare inventory' }).click()
    await expect(schemas.getByRole('heading', { name: 'Visible object inventory' })).toBeFocused()
    await schemas.getByLabel('Show objects').selectOption('target-only')
    for (const name of ['a_parent', 'z_child']) await schemas.getByLabel(`Select definition for table ${name}`).check()
    await schemas.getByRole('button', { name: 'Compare selected definitions' }).click()
    await destructive.check()
    expect((await schemas.getByLabel('Comparison SQL preview').inputValue()).match(/^DROP TABLE.+$/gm)).toEqual([
      'DROP TABLE "main"."z_child";', 'DROP TABLE "main"."a_parent";'
    ])
    await schemas.getByRole('button', { name: 'Close schema comparison' }).click()

    await tableNode(page, 'items').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Compare data items' }).click()
    const data = page.getByRole('dialog', { name: 'Compare table data', exact: true })
    await data.getByLabel('Maximum rows per side').fill('200')
    await data.getByRole('button', { name: 'Compare data', exact: true }).click()
    await expect(data.getByRole('alert')).toContainText('No partial comparison')
    await expect(data.getByRole('button', { name: 'Review synchronization plan' })).toHaveCount(0)
    await data.getByLabel('Maximum rows per side').fill('240')
    await data.getByRole('button', { name: 'Compare data', exact: true }).click()
    await expect(data.getByRole('status')).toContainText('Compared 240 source and 240 target rows')
    for (const status of ['changed', 'source-only', 'target-only']) {
      await data.getByRole('group', { name: 'Compared rows' }).getByRole('button', { name: new RegExp(` · ${status}(?: · |$)`) }).click()
      await data.getByRole('button', { name: 'Stage selected row', exact: true }).click()
    }
    await data.getByRole('button', { name: 'Review synchronization plan', exact: true }).scrollIntoViewIfNeeded()
    await capture('data-stage-dark')
    await data.getByRole('button', { name: 'Review synchronization plan', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review synchronization plan', exact: true })
    const save = review.getByRole('button', { name: 'Save synchronization plan', exact: true })
    await expect(review).toContainText('1 insert · 1 update · 1 delete')
    const operation = review.getByLabel('Review operation')
    const updateOption = await operation.getByRole('option', { name: /^Update/ }).getAttribute('value')
    await operation.selectOption(updateOption!)
    await expect(review.getByRole('region', { name: 'Proposed operation' })).toContainText('old target')
    await expect(review.getByRole('region', { name: 'Proposed operation' })).toContainText('new source')
    await expect(save).toBeDisabled()
    await review.getByLabel('I reviewed the proposed operations and target.').check()
    await expect(save).toBeDisabled()
    await review.getByLabel('I understand this plan proposes deleting target rows.').check()
    await expect(save).toBeEnabled()
    await save.scrollIntoViewIfNeeded()
    await capture('plan-dark')
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1024, 700)
      window.webContents.setZoomFactor(1.25)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1024 / 1.25))
    await save.click({ trial: true })
    const width = await review.evaluate(node => ({ available: node.clientWidth, content: node.scrollWidth }))
    expect(width.content).toBeLessThanOrEqual(width.available + 1)
    await capture('plan-dark-125')
    const path = join(directory, 'sync.json')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, path)
    await save.click()
    await expect(review).toBeHidden()
    await expect(data.getByRole('status')).toHaveText('Synchronization plan saved. No data changed.')
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    expect(plan.operations.map((operation: { action: string }) => operation.action).sort()).toEqual(['delete', 'insert', 'update'])
    const update = plan.operations.find((operation: { action: string }) => operation.action === 'update')
    expect(update.expectedTarget).toEqual(['integer:2', 'text:old target'])
    expect(update.proposedRow).toEqual(['integer:2', 'text:new source'])
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual([])
    const untouched = new DatabaseSync(target, { readOnly: true })
    try { expect(untouched.prepare('SELECT label FROM items WHERE id=2').get()?.label).toBe('old target') }
    finally { untouched.close() }

    await data.getByRole('button', { name: 'Close data comparison' }).click()
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await preferences.getByLabel('Appearance', { exact: true }).selectOption('light')
    await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(preferences).toBeHidden()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(512)
    await tableNode(page, 'items').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Compare data items' }).click()
    await data.getByLabel('Maximum rows per side').fill('240')
    await data.getByRole('button', { name: 'Compare data', exact: true }).click()
    await expect(data.getByRole('status')).toContainText('Compared 240 source and 240 target rows')
    await data.getByRole('button', { name: 'Stage selected row', exact: true }).click()
    await data.getByRole('button', { name: 'Review synchronization plan', exact: true }).click()
    await expect(review).toContainText('0 inserts · 1 update · 0 deletes')
    await review.getByRole('region', { name: 'Proposed operation' }).locator('.data-cell-table').scrollIntoViewIfNeeded()
    await capture('plan-values-light-200')

    await review.getByLabel('I reviewed the proposed operations and target.').check()
    await save.click({ trial: true })
    const compact = await review.evaluate(node => ({ available: node.clientWidth, content: node.scrollWidth }))
    expect(compact.content).toBeLessThanOrEqual(compact.available + 1)
    await capture('plan-light-200')

  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {})
    await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})
