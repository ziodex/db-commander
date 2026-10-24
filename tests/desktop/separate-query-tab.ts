import { expect, type Page } from '@playwright/test'

/** Tests requiring concurrent physical sessions opt in by reconnecting a new tab.
 * Call while the source is idle, before starting transactions or staging edits. */
export async function openSeparateQueryTab(page: Page, password?: string) {
  // The connection form closes before schema discovery and connection cleanup.
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  const tabs = page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab')
  const count = await tabs.count()
  await page.getByRole('button', { name: 'New query tab', exact: true }).click()
  await expect(tabs).toHaveCount(count + 1)
  const tab = tabs.last()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const id = (await tab.getAttribute('id'))!.slice('tab-'.length)
  await expect(page.locator(`#query-view-${id} .monaco-editor`)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog')
  if (password) await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
