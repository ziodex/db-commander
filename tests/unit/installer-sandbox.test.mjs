import { expect, it } from 'vitest'
import { join } from 'node:path'
import { installedLaunchOptions } from '../installers/workspace.mjs'
import { appImageSandboxPath } from '../../scripts/release/install.mjs'

it('explicitly enables installer sandbox qualification rather than relying on Playwright defaults', () => {
  const options = installedLaunchOptions('/fixture/app', '/fixture/profile', { ELECTRON_RUN_AS_NODE: '1' })
  expect(options.chromiumSandbox).toBe(true); expect(options.args).toEqual([])
  expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(options.env.SQLCOMMANDER_USER_DATA).toBe('/fixture/profile')
})
it('permits the documented exception only in explicitly disposable CI', () => {
  expect(() => installedLaunchOptions('app', 'profile', { SQLCOMMANDER_INSTALL_TEST_NO_SANDBOX: '1' })).toThrow('disposable CI')
  const options = installedLaunchOptions('app', 'profile', { CI: 'true', SQLCOMMANDER_DISPOSABLE_INSTALL_TEST: '1', SQLCOMMANDER_INSTALL_TEST_NO_SANDBOX: '1' })
  expect(options.chromiumSandbox).toBe(false); expect(options.args).toEqual(['--no-sandbox'])
})
it('keeps a spaced AppImage installation sandboxed with its owned helper outside the spaced path', () => {
  const installation = join('/fixture', 'Application with spaces')
  const executable = join(installation, 'squashfs-root', 'AppRun')
  const options = installedLaunchOptions(executable, '/fixture/profile', { CHROME_DEVEL_SANDBOX: '/unrelated/helper' })
  expect(options.executablePath).toBe(executable)
  expect(options.env.CHROME_DEVEL_SANDBOX).toBe(appImageSandboxPath(installation))
  expect(options.env.CHROME_DEVEL_SANDBOX).toBe(join('/fixture', 'chrome-sandbox'))
  expect(options.chromiumSandbox).toBe(true); expect(options.args).toEqual([])
  expect(() => appImageSandboxPath(join('/fixture with spaces', 'Application'))).toThrow('no whitespace')
})
