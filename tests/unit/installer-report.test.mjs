import { afterEach, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { artifactNames } from '../../scripts/release/config.cjs'
import { artifactRecords } from '../../scripts/release/common.mjs'
import { seedInventory } from '../fixtures/release-inventory.mjs'
import { testInstallers } from '../../scripts/test-installers.mjs'

const fault = vi.hoisted(() => ({ report: '', sawPreviousPass: undefined, directory: undefined, desktopError: undefined }))
vi.mock('../../scripts/desktop-readiness.mjs', () => ({ assertDesktopReady: () => { if (fault.desktopError) throw new Error(fault.desktopError) } }))
vi.mock('../../scripts/release/common.mjs', async original => ({ ...await original(), nativeTarget: async () => ({ platform: 'darwin', arch: 'arm64' }) }))
vi.mock('../../scripts/release/install.mjs', async original => ({
  ...await original(), assertNoInstallation: async () => {},
  installArtifact: async (_file, _format, installation) => {
    fault.directory = dirname(installation)
    fault.sawPreviousPass = await access(fault.report).then(() => true, () => false)
    throw new Error('Synthetic installation failure before any application launch')
  }
}))
const directories = []
afterEach(async () => {
  if (fault.directory) directories.push(fault.directory)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  fault.directory = undefined
  fault.desktopError = undefined; fault.sawPreviousPass = undefined
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-installer-report-')); directories.push(directory)
  const baseline = join(directory, 'baseline'), candidate = join(directory, 'candidate')
  for (const [folder, version] of [[baseline, '0.0.0'], [candidate, '1.0.0']]) {
    await mkdir(folder)
    const manifest = { schema: 1, version, platform: 'darwin', arch: 'arm64', commit: 'a'.repeat(40), buildId: 'fixture', mode: 'unsigned', fixture: version === '0.0.0' }
    for (const name of artifactNames(version, manifest.platform, manifest.arch)) await writeFile(join(folder, name), 'Installer fixture; never executed')
    manifest.files = await artifactRecords(folder, version, manifest.platform, manifest.arch)
    if (!manifest.fixture) await seedInventory(folder, manifest)
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest))
  }
  fault.report = join(candidate, 'lifecycle.json')
  await writeFile(fault.report, JSON.stringify({ tests: [{ format: 'dmg', status: 'passed' }, { format: 'zip', status: 'passed' }] }))
  return { baseline, candidate }
}
it('invalidates a previous passing lifecycle report before a new attempt can fail', async () => {
  const { baseline, candidate } = await fixture()
  await expect(testInstallers({ baseline, candidate, format: 'dmg' })).rejects.toThrow('Synthetic installation failure')
  expect(fault.sawPreviousPass).toBe(false)
  await expect(access(fault.report)).rejects.toThrow()
})
it('invalidates a stale pass and refuses installation when the desktop is locked', async () => {
  const { baseline, candidate } = await fixture(); fault.desktopError = 'The macOS desktop is locked.'
  await expect(testInstallers({ baseline, candidate, format: 'dmg' })).rejects.toThrow('desktop is locked')
  expect(fault.sawPreviousPass).toBeUndefined()
  await expect(access(fault.report)).rejects.toThrow()
})
