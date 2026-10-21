import { mkdir, rm, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root, run } from './common.mjs'

export function requireDisposableHost(format, env = process.env) {
  if (['exe', 'deb', 'rpm'].includes(format) && !(env.CI === 'true' && env.SQLCOMMANDER_DISPOSABLE_INSTALL_TEST === '1')) throw new Error('System installer tests require CI=true and SQLCOMMANDER_DISPOSABLE_INSTALL_TEST=1 on a disposable worker.')
}
export async function assertNoInstallation(format) {
  requireDisposableHost(format)
  if (format === 'exe') {
    await run('pwsh', ['-NoProfile', '-File', join(root, 'scripts/release/assert-clean-windows.ps1')])
  } else if (format === 'deb' || format === 'rpm') {
    if (await access('/opt/Db Commander').then(() => true, () => false)) throw new Error('An existing Db Commander installation must not be touched.')
    const found = await run(format === 'deb' ? 'dpkg-query' : 'rpm', format === 'deb' ? ['-W', '-f=${Status}', 'dbcommander'] : ['-q', 'dbcommander'], { capture: true }).then(() => true, () => false)
    if (found) throw new Error('Db Commander is already registered with the system package manager.')
  }
}

export async function installArtifact(file, format, directory) {
  requireDisposableHost(format)
  if (format === 'dmg' || format === 'zip') {
    await mkdir(directory, { recursive: true })
    const destination = join(directory, 'DbCommander.app')
    if (format === 'dmg') {
      const mount = join(directory, 'mounted')
      await mkdir(mount, { recursive: true })
      await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file])
      try {
        await access(join(mount, 'DbCommander.app'))
        await rm(destination, { recursive: true, force: true })
        await run('ditto', [join(mount, 'DbCommander.app'), destination])
      } finally { await run('hdiutil', ['detach', mount]); await rm(mount, { recursive: true, force: true }) }
    } else {
      await rm(destination, { recursive: true, force: true })
      await run('ditto', ['-x', '-k', file, directory])
    }
    return join(destination, 'Contents', 'MacOS', 'DbCommander')
  }
  if (format === 'exe') {
    // NSIS treats /D= and everything after it as the path, without quotes.
    await run(file, ['/S', '/currentuser', `/D=${directory}`], { windowsVerbatimArguments: true })
    const executable = join(directory, 'DbCommander.exe'); await access(executable); return executable
  }
  if (format === 'deb') await run('sudo', ['-n', 'dpkg', '--install', file])
  else if (format === 'rpm') await run('sudo', ['-n', 'rpm', '--upgrade', file])
  else if (format === 'AppImage') {
    await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true })
    await run(file, ['--appimage-extract'], { cwd: directory, capture: true })
    return join(directory, 'squashfs-root', 'AppRun')
  } else throw new Error(`Unsupported installer format: ${format}`)
  await access('/opt/Db Commander/dbcommander')
  return '/opt/Db Commander/dbcommander'
}

export async function uninstallArtifact(format, directory) {
  requireDisposableHost(format)
  if (format === 'exe') {
    const names = await readdir(directory)
    const uninstall = names.find(name => /^Uninstall.*\.exe$/i.test(name))
    if (!uninstall) throw new Error('The installed NSIS uninstaller is missing.')
    await run(join(directory, uninstall), ['/S', '/currentuser', `_?=${directory}`], { windowsVerbatimArguments: true })
    if (await access(join(directory, 'DbCommander.exe')).then(() => true, () => false)) throw new Error('NSIS did not remove the application.')
  } else if (format === 'deb' || format === 'rpm') {
    await run('sudo', ['-n', ...(format === 'deb' ? ['dpkg', '--purge', 'dbcommander'] : ['rpm', '--erase', 'dbcommander'])])
    if (await access('/opt/Db Commander/dbcommander').then(() => true, () => false)) throw new Error('The package manager did not remove the application.')
  } else {
    // DMG/ZIP and AppImage are copied/portable applications, with no package
    // uninstaller. Remove only the owned application, never the user data.
    await rm(directory, { recursive: true, force: true })
  }
}

export async function assertWindowsInstallerRefusesRunningApp(installer, directory, app) {
  requireDisposableHost('exe')
  const uninstall = (await readdir(directory)).find(name => /^Uninstall.*\.exe$/i.test(name))
  if (!uninstall) throw new Error('The installed NSIS uninstaller is missing.')
  for (const [command, args] of [[installer, ['/S', '/currentuser', `/D=${directory}`]], [join(directory, uninstall), ['/S', '/currentuser', `_?=${directory}`]]]) {
    let code
    try { await run(command, args, { windowsVerbatimArguments: true, timeout: 60_000 }) } catch (error) { code = error.exitCode }
    if (code !== 2) throw new Error('An installer must refuse a running Db Commander with exit code 2.')
    if (!await app.evaluate(({ app }) => app.isReady())) throw new Error('The installer stopped the active application.')
    await access(join(directory, 'DbCommander.exe'))
  }
}
