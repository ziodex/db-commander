import { expect, type Page } from '@playwright/test'

/** Native workspace initialization can outlast ordinary UI assertions on hosted
 * Windows runners. Keep this allowance at startup, not on later UI actions. */
export async function waitForWorkspaceReady(page: Page) {
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 30000 })
}
