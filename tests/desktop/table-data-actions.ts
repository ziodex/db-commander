import type { Page } from '@playwright/test'

/** Browse controls live in the compact toolbar; edit-mode actions stay visible. */
export async function tableDataAction(page: Page, name: string) {
  const direct = page.getByRole('button', { name, exact: true })
  if (await direct.count()) return direct.click()
  await page.getByRole('button', { name: 'Table actions', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
