import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Connection, Request } from 'tedious'
import { engineNames } from '../../src/shared/database-engines'
import { waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['sqlserver', 'azure-sql'] as const) {
  test(`security principals ${engine} separates database roles from server logins`, async ({}, info) => {
    test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('sqlserver'), 'A SQL Server fixture is required.')
    const port = Number(process.env.SQLCOMMANDER_SQLSERVER_PORT), ca = readFileSync(process.env.SQLCOMMANDER_SQLSERVER_CA!, 'utf8')
    const fixture = new Connection({ server: 'localhost', authentication: { type: 'default',
      options: { userName: 'sa', password: 'Local-SA-Only!2026' } },
      options: { database: 'dbcommander', port, encrypt: true, trustServerCertificate: false, cryptoCredentialsDetails: { ca } } })
    await new Promise<void>((resolve, reject) => fixture.connect(error => error ? reject(error) : resolve()))
    const fixtureQuery = (sql: string) => new Promise<string[]>((resolve, reject) => {
      const rows: string[] = []
      const query = new Request(sql, error => error ? reject(error) : resolve(rows))
      query.on('row', columns => rows.push(String(columns[0].value)))
      fixture.execSqlBatch(query)
    })
    const name = 'a1_' + randomUUID().slice(0, 8)
    const reviewedLogin = name + '_login'
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-sqlserver-principals-'))
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      await fixtureQuery(`CREATE ROLE [${name}]; DENY UPDATE ON OBJECT::dbo.customers TO [${name}];`)
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
      await form.getByLabel('Database engine').selectOption(engine)
      await form.getByLabel('Port', { exact: true }).fill(String(port))
      await form.getByLabel('Database', { exact: true }).fill('dbcommander')
      await form.getByLabel('User', { exact: true }).fill('sa')
      await form.getByLabel('Password', { exact: true }).fill('Local-SA-Only!2026')
      await form.getByText('Custom CA certificate', { exact: true }).click()
      await form.getByLabel('CA certificate PEM').fill(ca)
      await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(form).toBeHidden()
      await waitForConnectionIdle(page)
      const zoom = engine === 'sqlserver' ? 1 : 1.25
      await desktop.evaluate(({ BrowserWindow }, zoom) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(1100, 750)
        window.webContents.setZoomFactor(zoom)
      }, zoom)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(1100 / zoom))
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const opener = page.getByRole('button', { name: 'Switch to database dbcommander', exact: true })
      await opener.focus()
      await page.keyboard.press('Shift+F10')
      const menuItem = page.getByRole('menuitem', { name: 'Security principals', exact: true })
      await expect(menuItem).toBeEnabled()
      await menuItem.focus()
      await expect(menuItem).toBeFocused()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Security principals', exact: true })
      const search = dialog.getByLabel('Principal name search')
      const searchButton = dialog.getByRole('button', { name: 'Search principals', exact: true })
      await search.fill(name)
      await searchButton.click()
      await expect(dialog.getByText('1 principal returned', { exact: true })).toBeVisible()
      await dialog.getByRole('combobox', { name: 'Database principal', exact: true }).selectOption({ label: name + ' · database role' })
      await dialog.getByLabel('Schema for relation check').fill('dbo')
      await dialog.getByLabel('Table or view name').fill('customers')
      await dialog.getByRole('button', { name: 'Inspect selected principal', exact: true }).click()
      await expect(dialog.getByRole('heading', { name, exact: true })).toBeFocused()
      const grants = dialog.getByRole('table', { name: `Visible privilege grants for ${name}`, exact: true })
      const deny = grants.getByRole('row', { name: 'UPDATE DENY Relation dbo.customers Direct No', exact: true })
      await deny.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(deny).toBeInViewport({ ratio: 1 })
      async function capture(label: string) {
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
        const png = await desktop.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          return (await window.webContents.capturePage()).resize({ width: 1100 }).toPNG().toString('base64')
        })
        writeFileSync(info.outputPath(`${engine}-principals-${label}.png`), Buffer.from(png, 'base64'))
      }
      await capture('inspect')
      await dialog.getByRole('button', { name: 'SQL preview', exact: true }).click()
      await dialog.getByRole('combobox', { name: 'Change', exact: true }).selectOption('revoke-relation')
      await dialog.getByRole('combobox', { name: 'Privilege', exact: true }).selectOption('UPDATE')
      await dialog.getByRole('button', { name: 'Review SQL', exact: true }).click()
      await expect(dialog.getByRole('heading', { name: engine === 'azure-sql' ? 'Review Azure SQL statement' : `Review ${engineNames[engine]} SQL`, exact: true })).toBeFocused()
      const sql = `REVOKE UPDATE ON OBJECT::[dbo].[customers] FROM [${name}];`
      await expect(dialog.getByLabel('Security principal SQL')).toHaveValue(sql)
      const copy = dialog.getByRole('button', { name: 'Copy SQL', exact: true })
      await copy.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByText('SQL copied.', { exact: true })).toBeInViewport({ ratio: 1 })
      expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(sql)
      await capture('preview')

      const select = dialog.getByRole('combobox', { name: 'Change', exact: true })
      const review = dialog.getByRole('button', { name: 'Review change', exact: true })
      const apply = dialog.getByRole('button', { name: 'Apply change', exact: true })
      const directDenial = () => fixtureQuery(`SELECT state FROM sys.database_permissions WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID('${name}')`)
      expect(await directDenial()).toEqual(['D'])
      await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      await select.selectOption('drop')
      await review.focus()
      await page.keyboard.press('Enter')
      const blocked = dialog.getByRole('alert')
      await expect(blocked).toContainText('permission dependencies')
      await expect(blocked).toBeFocused()
      await capture('review-blocked')
      await select.selectOption('revoke-relation')
      await dialog.getByRole('combobox', { name: 'Privilege', exact: true }).selectOption('UPDATE')
      await review.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: `Review ${engineNames[engine]} change`, exact: true })).toBeFocused()
      await expect(dialog.getByLabel(`Reviewed ${engineNames[engine]} SQL`)).toHaveValue(sql)
      await expect(dialog.getByText('Removing a denial can restore access through another grant.')).toBeVisible()
      await capture('review-denial')
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await dialog.getByLabel('Confirmation text', { exact: true }).fill('APPLY REVOKE RELATION')
      await apply.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(apply).toBeInViewport({ ratio: 1 })
      const context = dialog.locator('.principal-change-context')
      await expect(context).toBeInViewport({ ratio: 1 })
      await expect(context).toContainText('Database · dbcommander')
      await expect(context.locator('code')).toHaveText(sql)
      await capture('review-denial-confirm')
      await apply.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Change applied', exact: true })).toBeFocused()
      await expect(context.locator('code')).toHaveText(sql)
      expect(await directDenial()).toEqual([])

      await dialog.getByRole('button', { name: 'Inspect principals', exact: true }).click()
      await dialog.getByLabel('Principal scope', { exact: true }).selectOption('server')
      await search.fill('dbcommander')
      await searchButton.click()
      const login = dialog.getByRole('combobox', { name: 'Server principal', exact: true })
      await login.selectOption({ label: 'dbcommander · sql login' })
      await dialog.getByRole('button', { name: 'Inspect selected principal', exact: true }).click()
      await expect(dialog.getByRole('heading', { name: 'dbcommander', exact: true })).toBeFocused()
      await expect(dialog.getByLabel('Schema for relation check')).toHaveCount(0)
      await capture('server')
      await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      await select.selectOption('create-login')
      await dialog.getByLabel('New login name', { exact: true }).fill(reviewedLogin)
      await review.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: `Review ${engineNames[engine]} change`, exact: true })).toBeFocused()
      await expect(dialog.getByLabel(`Reviewed ${engineNames[engine]} SQL`)).toHaveValue(`CREATE LOGIN [${reviewedLogin}] WITH PASSWORD = @newPassword;`)
      await expect(dialog.getByText(/Connected as sa in master/)).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Copy SQL', exact: true })).toHaveCount(0)
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await dialog.getByLabel('Confirmation text', { exact: true }).fill('APPLY CREATE LOGIN')
      await expect(apply).toBeDisabled()
      expect(await fixtureQuery(`SELECT name FROM sys.server_principals WHERE name = '${reviewedLogin}'`)).toEqual([])
      const password = dialog.getByLabel('New login password', { exact: true })
      await expect(password).toHaveAttribute('type', 'password')
      await password.fill('Local-Login-Test-Only!2026')
      await apply.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(apply).toBeInViewport({ ratio: 1 })
      await expect(context).toBeInViewport({ ratio: 1 })
      await expect(context).toContainText('Server · master')
      await expect(context.locator('code')).toHaveText(`CREATE LOGIN [${reviewedLogin}] WITH PASSWORD = @newPassword;`)
      await capture('review-login')
      await apply.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Change applied', exact: true })).toBeFocused()
      await expect(context).toContainText(reviewedLogin)
      await expect(dialog.getByText(`${engineNames[engine]} verified and committed the reviewed principal change.`, { exact: true })).toBeVisible()
      await expect(password).toHaveCount(0)
      await capture('review-applied')
      expect(await fixtureQuery(`SELECT name FROM sys.server_principals WHERE name = '${reviewedLogin}'`)).toEqual([reviewedLogin])
      await page.keyboard.press('Escape')
      await expect(opener).toBeFocused()
      expect(await directDenial()).toEqual([])
    } finally {
      await app?.evaluate(({ app }) => app.exit()).catch(() => {})
      await app?.close().catch(() => {})
      try {
        await fixtureQuery(`IF DATABASE_PRINCIPAL_ID('${name}') IS NOT NULL DROP ROLE [${name}];
          IF SUSER_ID('${reviewedLogin}') IS NOT NULL DROP LOGIN [${reviewedLogin}];`)
      }
      finally { fixture.close(); rmSync(directory, { recursive: true, force: true }) }
    }
  })
}
