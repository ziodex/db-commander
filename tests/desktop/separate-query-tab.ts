import { expect, type Page } from '@playwright/test'

/** Tests requiring concurrent physical sessions opt in by reconnecting a new tab.
 * Call while the source is idle, before starting transactions or staging edits. */
export async function openSeparateQueryTab(page: Page, password?: string) {
  await page.getByRole('button', { name: 'New query tab', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const form = page.getByRole('dialog')
  if (password) await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
}
