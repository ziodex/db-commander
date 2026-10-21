import type { Page } from '@playwright/test'

export async function profileAction(page: Page, name: string, action: 'Edit' | 'Delete') {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: `${action} profile ${name}`, exact: true }).click()
}
