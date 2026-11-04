import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import oracledb from 'oracledb'
import { waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

test('security principals oracle inspects container grants and copies Oracle SQL', async ({}, info) => {
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('oracle'), 'An Oracle fixture is required.')
  const port = Number(process.env.SQLCOMMANDER_ORACLE_PORT), role = 'A1_' + randomUUID().slice(0, 8).toUpperCase()
  const reviewed = role + '_LOGIN'
  const fixture = await oracledb.getConnection({
    user: 'system', password: 'Local-Admin-Only2026', connectString: `tcps://localhost:${port}/FREEPDB1`
  })
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-oracle-principals-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await fixture.execute(`CREATE ROLE "${role}" NOT IDENTIFIED`)
    await fixture.execute(`GRANT SELECT ON DBCOMMANDER.CUSTOMERS TO "${role}"`)
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const desktop = app = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }),
      env: env as Record<string, string>
    })
    const page = await desktop.firstWindow()
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByLabel('Database engine').selectOption('oracle')
    await form.getByLabel('Port', { exact: true }).fill(String(port))
    await form.getByLabel('Service name', { exact: true }).fill('FREEPDB1')
    await form.getByLabel('User', { exact: true }).fill('system')
    await form.getByLabel('Password', { exact: true }).fill('Local-Admin-Only2026')
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(form).toBeHidden()
    await waitForConnectionIdle(page)
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1100, 750)
      window.webContents.setZoomFactor(1.25)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(880)
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const opener = page.locator('.database-node.current > button').first()
    await opener.focus()
    await page.keyboard.press('Shift+F10')
    const menuItem = page.getByRole('menuitem', { name: 'Security principals', exact: true })
    await expect(menuItem).toBeEnabled()
    await menuItem.focus()
    await expect(menuItem).toBeFocused()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Security principals', exact: true })
    await dialog.getByLabel('Principal name search').fill(role)
    await dialog.getByRole('button', { name: 'Search principals', exact: true }).click()
    await expect(dialog.getByText('1 principal returned', { exact: true })).toBeVisible()
    await dialog.getByRole('combobox', { name: 'User or role', exact: true }).selectOption({ label: role + ' · Role' })
    await dialog.getByLabel('Schema for relation check').fill('DBCOMMANDER')
    await dialog.getByLabel('Table or view name').fill('CUSTOMERS')
    await dialog.getByRole('button', { name: 'Inspect selected principal', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: role, exact: true })).toBeFocused()
    const grants = dialog.getByRole('table', { name: `Visible privilege grants for ${role}`, exact: true })
    const select = grants.getByRole('row', { name: 'SELECT Relation DBCOMMANDER.CUSTOMERS Direct No', exact: true })
    await select.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await expect(select).toBeInViewport({ ratio: 1 })
    async function capture(label: string) {
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return (await window.webContents.capturePage()).resize({ width: 1100 }).toPNG().toString('base64')
      })
      writeFileSync(info.outputPath(`oracle-principals-${label}.png`), Buffer.from(png, 'base64'))
    }
    await capture('inspect')
    await dialog.getByRole('button', { name: 'SQL preview', exact: true }).click()
    await dialog.getByRole('combobox', { name: 'Change', exact: true }).selectOption('grant-relation')
    await dialog.getByRole('combobox', { name: 'Privilege', exact: true }).selectOption('UPDATE')
    await dialog.getByRole('button', { name: 'Review SQL', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Review Oracle Database SQL', exact: true })).toBeFocused()
    const sql = `GRANT UPDATE ON "DBCOMMANDER"."CUSTOMERS" TO "${role}";`
    await expect(dialog.getByLabel('Security principal SQL')).toHaveValue(sql)
    await dialog.getByRole('button', { name: 'Copy SQL', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByText('SQL copied.', { exact: true })).toBeInViewport({ ratio: 1 })
    expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(sql)
    await capture('preview')

    const history = await page.evaluate(() => window.dbCommander.history())
    await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
    const action = dialog.getByRole('combobox', { name: 'Change', exact: true })
    const review = dialog.getByRole('button', { name: 'Review change', exact: true })
    await action.selectOption('drop')
    await review.focus()
    await page.keyboard.press('Enter')
    const blocked = dialog.getByRole('alert')
    await expect(blocked).toContainText('Removal is blocked')
    await expect(blocked).toBeFocused()
    await capture('review-blocked')
    await action.selectOption('create-login')
    await dialog.getByLabel('New database user name', { exact: true }).fill(reviewed)
    await review.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name: 'Review Oracle Database change', exact: true })).toBeFocused()
    await expect(dialog.getByLabel('Reviewed Oracle Database SQL')).toHaveValue(`CREATE USER "${reviewed}" IDENTIFIED BY :newPassword ACCOUNT LOCK CONTAINER = CURRENT;`)
    await expect(dialog.getByText(/Connected as SYSTEM in FREEPDB1/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Copy SQL', exact: true })).toHaveCount(0)
    await capture('review-sql')
    const status = async () => (await fixture.execute('SELECT ACCOUNT_STATUS FROM DBA_USERS WHERE USERNAME = :1',
      [reviewed], { outFormat: oracledb.OUT_FORMAT_ARRAY })).rows
    const apply = dialog.getByRole('button', { name: 'Apply change', exact: true })
    const password = dialog.getByLabel('New login password', { exact: true })
    await expect(password).toHaveAttribute('type', 'password')
    await password.fill('Local-Oracle-Test-Only!2026')
    await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
    await dialog.getByLabel('Confirmation text', { exact: true }).fill('APPLY CREATE LOGIN')
    await expect(apply).toBeDisabled()
    expect(await status()).toEqual([])
    await dialog.getByRole('checkbox', { name: 'I understand this change commits automatically.' }).check()
    await apply.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await expect(apply).toBeInViewport({ ratio: 1 })
    const context = dialog.locator('.principal-change-context')
    await expect(context).toBeInViewport({ ratio: 1 })
    await expect(context).toContainText('Container · FREEPDB1 · Commits automatically')
    await expect(context.locator('code')).toHaveText(`CREATE USER "${reviewed}" IDENTIFIED BY :newPassword ACCOUNT LOCK CONTAINER = CURRENT;`)
    await capture('review-confirm')
    await apply.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name: 'Change applied', exact: true })).toBeFocused()
    await expect(context).toContainText(reviewed)
    await expect(password).toHaveCount(0)
    expect(await status()).toEqual([['LOCKED']])
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(history)
    await capture('review-applied')
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
    const permission = await fixture.execute('SELECT PRIVILEGE FROM DBA_TAB_PRIVS WHERE GRANTEE = :1 AND OWNER = :2 AND TABLE_NAME = :3',
      [role, 'DBCOMMANDER', 'CUSTOMERS'], { outFormat: oracledb.OUT_FORMAT_ARRAY })
    expect(permission.rows).toEqual([['SELECT']])
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    try {
      try { await fixture.execute(`DROP USER "${reviewed}"`) }
      catch (error) { if ((error as { errorNum?: number }).errorNum !== 1918) throw error }
      await fixture.execute(`DROP ROLE "${role}"`)
    }
    finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }) }
  }
})
