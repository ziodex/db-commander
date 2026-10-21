import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import defaultAfterPack, { createAfterPack, requiredNativeFiles, verifyNativeFiles, verifyRuntimeNotices, verifyDependencyNotices, verifyVendorNotices, verifyApplicationResources } from '../../scripts/release/verify-native.cjs'
import { applicationResources, applicationResourcesFor, builderConfig, runtimeNotices, dependencyNotices, dependencyNoticeSources, vendorNoticeSources } from '../../scripts/release/config.cjs'
import { seedOracleThinPackage } from '../fixtures/oracle-thin.mjs'
import { verifyOracleThinPackage } from '../../scripts/release/oracle-thin.cjs'

const directories = []
// These fixtures isolate binary-presence/framework/dependency notice audits.
// Native vendor source guards have their own fixtures and the real package run.
const afterPack = createAfterPack(async () => {})
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
async function fixture(platform = 'win32', arch = 'x64') {
  const resources = await mkdtemp(join(tmpdir(), 'dbcommander-native-audit-')); directories.push(resources)
  const files = requiredNativeFiles(platform, arch).map(file => join(resources, 'app.asar.unpacked', file))
  for (const file of files) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'native fixture') }
  for (const file of applicationResourcesFor(platform)) for (const name of [file.source, file.destination]) {
    const destination = join(resources, name); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, 'Standalone worker fixture')
  }
  const electronDist = join(resources, 'node_modules/electron/dist')
  await mkdir(electronDist, { recursive: true }); await writeFile(join(electronDist, 'version'), '44.7.0')
  for (const file of runtimeNotices) {
    await mkdir(dirname(join(resources, file.destination)), { recursive: true })
    await writeFile(join(electronDist, file.source), `Upstream ${file.source}`)
    await writeFile(join(resources, file.destination), `Upstream ${file.source}`)
  }
  for (const name of ['pg', 'sql-formatter', 'nearley']) {
    const folder = join(resources, 'node_modules', name); await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name, main: 'index.js' })); await writeFile(join(folder, 'index.js'), '')
  }
  for (const file of dependencyNotices) {
    const folder = join(resources, 'node_modules', file.package); await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: file.package, version: file.version }))
    await writeFile(join(folder, file.source), `Dependency notice ${file.package}\n`)
    await writeFile(join(resources, file.destination), `Dependency notice ${file.package}\n`)
  }
  await seedOracleThinPackage(resources)
  return { resources, files, electronDist }
}
it('requires the native addon, DuckDB shared library and credential backend for all release targets', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']]) {
    const { resources } = await fixture(platform, arch)
    await expect(verifyNativeFiles(resources, platform, arch)).resolves.toBeUndefined()
  }
})
it.each(['node_modules/oracledb/build/Release/oracledb.node', 'node_modules/parent/node_modules/oracledb/build/Release/other.node', 'node_modules/oracledb/other/native.dll'])('refuses unexpected Oracle Thick payload %s in the actual builder hook', async file => {
  const { resources } = await fixture()
  await seedOracleThinPackage(resources, { files: { [file]: 'Thick fixture' } })
  const context = { appOutDir: 'application', packager: { projectDir: resources, info: { framework: { version: '44.7.0' } }, getResourcesDir: () => resources }, electronPlatformName: 'win32', arch: 1 }
  await expect(afterPack(context)).rejects.toThrow('Oracle Thick-mode payload')
})
it('rejects orphaned physical Oracle addons even when the ASAR index is clean', async () => {
  const { resources } = await fixture(), file = join(resources, 'app.asar.unpacked/node_modules/oracledb/build/Release/orphan.node')
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'orphaned addon')
  await expect(verifyOracleThinPackage(resources)).rejects.toThrow('physical payload remains')
})
it.each(['index.js', 'lib/thin/connection.js', 'package.json'])('keeps the required Oracle Thin entry %s', async file => {
  const { resources } = await fixture()
  // Remove the previous source first so rebuilding cannot retain the entry.
  await rm(join(resources, 'oracle-thin-fixture'), { recursive: true })
  await seedOracleThinPackage(resources, { files: { [`node_modules/oracledb/${file}`]: null } })
  await expect(verifyOracleThinPackage(resources)).rejects.toThrow('missing a required entry')
})
it('requires renewed Thin-package review after a pinned version mismatch', async () => {
  const { resources } = await fixture()
  await seedOracleThinPackage(resources, { version: '99.0.0' })
  await expect(verifyOracleThinPackage(resources)).rejects.toThrow('pinned version')
})
it('blocks the missing Windows DuckDB addon that failed installed startup', async () => {
  const { resources, files } = await fixture(); await rm(files[0])
  await expect(verifyNativeFiles(resources, 'win32', 'x64')).rejects.toThrow('node-bindings-win32-x64/duckdb.node')
})
it('blocks packages missing the shared library or native credential store', async () => {
  for (const index of [1, 2]) {
    const { resources, files } = await fixture(); await rm(files[index])
    await expect(verifyNativeFiles(resources, 'win32', 'x64')).rejects.toThrow('native binary')
  }
})
it('rejects empty binaries and directories in place of native files', async () => {
  const { resources, files } = await fixture(); await writeFile(files[0], '')
  await expect(verifyNativeFiles(resources, 'win32', 'x64')).rejects.toThrow('nonempty')
  await rm(files[0]); await mkdir(files[0])
  await expect(verifyNativeFiles(resources, 'win32', 'x64')).rejects.toThrow('regular')
})
it('audits the builder target and rejects unsupported targets before artifacts are emitted', async () => {
  const { resources, files } = await fixture()
  const context = { appOutDir: 'application', packager: { projectDir: resources, info: { framework: { version: '44.7.0' } }, getResourcesDir: () => resources }, electronPlatformName: 'win32', arch: 1 }
  await expect(afterPack(context)).resolves.toBeUndefined()
  await rm(files[0]); await expect(afterPack(context)).rejects.toThrow('native binary')
  expect(() => requiredNativeFiles('win32', 'arm64')).toThrow('Unsupported')
})
it('keeps the native vendor source audit enabled in the actual builder hook', async () => {
  const { resources } = await fixture()
  const context = { appOutDir: 'application', packager: { projectDir: resources, info: { framework: { version: '44.7.0' } }, getResourcesDir: () => resources }, electronPlatformName: 'win32', arch: 1 }
  await expect(defaultAfterPack(context)).rejects.toThrow('keyring')
})
it('audits the physical worker bytes before installer emission', async () => {
  const { resources } = await fixture(), file = applicationResources[0], destination = join(resources, file.destination)
  expect(builderConfig({}).extraResources).toContainEqual({ from: file.source, to: file.destination })
  await expect(verifyApplicationResources(resources, resources)).resolves.toBeUndefined()
  await writeFile(destination, 'changed worker')
  await expect(verifyApplicationResources(resources, resources)).rejects.toThrow('application resource differs')
  await writeFile(destination, '')
  await expect(verifyApplicationResources(resources, resources)).rejects.toThrow('nonempty')
  await rm(destination)
  await expect(verifyApplicationResources(resources, resources)).rejects.toThrow('missing')
})
it('copies exact Electron and Chromium notices and rejects missing, stale or modified notice payloads', async () => {
  const { resources, electronDist } = await fixture()
  for (const file of runtimeNotices) expect(builderConfig({}).extraResources).toContainEqual({ from: `node_modules/electron/dist/${file.source}`, to: file.destination })
  await expect(verifyRuntimeNotices(resources, electronDist, '44.7.0')).resolves.toBeUndefined()
  await expect(verifyRuntimeNotices(resources, electronDist, '43.0.0')).rejects.toThrow('version')
  for (const file of runtimeNotices) {
    const destination = join(resources, file.destination)
    await writeFile(destination, 'changed'); await expect(verifyRuntimeNotices(resources, electronDist, '44.7.0')).rejects.toThrow('differs')
    await writeFile(destination, ''); await expect(verifyRuntimeNotices(resources, electronDist, '44.7.0')).rejects.toThrow('nonempty')
    await rm(destination); await mkdir(destination); await expect(verifyRuntimeNotices(resources, electronDist, '44.7.0')).rejects.toThrow('regular')
    await rm(destination, { recursive: true }); await expect(verifyRuntimeNotices(resources, electronDist, '44.7.0')).rejects.toThrow('missing')
    await writeFile(destination, `Upstream ${file.source}`)
  }
})
it('retains version-matched dependency README licenses that builder otherwise drops', async () => {
  const { resources } = await fixture()
  for (const file of dependencyNoticeSources()) expect(builderConfig({}).extraResources).toContainEqual({ from: file.sourcePath, to: file.destination })
  await expect(verifyDependencyNotices(resources, resources)).resolves.toBeUndefined()
  for (const file of dependencyNotices) {
    const destination = join(resources, file.destination), original = `Dependency notice ${file.package}\n`
    await writeFile(destination, 'altered'); await expect(verifyDependencyNotices(resources, resources)).rejects.toThrow('differs')
    await rm(destination); await expect(verifyDependencyNotices(resources, resources)).rejects.toThrow('missing')
    await writeFile(destination, original)
  }
  const file = dependencyNotices[0]
  await writeFile(join(resources, 'node_modules', file.package, 'package.json'), JSON.stringify({ name: file.package, version: '9.0.0' }))
  await expect(verifyDependencyNotices(resources, resources)).rejects.toThrow('Review the dependency notice source')
})
it('retains exact pinned Mac framework licenses and requires review after an Electron upgrade', async () => {
  const { resources } = await fixture('darwin', 'x64')
  for (const file of vendorNoticeSources('44.7.0', 'darwin')) {
    expect(builderConfig({}).mac.extraResources).toContainEqual({ from: file.sourcePath, to: file.destination })
    const source = join(resources, 'build/vendor-notices', file.source)
    await mkdir(dirname(source), { recursive: true }); await copyFile(file.sourcePath, source)
    await copyFile(file.sourcePath, join(resources, file.destination))
  }
  await expect(verifyVendorNotices(resources, '44.7.0', 'darwin', resources)).resolves.toBeUndefined()
  await expect(verifyVendorNotices(resources, '45.0.0', 'darwin', resources)).rejects.toThrow('Review native framework notice sources')
  await expect(verifyVendorNotices(resources, '45.0.0', 'win32', resources)).resolves.toBeUndefined()
  for (const file of vendorNoticeSources('44.7.0', 'darwin')) {
    const path = join(resources, file.destination), original = await readFile(path)
    await writeFile(path, 'changed'); await expect(verifyVendorNotices(resources, '44.7.0', 'darwin', resources)).rejects.toThrow('differs')
    await rm(path); await expect(verifyVendorNotices(resources, '44.7.0', 'darwin', resources)).rejects.toThrow('missing')
    await writeFile(path, original)
    const source = join(resources, 'build/vendor-notices', file.source)
    await writeFile(source, 'changed'); await expect(verifyVendorNotices(resources, '44.7.0', 'darwin', resources)).rejects.toThrow('pinned upstream bytes')
    await writeFile(source, original)
  }
  const context = { appOutDir: 'application', packager: { projectDir: resources, info: { framework: { version: '44.7.0' } }, getResourcesDir: () => resources }, electronPlatformName: 'darwin', arch: 1 }
  await expect(afterPack(context)).resolves.toBeUndefined()
})

it('requires the Windows process owner helper in the physical application resource inventory', async () => {
  const { resources } = await fixture('win32')
  await verifyApplicationResources(resources, resources, 'win32')
  await rm(join(resources, 'workers/windows-owner-guard.exe'))
  await expect(verifyApplicationResources(resources, resources, 'win32')).rejects.toThrow('windows-owner-guard.exe')
  expect(applicationResourcesFor('darwin').some(file => file.destination.endsWith('.exe'))).toBe(false)
})
