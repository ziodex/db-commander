import type { Page } from '@playwright/test'

export async function openConnectionSettings(page: Page) {
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('dialog', { name: 'Commands', exact: true }).getByRole('button', { name: 'Connect to a database', exact: true }).click()
}

export async function profileAction(page: Page, name: string, action: 'Edit' | 'Delete') {
  await page.getByRole('button', { name: `Open ${name} in new tab`, exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: `${action} connection`, exact: true }).click()
}
