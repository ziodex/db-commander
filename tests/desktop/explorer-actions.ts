import { expect, type Page } from '@playwright/test'
export function tableNode(page: Page, name: string) {
  return page.locator('.schema-object > button').filter({has:page.getByText(name,{exact:true})})
}
export async function appendTableSelect(page: Page, name: string) {
  // Clear this fixture's sample/setup SQL before appending. The application
  // deliberately preserves authored SQL, so replaying setup DDL would fail.
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await tableNode(page, name).click()
  await page.getByRole('menuitem', { name: `Append SELECT SQL for ${name}`, exact: true }).click()
}
export async function tableAction(page: Page, name: string, action: 'Object details'|'Browse data'|'Edit data'|'Alter table') {
  // A table label contains its exact name in a span; avoid prefix matches for views/indexes.
  const button=page.locator('.schema-object > button').filter({has:page.getByText(name,{exact:true})})
  await button.click({button:'right'})
  await page.getByRole('menuitem',{name:`${action} ${name}`,exact:true}).click()
  if(action==='Object details') await expect(page.getByRole('dialog',{name:'Object details',exact:true}).getByRole('button',{name:'Close object details',exact:true})).toBeEnabled({timeout:60000})
}
export async function openBackup(page: Page) {
  const current=page.locator('.database-node.current > button').first()
  if(await current.count()) {await current.click({button:'right'});await page.getByRole('menuitem',{name:'Database backup and restore',exact:true}).click()}
  else {await page.getByRole('button',{name:'Commands',exact:true}).click();await page.getByRole('button',{name:'Database backup and restore',exact:true}).click()}
  await expect(page.getByRole('dialog',{name:'Database backup and restore',exact:true})).toBeVisible()
}
