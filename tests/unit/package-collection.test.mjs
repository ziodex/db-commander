import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'))
const { PnpmNodeModulesCollector } = builderRequire('app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js')
const { LogMessageByKey } = builderRequire('app-builder-lib/out/node-module-collector/moduleManager.js')
const directories = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function collect({ nativeName, installed = false, optional = true }) {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-package-collection-'))
  directories.push(root)
  const parent = '@fixture/binding', version = '1.0.0'
  const nativePath = join(root, 'node_modules', nativeName)
  const parentPath = join(root, 'node_modules', parent)
  async function metadata(path, value) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify(value))
  }
  await metadata(root, { name: 'fixture', version, dependencies: { [parent]: version } })
  await metadata(parentPath, { name: parent, version, [optional ? 'optionalDependencies' : 'dependencies']: { [nativeName]: version } })
  if (installed) await metadata(nativePath, { name: nativeName, version })
  const tree = { name: 'fixture', version, path: root, dependencies: {
    [parent]: { name: parent, version, path: parentPath, dependencies: {
      [nativeName]: { name: nativeName, version, path: nativePath }
    } }
  } }
  const collector = new PnpmNodeModulesCollector(root, {})
  // Supply pnpm's locked tree without spawning a package manager for the fixture.
  collector.getDependenciesTree = async () => tree
  collector._pnpmMajorVersion = 12
  collector._allWorkspacePackages = [tree]
  collector.isHoisted = { value: Promise.resolve(false) }
  return collector.getNodeModules({ packageName: 'fixture' })
}

it('collects the installed native binary for the current platform', async () => {
  const nativeName = `@fixture/binding-${process.platform}-${process.arch}`
  const result = await collect({ nativeName, installed: true })
  expect(result.nodeModules.map(pkg => pkg.name)).toContain(nativeName)
  expect(result.logSummary[LogMessageByKey.PKG_OPTIONAL_PLATFORM_NOT_INSTALLED]).toEqual([])
})

it('omits locked optional binaries for other operating systems without warnings', async () => {
  const platform = process.platform === 'win32' ? 'darwin' : 'win32'
  const result = await collect({ nativeName: `@fixture/binding-${platform}-${process.arch}` })
  expect(result.nodeModules.map(pkg => pkg.name)).toEqual(['@fixture/binding'])
  expect(result.logSummary[LogMessageByKey.PKG_OPTIONAL_PLATFORM_NOT_INSTALLED]).toEqual([])
})

it('omits optional binaries for other processors without warnings', async () => {
  const arch = process.arch === 'x64' ? 'arm64' : 'x64'
  const result = await collect({ nativeName: `@fixture/binding-${process.platform}-${arch}` })
  expect(result.logSummary[LogMessageByKey.PKG_OPTIONAL_PLATFORM_NOT_INSTALLED]).toEqual([])
})

it('still warns when the current platform binary is missing', async () => {
  const nativeName = `@fixture/binding-${process.platform}-${process.arch}`
  const result = await collect({ nativeName })
  expect(result.logSummary[LogMessageByKey.PKG_OPTIONAL_PLATFORM_NOT_INSTALLED]).toEqual([`${nativeName}@1.0.0`])
})

it.each([true, false])('keeps missing unrecognized dependencies visible (optional: %s)', async optional => {
  const result = await collect({ nativeName: '@fixture/unknown', optional })
  expect(result.logSummary[LogMessageByKey.PKG_NOT_ON_DISK]).toContain('@fixture/unknown@1.0.0')
})

it.each([['2.36', 'musl'], [undefined, 'gnu']])('omits the other Linux C library variant (glibc: %s)', async (glibcVersionRuntime, suffix) => {
  vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64', report: { getReport: () => ({ header: { glibcVersionRuntime } }) } })
  const result = await collect({ nativeName: `@fixture/binding-linux-x64-${suffix}` })
  expect(result.logSummary[LogMessageByKey.PKG_OPTIONAL_PLATFORM_NOT_INSTALLED]).toEqual([])
})
