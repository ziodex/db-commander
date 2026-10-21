import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('application icon: runtime image and packaged Finder identity use the Db Commander brand', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-icon-')), env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  const ownedProcess = app.process()
  try {
    const page = await app.firstWindow(); await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await expect(page.locator('.brand')).toContainText('Db Commander')
    await expect(page.locator('.brand-mark svg')).toBeVisible()
    await page.screenshot({ path: info.outputPath('db-commander.png') })
    const report = await app.evaluate(({ app, nativeImage }) => {
      const path = process.getBuiltinModule('node:path')
      const file = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(app.getAppPath(), 'build/icons/1024x1024.png')
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) throw new Error('The Db Commander runtime icon is empty.')
      return { name: app.getName(), packaged: app.isPackaged, size: image.getSize(), resources: process.resourcesPath, bundlePath: path.join(process.resourcesPath, '../..') }
    })
    await app.close()
    let bundleIcon: string | undefined, brandedFraction: number | undefined
    if (report.packaged && process.platform === 'darwin') {
      bundleIcon = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIconFile', join(report.resources, '../Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim()
      expect(readFileSync(join(report.resources, bundleIcon)).subarray(0, 4).toString()).toBe('icns')
      const file = info.outputPath('finder-icon.png')
      const finder = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', resolve('tests/desktop/read-icon.jxa'), report.bundlePath, file], { timeout: 15_000, encoding: 'utf8' }))
      brandedFraction = finder.brandedFraction
    }
    expect(report.name).toBe('Db Commander')
    expect(report.size).toEqual({ width: 1024, height: 1024 })
    if (report.packaged && process.platform === 'darwin') { expect(bundleIcon).not.toContain('electron'); expect(brandedFraction).toBeGreaterThan(0.2) }
    writeFileSync(info.outputPath('icon.json'), JSON.stringify({ ...report, bundleIcon, brandedFraction }, null, 2))
  } finally { if (ownedProcess.exitCode === null) ownedProcess.kill('SIGKILL'); await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }) }
})
