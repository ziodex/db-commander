import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { enterWorkspaceSql, waitForConnectionIdle, waitForWorkspaceReady } from './workspace-ready'

test('security principals PostgreSQL inspects effective access and copies a manual SQL preview', async ({}, info) => {
  test.setTimeout(120000)
  test.skip(!(process.env.SQLCOMMANDER_TEST_DRIVERS ?? '').split(',').includes('postgres'), 'PostgreSQL fixture is required')
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-principals-'))
  const prefix = 'a1_' + randomUUID().replaceAll('-', '').slice(0, 8), reader = prefix + '_reader', member = prefix + '_member'
  const reviewed = prefix + '_reviewed'
  const outsideSearch = 'other_' + prefix.slice(3)
  const ca = readFileSync(process.env.SQLCOMMANDER_PG_CA!, 'utf8'), port = Number(process.env.SQLCOMMANDER_PG_PORT)
  const fixture = new pg.Client({ host: 'localhost', port, database: 'dbcommander', user: 'dbcommander', password: 'local-test-only', ssl: { ca } })
  await fixture.connect()
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await fixture.query(`CREATE ROLE ${reader}; CREATE ROLE ${member}; CREATE ROLE ${outsideSearch}; GRANT ${reader} TO ${member};
      CREATE SCHEMA ${prefix}; CREATE TABLE ${prefix}.example (id int);
      GRANT USAGE ON SCHEMA ${prefix} TO ${member}; GRANT SELECT ON ${prefix}.example TO ${reader};`)
    const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const desktop = app = await electron.launch({
      ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: process.env.SQLCOMMANDER_TEST_EXECUTABLE } : { args: [resolve('.')] }), env: env as Record<string, string>
    })
    const page = await desktop.firstWindow()
    const dialog = page.getByRole('dialog', { name: 'Security principals', exact: true })
    async function capture(name: string) {
      await expect(dialog.getByRole('button', { name: 'Close security principals' })).toBeInViewport({ ratio: 1 })
      expect(await dialog.evaluate(node => node.scrollTop)).toBe(0)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const screenshot = await window.webContents.capturePage()
        return screenshot.resize({ width: window.getContentSize()[0] }).toPNG().toString('base64')
      })
      writeFileSync(info.outputPath(name), Buffer.from(png, 'base64'))
    }
    await waitForWorkspaceReady(page)
    await page.getByRole('button', { name: 'Connect database', exact: true }).click()
    const connection = page.getByRole('dialog')
    await connection.getByLabel('Database engine').selectOption('postgres')
    await connection.getByLabel('Port', { exact: true }).fill(String(port))
    await connection.getByLabel('Database', { exact: true }).fill('dbcommander')
    await connection.getByLabel('User', { exact: true }).fill('dbcommander')
    await connection.getByLabel('Password', { exact: true }).fill('local-test-only')
    await connection.getByText('Custom CA certificate', { exact: true }).click()
    await connection.getByLabel('CA certificate PEM').fill(ca)
    await connection.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connection).toBeHidden()
    await waitForConnectionIdle(page)
    await enterWorkspaceSql(page, 'SELECT 42 AS retained;')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await waitForConnectionIdle(page)
    const before = await page.evaluate(() => window.dbCommander.history())
    const trigger = page.locator('.database-node.current > button').first()

    for (const { theme, width, height, zoom, label } of [
      { theme: 'dark', width: 1400, height: 920, zoom: 1, label: 'dark-wide' },
      { theme: 'light', width: 1024, height: 700, zoom: 1.25, label: 'light-125' },
      { theme: 'dark', width: 1024, height: 700, zoom: 2, label: 'dark-200' }
    ]) {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click()
      const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
      await preferences.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await preferences.getByRole('button', { name: 'Apply settings', exact: true }).click()
      await expect(preferences).toBeHidden()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await desktop.evaluate(({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(dimensions.width, dimensions.height)
        window.webContents.setZoomFactor(dimensions.zoom)
      }, { width, height, zoom })
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(width / zoom))
      await waitForConnectionIdle(page)
      await trigger.focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: 'Security principals', exact: true }).click()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Close security principals' })).toBeInViewport({ ratio: 1 })
      const search = dialog.getByLabel('Role name search', { exact: true })
      await expect(search).toBeEnabled()
      const searchRoles = dialog.getByRole('button', { name: 'Search roles', exact: true })
      if (zoom === 1) {
        await search.fill(`${prefix}_absent`)
        await searchRoles.click()
        await expect(dialog.getByText('0 roles returned', { exact: true })).toBeVisible()
        await capture('principals-empty-dark-wide.png')
      }
      await search.fill(prefix)
      await searchRoles.click()
      await expect(dialog.getByText('2 roles returned', { exact: true })).toBeVisible()
      await dialog.getByLabel('Role', { exact: true }).selectOption({ label: member })
      await dialog.getByLabel('Schema for relation check', { exact: true }).fill(prefix)
      const table = dialog.getByLabel('Table or view name', { exact: true })
      const inspect = dialog.getByRole('button', { name: 'Inspect selected role', exact: true })
      if (zoom === 1) {
        await table.fill('missing_table')
        await inspect.click()
        const missing = dialog.getByText(/relation was missing or outside/)
        await missing.evaluate(node => node.scrollIntoView({ block: 'center' }))
        await expect(missing).toBeInViewport({ ratio: 1 })
        await capture('principals-missing-dark-wide.png')
      }
      await table.fill('example')
      await inspect.click()
      await expect(dialog.getByRole('heading', { name: member, exact: true })).toBeFocused()
      const relation = dialog.getByRole('table', { name: `Effective relation privileges for ${member}`, exact: true })
      await expect(relation.getByRole('row', { name: 'SELECT Yes No' })).toBeVisible()
      await expect(relation.getByRole('row', { name: 'UPDATE No No' })).toBeVisible()
      await dialog.getByText('Direct membership grants (1)', { exact: true }).click()
      await expect(dialog.getByRole('listitem').getByText(reader, { exact: true })).toBeVisible()
      const scope = dialog.getByText('Effective reflects table-level privileges. Schema access and row policies are evaluated separately.', { exact: true })
      await scope.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await expect(scope).toBeInViewport({ ratio: 1 })
      if (zoom === 2) await capture('principals-scope-dark-200.png')
      await relation.getByRole('row', { name: 'SELECT Yes No' }).evaluate(node => node.scrollIntoView({ block: 'center' }))
      const preview = dialog.getByRole('button', { name: 'SQL preview', exact: true })
      await expect(preview).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByText(`Inspected role ${member}`, { exact: true })).toBeInViewport({ ratio: 1 })
      await capture(`principals-inspect-${label}.png`)
      await preview.click()
      const change = dialog.getByLabel('Change', { exact: true })
      if (zoom === 1) {
        await change.selectOption('grant')
        await dialog.getByLabel('Member role name', { exact: true }).fill(outsideSearch)
        await dialog.getByRole('button', { name: 'Review SQL', exact: true }).click()
        await expect(dialog.getByLabel('Security principal SQL', { exact: true })).toHaveValue(`GRANT "${member}" TO "${outsideSearch}";`)
        await capture('principals-membership-dark-wide.png')
      }
      await change.selectOption('grant-relation')
      await dialog.getByRole('button', { name: 'Review SQL', exact: true }).click()
      await expect(dialog.getByRole('heading', { name: 'Review PostgreSQL SQL', exact: true })).toBeFocused()
      const sql = `GRANT SELECT ON TABLE "${prefix}"."example" TO "${member}";`
      await expect(dialog.getByLabel('Security principal SQL', { exact: true })).toHaveValue(sql)
      const copy = dialog.getByRole('button', { name: 'Copy SQL', exact: true })
      await copy.scrollIntoViewIfNeeded()
      await expect(copy).toBeInViewport({ ratio: 1 })
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true)
      await copy.focus()
      await page.keyboard.press('Enter')
      const copied = dialog.getByRole('status')
      await expect(copied).toHaveText('SQL copied.')
      await expect(copied).toBeInViewport({ ratio: 1 })
      await expect(copy).toBeFocused()
      await capture(`principals-preview-${label}.png`)
      expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(sql)
      await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      const changeAction = dialog.getByLabel('Change', { exact: true })
      const reviewChange = dialog.getByRole('button', { name: 'Review change', exact: true })
      if (zoom === 1) {
        await changeAction.selectOption('drop')
        await reviewChange.focus()
        await page.keyboard.press('Enter')
        const dependency = dialog.getByRole('alert')
        await expect(dependency).toContainText('shared dependency records (1) and membership grants (1)')
        await expect(dependency).toBeFocused()
        await capture('principals-reviewed-dependency-dark-wide.png')
      }
      await changeAction.selectOption('create-login')
      await dialog.getByLabel('New role name', { exact: true }).fill(reviewed)
      await reviewChange.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('heading', { name: 'Review PostgreSQL change', exact: true })).toBeFocused()
      const reviewedSql = dialog.getByLabel('Reviewed PostgreSQL SQL', { exact: true })
      const statement = `CREATE ROLE "${reviewed}" LOGIN PASSWORD NULL;`
      await expect(reviewedSql).toHaveValue(statement)
      await capture(`principals-reviewed-sql-${label}.png`)
      if (zoom === 2) {
        await reviewedSql.evaluate(node => node.scrollIntoView({ block: 'center' }))
        await expect(reviewedSql).toBeInViewport({ ratio: 1 })
        await capture('principals-reviewed-statement-dark-200.png')
        const reviewedCopy = dialog.getByRole('button', { name: 'Copy SQL', exact: true })
        await reviewedCopy.focus()
        await page.keyboard.press('Enter')
        await expect(dialog.getByText('SQL copied.', { exact: true })).toBeInViewport({ ratio: 1 })
        await expect(reviewedCopy).toBeFocused()
        expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(statement)
        await capture('principals-reviewed-copy-dark-200.png')
        await dialog.getByRole('button', { name: 'Back to change', exact: true }).focus()
        await page.keyboard.press('Enter')
        await expect(changeAction).toBeFocused()
        await expect(changeAction).toHaveValue('create-login')
        await capture('principals-reviewed-back-dark-200.png')
        await reviewChange.focus()
        await page.keyboard.press('Enter')
        await expect(reviewedSql).toHaveValue(statement)
      }
      const apply = dialog.getByRole('button', { name: 'Apply change', exact: true })
      await expect(apply).toBeDisabled()
      const confirm = dialog.getByRole('textbox', { name: 'Confirmation text' })
      await confirm.fill('APPLY CREATE LOGIN')
      await expect(apply).toBeDisabled()
      await dialog.getByRole('checkbox', { name: 'I reviewed the SQL and its effects.' }).check()
      await expect(apply).toBeEnabled()
      await apply.scrollIntoViewIfNeeded()
      await expect(apply).toBeInViewport({ ratio: 1 })
      const context = dialog.locator('.principal-change-context')
      await expect(context).toBeInViewport({ ratio: 1 })
      await expect(context).toContainText('Cluster-wide role change')
      await expect(context.locator('code')).toHaveText(statement)
      await capture(`principals-reviewed-confirm-${label}.png`)
      expect((await fixture.query('SELECT rolname FROM pg_roles WHERE rolname = $1', [reviewed])).rowCount).toBe(0)
      if (zoom === 2) {
        await apply.focus()
        await page.keyboard.press('Enter')
        await expect(dialog.getByRole('heading', { name: 'Change applied', exact: true })).toBeFocused()
        await expect(context).toContainText('Cluster-wide role change')
        await expect(context.locator('code')).toHaveText(statement)
        await capture(`principals-reviewed-success-${label}.png`)
        expect((await fixture.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [reviewed])).rows).toEqual([{ rolcanlogin: true }])
        await dialog.getByRole('button', { name: 'Refresh roles', exact: true }).focus()
        await page.keyboard.press('Enter')
        await expect(dialog.getByLabel('Role name search', { exact: true })).toBeFocused()
        await capture('principals-reviewed-refresh-dark-200.png')
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
    }
    expect(await page.evaluate(() => window.dbCommander.history())).toEqual(before)
    await expect.poll(async () => (await page.evaluate(() => window.dbCommander.operationHistory()))
      .filter(entry => entry.kind === 'principal-change').map(entry => entry.status)).toEqual(['completed'])
    const operations = JSON.stringify(await page.evaluate(() => window.dbCommander.operationHistory()))
    expect(operations).not.toContain(reviewed)
    expect(operations).not.toContain('local-test-only')
    await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
    const acl = await fixture.query('SELECT relacl::text AS acl FROM pg_class WHERE oid = $1::regclass', [prefix + '.example'])
    expect(acl.rows[0].acl).not.toContain(member + '=r')
    const membership = await fixture.query("SELECT pg_has_role($1::name, $2::name, 'MEMBER') AS granted", [outsideSearch, member])
    expect(membership.rows[0].granted).toBe(false)
  } finally {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {})
    await app?.close().catch(() => {})
    try { await fixture.query(`DROP SCHEMA IF EXISTS ${prefix} CASCADE; DROP ROLE IF EXISTS ${reader}, ${member}, ${outsideSearch}, ${reviewed};`) }
    finally { await fixture.end(); rmSync(directory, { recursive: true, force: true }) }
  }
})
