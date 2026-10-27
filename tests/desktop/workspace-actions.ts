import type { Page } from '@playwright/test'

export async function queryTool(page: Page, name: 'Query library' | 'Explain selected SQL' | 'Data import and export' | 'Visual query builder') {
  await page.getByRole('button', { name: 'Query tools', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

export async function databaseAction(page: Page, name: 'Schema changes' | 'ER diagram') {
  await page.locator('.database-node.current > button').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name, exact: true }).click()
}
