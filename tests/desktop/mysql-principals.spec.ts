import { _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openMysqlTransport } from '../../src/driver/mysql-transport'
import { engineNames } from '../../src/shared/database-engines'
import { mysqlPrincipalSql } from '../../src/shared/principals'
import { waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

for (const engine of ['mysql', 'mariadb'] as const) {
  test(`security principals ${engine} preserves account identity and copies scoped SQL`, async ({}, info) => {
    test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes(engine), `A ${engine} fixture is required.`)
    const prefix = `SQLCOMMANDER_${engine.toUpperCase()}`
    const port = Number(process.env[`${prefix}_PORT`])
    const ca = readFileSync(process.env[`${prefix}_CA`]!, 'utf8')
    const user = 'a1_' + randomUUID().slice(0, 8), host = engine === 'mysql' ? '%' : ''
    const reviewed = user + '_reviewed'
    const reviewedAccount = mysqlPrincipalSql(engine, { user: reviewed, host: 'localhost' })
    const role = mysqlPrincipalSql(engine, { user, host })
    const fixture = await openMysqlTransport({ engine, name: 'Fixture', host: 'localhost', port, user: 'root', password: 'local-root-test-only', database: 'dbcommander', tls: 'verify-full', ca })
    const directory = mkdtempSync(join(tmpdir(), 'dbcommander-mysql-principals-'))
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      await fixture.query(`CREATE ROLE ${role}`)
      await fixture.query(`GRANT SELECT ON dbcommander.customers TO ${role}`)
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
      await form.getByLabel('User', { exact: true }).fill('root')
      await form.getByLabel('Password', { exact: true }).fill('local-root-test-only')
      await form.getByText('Custom CA certificate', { exact: true }).click()
      await form.getByLabel('CA certificate PEM').fill(ca)
      await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(form).toBeHidden()
      await waitForConnectionIdle(page)

      const zoom = engine === 'mysql' ? 2 : 1
      await desktop.evaluate(({ BrowserWindow }, zoom) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(1024, 740)
        window.webContents.setZoomFactor(zoom)
      }, zoom)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(1024 / zoom))
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const opener = page.getByRole('button', { name: 'Switch to database dbcommander', exact: true })
      await opener.focus()
      await page.keyboard.press('Shift+F10')
      const security = page.getByRole('menuitem', { name: 'Security principals', exact: true })
      await expect(security).toBeEnabled()
      await security.focus()
      await expect(security).toBeFocused()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Security principals', exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Account or role search').fill(user)
      await dialog.getByRole('button', { name: 'Search principals', exact: true }).click()
      await expect(dialog.getByText('1 principal returned', { exact: true })).toBeVisible()
      await dialog.getByRole('combobox', { name: 'Account or role', exact: true }).selectOption(JSON.stringify([user, host]))
      await dialog.getByLabel('Database for relation check').fill('dbcommander')
      await dialog.getByLabel('Table or view name').fill('customers')
      await dialog.getByRole('button', { name: 'Inspect selected principal', exact: true }).click()
      const grants = dialog.getByRole('table', { name: `Visible privilege grants for ${role}`, exact: true })
      const select = grants.getByRole('row', { name: 'SELECT Table dbcommander.customers Direct No', exact: true })
      await select.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(select).toBeInViewport({ ratio: 1 })
      const preview = dialog.getByRole('button', { name: 'SQL preview', exact: true })
      await expect(preview).toBeInViewport({ ratio: 1 })
      async function capture(name: string) {
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
        const png = await desktop.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          return (await window.webContents.capturePage()).resize({ width: 1024 }).toPNG().toString('base64')
        })
        writeFileSync(info.outputPath(`${engine}-principals-${name}.png`), Buffer.from(png, 'base64'))
      }
      await capture('inspect')
      await preview.click()
      await dialog.getByRole('combobox', { name: 'Change', exact: true }).selectOption('grant-relation')
      await dialog.getByRole('combobox', { name: 'Privilege', exact: true }).selectOption('UPDATE')
      await dialog.getByRole('button', { name: 'Review SQL', exact: true }).click()
      await expect(dialog.getByRole('heading', { name: `Review ${engineNames[engine]} SQL`, exact: true })).toBeFocused()
      const sql = `GRANT UPDATE ON \`dbcommander\`.\`customers\` TO ${role};`
      await expect(dialog.getByLabel('Security principal SQL')).toHaveValue(sql)
      const copy = dialog.getByRole('button', { name: 'Copy SQL', exact: true })
      await copy.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByText('SQL copied.', { exact: true })).toBeInViewport({ ratio: 1 })
      expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(sql)
      await capture('preview')
      const tableGrants = () => fixture.query('SELECT Table_priv FROM mysql.tables_priv WHERE User = ? AND Host = ? AND Db = ? AND Table_name = ?', [user, host, 'dbcommander', 'customers'])
      expect(await tableGrants()).toEqual([['Select']])
      await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      const action = dialog.getByRole('combobox', { name: 'Change', exact: true })
      const review = dialog.getByRole('button', { name: 'Review change', exact: true })
      const context = dialog.locator('.principal-change-context')
      await action.selectOption('grant-relation')
      await dialog.getByRole('combobox', { name: 'Privilege', exact: true }).selectOption('UPDATE')
      await review.focus()
      await page.keyboard.press('Enter')
      await context.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(context).toBeInViewport({ ratio: 1 })
      await expect(context).toContainText('Database · dbcommander · Commits automatically')
      await expect(context.locator('code')).toHaveText(sql)
      await capture('review-relation-scope')
      await dialog.getByRole('button', { name: 'Back to change', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(action).toBeFocused()
      await action.selectOption('drop')
      await review.focus()
      await page.keyboard.press('Enter')
      const blocked = dialog.getByRole('alert')
      await expect(blocked).toContainText('blocked by grants')
      await expect(blocked).toBeFocused()
      await capture('review-blocked')
      await action.selectOption('create-login')
      await dialog.getByLabel('New account name', { exact: true }).fill(reviewed)
      await expect(review).toBeDisabled()
      await dialog.getByLabel('New account host', { exact: true }).fill('localhost')
      await review.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: `Review ${engineNames[engine]} change`, exact: true })).toBeFocused()
      const reviewedSql = dialog.getByLabel(`Reviewed ${engineNames[engine]} SQL`, { exact: true })
      await expect(reviewedSql).toHaveValue(`CREATE USER ${reviewedAccount} ACCOUNT LOCK;`)
      await reviewedSql.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(reviewedSql).toBeInViewport({ ratio: 1 })
      await capture('review-sql')
      const apply = dialog.getByRole('button', { name: 'Apply change', exact: true })
      await dialog.getByLabel('Confirmation text', { exact: true }).fill('APPLY CREATE LOGIN')
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await expect(apply).toBeDisabled()
      const findAccount = () => fixture.bound('SELECT Host FROM mysql.user WHERE BINARY User = BINARY ?', [reviewed])
      expect((await findAccount()).rows).toEqual([])
      await dialog.getByRole('checkbox', { name: 'I understand this change commits automatically.' }).check()
      await apply.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(apply).toBeInViewport({ ratio: 1 })
      await expect(context).toBeInViewport({ ratio: 1 })
      await expect(context).toContainText('Server-wide account or role change · Commits automatically')
      await expect(context.locator('code')).toHaveText(`CREATE USER ${reviewedAccount} ACCOUNT LOCK;`)
      await capture('review-confirm')
      await apply.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Change applied', exact: true })).toBeFocused()
      await expect(context).toContainText(reviewedAccount)
      await capture('review-applied')
      expect((await findAccount()).rows).toEqual([['localhost']])
      await page.keyboard.press('Escape')
      await expect(opener).toBeFocused()
      expect(await tableGrants()).toEqual([['Select']])
    } finally {
      await app?.evaluate(({ app }) => app.exit()).catch(() => {})
      await app?.close().catch(() => {})
      try {
        await fixture.query(`DROP USER IF EXISTS ${reviewedAccount}`)
        await fixture.query(`DROP ROLE IF EXISTS ${role}`)
      }
      finally { await fixture.end(); rmSync(directory, { recursive: true, force: true }) }
    }
  })
}
