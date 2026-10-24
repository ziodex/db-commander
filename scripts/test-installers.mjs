import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, access, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import semver from 'semver'
import { randomUUID } from 'node:crypto'
import { readManifest, nativeTarget, root, isMain, run } from './release/common.mjs'
import { assertNoInstallation, installArtifact, uninstallArtifact, assertWindowsInstallerRefusesRunningApp, appImageSandboxPath } from './release/install.mjs'
import { openInstalled, seedInstalled, verifyInstalled, noPlaintextPassword, removeCredential, closeInstalled } from '../tests/installers/workspace.mjs'
import { verifyInstalledInventory } from './release/inventory.mjs'
import { assertDesktopReady } from './desktop-readiness.mjs'

export async function testInstallers({ baseline, candidate, format, report } = {}) {
  const target = await nativeTarget()
  // Previously published/diagnostic baselines may predate the inventory format.
  // The new candidate always requires inventory; this exception cannot promote it.
  const previous = await readManifest(baseline, { requireInventory: false }), current = await readManifest(candidate)
  for (const manifest of [previous, current]) assert.deepEqual({ platform: manifest.platform, arch: manifest.arch }, target)
  assert.equal(semver.gt(current.version, previous.version), true, 'An upgrade must replace an older application version.')
  if (current.fixture) throw new Error('The candidate cannot be an upgrade fixture.')
  const destination = report || join(candidate, 'lifecycle.json')
  // A failed rerun must not leave an older passing report that can be staged
  // or promoted for the same installer hashes. Retain failures in JUnit/logs.
  await rm(destination, { force: true })
  assertDesktopReady()
  const formats = format ? [format] : target.platform === 'darwin' ? ['dmg', 'zip'] : target.platform === 'win32' ? ['exe'] : ['deb', 'AppImage']
  const results = []
  for (const extension of formats) {
    const oldFile = previous.files.find(file => file.name.endsWith(`.${extension}`)), newFile = current.files.find(file => file.name.endsWith(`.${extension}`))
    if (!oldFile || !newFile) throw new Error(`Missing ${extension} installer pair.`)
    await assertNoInstallation(extension)
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-install-')), installation = join(directory, 'Application with spaces'), started = Date.now()
    const inventoryOptions = extension === 'AppImage' ? { appImageSandboxHelper: appImageSandboxPath(installation) } : undefined
    // System installers are tested against the real default data location on
    // disposable workers, so a bad uninstaller cannot pass by deleting a
    // different profile directory than the one under test.
    const userData = extension === 'exe' ? join(process.env.APPDATA, 'Db Commander')
      : ['deb', 'rpm'].includes(extension) ? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'Db Commander')
      : join(directory, 'workspace')
    await mkdir(dirname(userData), { recursive: true })
    await mkdir(userData)
    let app, executable, expected, installed = false, passed = false
    try {
      for (const [folder, file] of [[baseline, oldFile], [candidate, newFile]]) if (extension === 'AppImage') await chmod(join(folder, file.name), 0o755)
      executable = await installArtifact(join(baseline, oldFile.name), extension, installation); installed = true
      let opened = await openInstalled(executable, userData, previous.version, target.arch); app = opened.app
      expected = { profileId: randomUUID() }
      expected = await seedInstalled(opened, userData, expected.profileId)
      if (extension === 'exe') await assertWindowsInstallerRefusesRunningApp(join(candidate, newFile.name), installation, app)
      await closeInstalled(app); app = undefined
      await noPlaintextPassword(userData)
      const beforeUpgrade = await readFile(join(userData, 'workspace.sqlite'))
      executable = await installArtifact(join(candidate, newFile.name), extension, installation)
      assert.deepEqual(await readFile(join(userData, 'workspace.sqlite')), beforeUpgrade, 'Installing an upgrade must not change application data.')
      opened = await openInstalled(executable, userData, current.version, target.arch); app = opened.app
      await verifyInstalledInventory(await app.evaluate(() => process.resourcesPath), candidate, current, inventoryOptions)
      expected = await verifyInstalled(opened, userData, expected)
      await closeInstalled(app); app = undefined
      if (extension === 'exe') await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/installers/windows-uninstall-lock.ps1'), '-Installation', installation], { timeout: 60_000 })
      else await uninstallArtifact(extension, installation)
      installed = false
      await access(join(userData, 'workspace.sqlite')); await noPlaintextPassword(userData)
      // Reinstall after removal proves that retained profiles, SQL, native
      // database files and the OS credential remain usable, not merely present.
      executable = await installArtifact(join(candidate, newFile.name), extension, installation); installed = true
      opened = await openInstalled(executable, userData, current.version, target.arch); app = opened.app
      await verifyInstalledInventory(await app.evaluate(() => process.resourcesPath), candidate, current, inventoryOptions)
      await verifyInstalled(opened, userData, expected)
      await removeCredential(app, expected.profileId)
      await closeInstalled(app); app = undefined
      await uninstallArtifact(extension, installation); installed = false
      passed = true
    } finally {
      if (app) {
        if (expected) await removeCredential(app, expected.profileId).catch(() => {})
        await app.evaluate(({ app }) => app.exit(1)).catch(() => {}); await app.close().catch(() => {})
      }
      if (installed) await uninstallArtifact(extension, installation).catch(() => {})
      // Failed fixtures remain available for diagnosis; never touch user data
      // outside the directories created exclusively by this test.
      if (passed) { await rm(userData, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }) }
      else console.error(`Installer test failed; fixture retained at ${directory}`)
    }
    results.push({ format: extension, status: 'passed', durationMs: Date.now() - started, chromiumSandbox: target.platform !== 'linux' ? 'platform-default' : process.env.SQLCOMMANDER_INSTALL_TEST_NO_SANDBOX === '1' ? 'disabled-disposable-container' : 'enforced' })
    console.log(`${extension}: install, version upgrade, uninstall, reinstall, workspace, credentials and native SQLite/DuckDB passed.`)
  }
  const result = { schema: 1, ...target, version: current.version, commit: current.commit, buildId: current.buildId, mode: current.mode, files: current.files, inventory: current.inventory, previousVersion: previous.version, syntheticBaseline: previous.fixture === true, tests: results }
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n')
  return result
}

if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { baseline: { type: 'string', default: 'release/baseline' }, candidate: { type: 'string', default: 'release/candidate' }, format: { type: 'string' }, report: { type: 'string' } } })
  const reportDirectory = join(root, '.test-artifacts/ci-results/installers'); await mkdir(reportDirectory, { recursive: true })
  const name = values.format || `${process.platform}-${process.arch}`
  try {
    const result = await testInstallers({ ...values, baseline: resolve(values.baseline), candidate: resolve(values.candidate) })
    await writeFile(join(reportDirectory, `${name}.xml`), `<testsuite name="Installers ${name}" tests="${result.tests.length}" failures="0">${result.tests.map(test => `<testcase name="${test.format} install upgrade uninstall reinstall" time="${test.durationMs / 1000}"/>`).join('')}</testsuite>\n`)
  } catch (error) {
    await writeFile(join(reportDirectory, `${name}.xml`), `<testsuite name="Installers" tests="1" failures="1"><testcase name="lifecycle"><failure>Installer validation failed; inspect the job log.</failure></testcase></testsuite>\n`)
    throw error
  }
}
