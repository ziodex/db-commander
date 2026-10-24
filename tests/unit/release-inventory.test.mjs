import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, access, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { seedInventory } from '../fixtures/release-inventory.mjs'
import { artifactNames, dependencyNotices, vendorNotices, nativeDependencyNotices } from '../../scripts/release/config.cjs'
import { createHash } from 'node:crypto'
import { artifactRecords, readManifest } from '../../scripts/release/common.mjs'
import { inventoryRecords, verifyReleaseInventory, verifyInstalledInventory, writeReleaseInventory } from '../../scripts/release/inventory.mjs'
import { stageRelease } from '../../scripts/stage-release.mjs'
import { inspectRuntime, runtimeLayout, runtimeBinaries } from '../../scripts/release/runtime.mjs'

const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
async function fixture(options) {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-inventory-unit-')); directories.push(directory)
  const manifest = { schema: 1, version: '1.0.0', platform: 'win32', arch: 'x64', commit: 'a'.repeat(40), buildId: '42', mode: 'unsigned', fixture: false }
  for (const name of artifactNames(manifest.version, manifest.platform, manifest.arch)) await writeFile(join(directory, name), 'installer fixture')
  manifest.files = await artifactRecords(directory, manifest.version, manifest.platform, manifest.arch)
  const seeded = await seedInventory(directory, manifest, options)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, manifest, ...seeded }
}
async function readSidecar(directory, manifest, index) { return JSON.parse(await readFile(join(directory, manifest.inventory.files[index].name), 'utf8')) }
async function rewriteSidecar(directory, manifest, index, value) {
  await writeFile(join(directory, manifest.inventory.files[index].name), JSON.stringify(value))
  manifest.inventory.files = await inventoryRecords(directory, manifest)
}
it('inventories packaged dependency instances, nearest nested resolution, native bytes and exact notices', async () => {
  const { directory, manifest, resources, runtime } = await fixture({ native: true, dependencies: { alpha: '1.0.0', shared: '1.0.0' }, packages: {
    'node_modules/alpha': { name: 'alpha', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'MIT' }], dependencies: { shared: '^2.0.0' }, optionalDependencies: { 'other-platform': '1.0.0' } },
    'node_modules/shared': { name: 'shared', version: '1.0.0', license: 'ISC' },
    'node_modules/alpha/node_modules/shared': { name: 'shared', version: '2.0.0', license: '(Apache-2.0 OR MIT)' }
  } })
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  const bom = await readSidecar(directory, manifest, 0), notices = await readSidecar(directory, manifest, 1)
  expect(bom.bomFormat).toBe('CycloneDX'); expect(bom.specVersion).toBe('1.6')
  const alpha = bom.components.find(c => c.name === 'alpha'), nested = bom.components.find(c => c.name === 'shared' && c.version === '2.0.0'), rootShared = bom.components.find(c => c.name === 'shared' && c.version === '1.0.0')
  expect(alpha.licenses).toEqual([{ license: { id: 'MIT' } }])
  expect(bom.dependencies.find(d => d.ref === alpha['bom-ref']).dependsOn).toEqual([nested['bom-ref']])
  expect(bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn).toContain(rootShared['bom-ref'])
  expect(bom.compositions).toEqual([{ aggregate: 'incomplete', assemblies: ['dbcommander', 'electron-runtime', 'native:fixture.node', 'native:native/with spaces % # é/fixture.node'] }])
  expect(notices.notices.find(n => n.path === 'app.asar/node_modules/alpha/LICENSE').text).toBe('\ufeffUpstream license fixture\r\n')
  await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
  expect(JSON.stringify(bom)).not.toContain(directory); expect(JSON.stringify(notices)).not.toContain(directory)
  const before = bom.components.find(c => c['bom-ref'] === 'native:fixture.node').hashes[0].content
  await writeFile(join(resources, 'app.asar.unpacked/fixture.node'), 'changed native payload')
  const other = join(directory, 'regenerated'); await mkdir(other)
  const next = { ...manifest, inventory: await writeReleaseInventory(other, manifest, resources, runtime) }
  const after = await readSidecar(other, next, 0)
  expect(next.inventory.asarSha256).toBe(manifest.inventory.asarSha256)
  expect(after.components.find(c => c['bom-ref'] === 'native:fixture.node').hashes[0].content).not.toBe(before)
  // Signing can change physical binary sizes without rewriting the ASAR index.
  await expect(verifyInstalledInventory(resources, other, next)).resolves.toBeUndefined()
})
it('refuses a missing required packaged dependency and missing Electron/Chromium notices', async () => {
  await expect(fixture({ dependencies: { missing: '1.0.0' } })).rejects.toThrow('Required dependency is absent')
  const { directory, manifest, resources, runtime } = await fixture()
  await rm(join(resources, 'licenses/LICENSES.chromium.html'))
  await expect(writeReleaseInventory(directory, manifest, resources, runtime)).rejects.toThrow('ENOENT')
  for (const file of dependencyNotices) {
    const next = await fixture(); await rm(join(next.resources, file.destination))
    await expect(writeReleaseInventory(next.directory, next.manifest, next.resources, next.runtime)).rejects.toThrow('ENOENT')
  }
})
it('rejects modified, absent, empty and non-regular sidecars before staging', async () => {
  const { directory, manifest } = await fixture(), sidecar = join(directory, manifest.inventory.files[0].name)
  await writeFile(sidecar, '{}'); await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('checksum')
  await writeFile(sidecar, ''); await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('nonempty')
  await rm(sidecar); await mkdir(sidecar); await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('regular')
  await rm(sidecar, { recursive: true }); await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('ENOENT')
  if (process.platform !== 'win32') {
    const target = join(directory, 'target'); await writeFile(target, '{}'); await symlink(target, sidecar)
    await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('regular')
  }
})
it('rejects wrong source identity and unresolved dependency edges even with updated sidecar hashes', async () => {
  const { directory, manifest } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  bom.metadata.component.properties.find(p => p.name === 'dbcommander:commit').value = 'b'.repeat(40)
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('identity')
  bom.metadata.component.properties.find(p => p.name === 'dbcommander:commit').value = manifest.commit
  bom.dependencies[0].dependsOn.push('unlisted-package')
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('dependency reference')
})
it('rejects altered notice text and missing required notices despite updated outer hashes', async () => {
  const { directory, manifest } = await fixture(), notices = await readSidecar(directory, manifest, 1)
  const original = notices.notices[0].text; notices.notices[0].text += 'changed'
  await rewriteSidecar(directory, manifest, 1, notices)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('content/hash')
  notices.notices[0].text = original; notices.notices = notices.notices.filter(n => n.path !== 'resources/licenses/LICENSE.electron.txt')
  await rewriteSidecar(directory, manifest, 1, notices)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Required application/runtime notice')
  const next = await fixture(), readmeNotices = await readSidecar(next.directory, next.manifest, 1)
  readmeNotices.notices = readmeNotices.notices.filter(n => n.path !== `resources/${dependencyNotices[0].destination}`)
  await rewriteSidecar(next.directory, next.manifest, 1, readmeNotices)
  await expect(verifyReleaseInventory(next.directory, next.manifest)).rejects.toThrow('Required application/runtime notice')
})
it('stages only verified sidecars and requires lifecycle reports bound to that inventory', async () => {
  const { directory, manifest } = await fixture(), output = join(directory, 'staged')
  await writeFile(join(directory, 'SHA256SUMS'), 'fixture checksums')
  await writeFile(join(directory, 'builder-debug.yml'), 'private fixture')
  await writeFile(join(directory, 'lifecycle.json'), JSON.stringify({ files: manifest.files }))
  await expect(stageRelease(directory, output)).rejects.toThrow('lifecycle report')
  await expect(access(output)).rejects.toThrow()
  await writeFile(join(directory, 'lifecycle.json'), JSON.stringify({ ...manifest, previousVersion: '0.0.0', tests: [{ format: 'exe', status: 'passed', chromiumSandbox: 'platform-default' }] }))
  await stageRelease(directory, output)
  expect((await readdir(output)).sort()).toEqual(['manifest.json', 'SHA256SUMS', 'lifecycle.json', ...manifest.files.map(f => f.name), ...manifest.inventory.files.map(f => f.name)].sort())
  await expect(readManifest(output)).resolves.toMatchObject({ inventory: manifest.inventory })
})
it('allows inventory-free historical baselines only through an explicit diagnostic option', async () => {
  const { directory, manifest } = await fixture()
  const sidecar = join(directory, manifest.inventory.files[0].name), original = await readFile(sidecar)
  await writeFile(sidecar, '{}')
  await expect(readManifest(directory, { requireInventory: false })).rejects.toThrow('checksum')
  await writeFile(sidecar, original)
  delete manifest.inventory
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(readManifest(directory)).rejects.toThrow('Missing release inventory')
  await expect(readManifest(directory, { requireInventory: false })).resolves.toMatchObject({ version: '1.0.0' })
  await expect(stageRelease(directory, join(directory, 'refused'), { baseline: true })).rejects.toThrow('Missing release inventory')
})
it.each(['failed', 'partial', 'wrong identity', 'wrong artifacts', 'missing sandbox'])('refuses staging a %s lifecycle report even when its inventory matches', async fault => {
  const { directory, manifest } = await fixture(), output = join(directory, 'refused')
  const report = { ...manifest, previousVersion: '0.0.0', tests: [{ format: 'exe', status: 'passed', chromiumSandbox: 'platform-default' }] }
  if (fault === 'failed') report.tests[0].status = 'failed'
  if (fault === 'partial') report.tests = []
  if (fault === 'wrong identity') report.commit = 'b'.repeat(40)
  if (fault === 'wrong artifacts') report.files = []
  if (fault === 'missing sandbox') delete report.tests[0].chromiumSandbox
  await writeFile(join(directory, 'SHA256SUMS'), 'fixture checksums')
  await writeFile(join(directory, 'lifecycle.json'), JSON.stringify(report))
  await expect(stageRelease(directory, output)).rejects.toThrow(/lifecycle|sandbox/i)
  await expect(access(output)).rejects.toThrow()
})
it('checks actual installed ASAR, unpacked native bytes and notices against the sidecars', async () => {
  const { directory, manifest, resources } = await fixture({ native: true })
  await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
  for (const name of ['fixture.node', 'native/with spaces % # é/fixture.node']) {
    const native = join(resources, 'app.asar.unpacked', name)
    await writeFile(native, 'modified installed native payload')
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed native payload')
    await writeFile(native, 'native payload')
  }
  await writeFile(join(resources, 'licenses/LICENSES.chromium.html'), 'modified installed notices')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed notices')
  await writeFile(join(resources, 'app.asar'), 'modified installed ASAR')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed ASAR')
})
it.each(['package.json', 'index.js', 'asset.bin', 'empty.dat'])('rejects changed unpacked %s outside the ASAR hash', async file => {
  const { directory, manifest, resources } = await fixture({ dependencies: { alpha: '1.0.0' }, packages: { 'node_modules/alpha': { name: 'alpha', version: '1.0.0', main: 'index.js' } },
    extraFiles: { 'node_modules/alpha/index.js': 'module.exports = 42', 'node_modules/alpha/asset.bin': 'asset bytes', 'node_modules/alpha/empty.dat': '' }, unpackDir: 'node_modules/alpha' })
  await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
  const destination = join(resources, 'app.asar.unpacked/node_modules/alpha', file), original = await readFile(destination)
  await writeFile(destination, original.length ? Buffer.alloc(original.length, 65) : 'altered external bytes')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed unpacked payload')
})
it.each(['component', 'edge', 'size', 'hash', 'path', 'duplicate size'])('rejects %s corruption of unpacked inventory despite refreshed sidecar hashes', async fault => {
  const { directory, manifest, resources } = await fixture({ native: true, extraFiles: { 'assets/data.bin': 'asset bytes' }, unpackDir: 'assets' })
  const bom = await readSidecar(directory, manifest, 0), component = bom.components.find(c => c['bom-ref'] === 'unpacked:assets/data.bin')
  if (fault === 'component') {
    bom.components = bom.components.filter(c => c !== component)
    bom.dependencies.find(d => d.ref === 'app-asar').dependsOn = bom.dependencies.find(d => d.ref === 'app-asar').dependsOn.filter(ref => ref !== component['bom-ref'])
    await rewriteSidecar(directory, manifest, 0, bom)
    await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('unpacked payload coverage')
    return
  }
  if (fault === 'edge') bom.dependencies.find(d => d.ref === 'app-asar').dependsOn = bom.dependencies.find(d => d.ref === 'app-asar').dependsOn.filter(ref => ref !== component['bom-ref'])
  if (fault === 'size') component.properties[0].value = '9007199254740992'
  if (fault === 'hash') component.hashes[0].content = 'invalid'
  if (fault === 'path') component.name = '../outside.bin'
  if (fault === 'duplicate size') component.properties.push({ ...component.properties[0] })
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow(fault === 'path' ? 'Invalid packaged inventory path' : /unpacked payload|Invalid CycloneDX|ASAR references/)
})
it('rejects omitted external native files even when every corresponding sidecar reference is removed', async () => {
  const { directory, manifest, resources } = await fixture({ native: true }), bom = await readSidecar(directory, manifest, 0)
  const ref = 'native:fixture.node'
  bom.components = bom.components.filter(c => c['bom-ref'] !== ref)
  bom.dependencies = bom.dependencies.filter(d => d.ref !== ref).map(d => ({ ...d, dependsOn: d.dependsOn.filter(value => value !== ref) }))
  bom.compositions[0].assemblies = bom.compositions[0].assemblies.filter(value => value !== ref)
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('unpacked payload coverage')
})
it('rejects a packed file falsely claimed as unpacked', async () => {
  const { directory, manifest, resources } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  bom.components.push({ type: 'file', 'bom-ref': 'unpacked:LICENSE', name: 'LICENSE', hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }], properties: [{ name: 'dbcommander:bytes', value: '1' }] })
  bom.dependencies.find(d => d.ref === 'app-asar').dependsOn.push('unpacked:LICENSE')
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('unpacked payload coverage')
})
it('rejects missing and redirected unpacked assets, and checks the same tree during generation', async () => {
  const { directory, manifest, resources, runtime } = await fixture({ extraFiles: { 'assets/data.bin': 'asset bytes' }, unpackDir: 'assets' })
  const file = join(resources, 'app.asar.unpacked/assets/data.bin'), original = await readFile(file)
  await rm(file)
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('ENOENT')
  await writeFile(file, original)
  const outside = join(directory, 'outside-assets'); await rename(join(resources, 'app.asar.unpacked/assets'), outside)
  await symlink(outside, join(resources, 'app.asar.unpacked/assets'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('regular files and directories')
  await expect(writeReleaseInventory(directory, manifest, resources, runtime)).rejects.toThrow('regular files and directories')
})
it('rejects a redirected unpacked leaf and unindexed files during generation', async () => {
  const { directory, manifest, resources, runtime } = await fixture({ extraFiles: { 'assets/data.bin': 'asset bytes' }, unpackDir: 'assets' })
  const root = join(resources, 'app.asar.unpacked'), extra = join(root, 'extra.js')
  await writeFile(extra, 'unexpected')
  await expect(writeReleaseInventory(directory, manifest, resources, runtime)).rejects.toThrow('Unexpected unpacked payload')
  await rm(extra)
  if (process.platform !== 'win32') {
    const file = join(root, 'assets/data.bin'), outside = join(directory, 'outside.bin')
    await rename(file, outside); await symlink(outside, file)
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('regular files and directories')
  }
})
it('rejects extra unindexed unpacked files instead of silently excluding them from qualification', async () => {
  const { directory, manifest, resources } = await fixture({ native: true })
  await writeFile(join(resources, 'app.asar.unpacked', 'unrecorded.js'), 'module.exports = 42')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Unexpected unpacked payload')
})
it('rejects redirected native parent directories even when their bytes match', async () => {
  const { directory, manifest, resources } = await fixture({ native: true })
  const folder = join(resources, 'app.asar.unpacked/native'), outside = join(directory, 'outside-native')
  await rename(folder, outside); await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow(/regular files and directories/)
})
it.each([false, true])('checks the actual installed Oracle Thin boundary even when every byte is inventoried (Thick=%s)', async thick => {
  const extraFiles = { 'node_modules/oracledb/index.js': 'module.exports = { thin: true }', 'node_modules/oracledb/lib/thin/connection.js': '// Thin implementation fixture' }
  if (thick) extraFiles['node_modules/oracledb/build/Release/oracledb.node'] = 'Inventoried but unsupported Thick addon'
  const { directory, manifest, resources } = await fixture({ dependencies: { oracledb: '26.0.0' }, packages: { 'node_modules/oracledb': { name: 'oracledb', version: '26.0.0' } }, extraFiles })
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  if (thick) await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Oracle Thick-mode payload')
  else await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
})
it('reports embedded versions without inventing libraries from placeholders or ABI/data revisions', async () => {
  const { directory, manifest } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  expect(manifest.inventory.schema).toBe(5)
  for (const [name, version] of [['Node.js', '24.21.0'], ['Chromium', '152.0.7977.130'], ['SQLite', '3.53.4'], ['v8', '15.2.124.28-electron.0']]) expect(bom.components).toContainEqual(expect.objectContaining({ name, version }))
  expect(bom.components.some(c => c.name === 'openssl' || c.name === 'nghttp3')).toBe(false)
  expect(bom.components.find(c => c.name === 'Electron').properties).toContainEqual({ name: 'dbcommander:reported-version:openssl', value: '0.0.0' })
  const missing = structuredClone(bom); missing.components = missing.components.filter(c => c['bom-ref'] !== 'runtime-library:sqlite')
  missing.dependencies.find(d => d.ref === 'electron-runtime').dependsOn = missing.dependencies.find(d => d.ref === 'electron-runtime').dependsOn.filter(ref => ref !== 'runtime-library:sqlite')
  await rewriteSidecar(directory, manifest, 0, missing)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('runtime library inventory mismatch')
  await rewriteSidecar(directory, manifest, 0, bom)
  manifest.inventory.runtime.versions.node = '25.0.0'
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Reported runtime versions')
})
it.each(['sqlite-worker.cjs', 'windows-owner-guard.exe'])('binds physical %s bytes and rejects missing, changed or redirected installed code', async name => {
  const { directory, manifest, resources } = await fixture(), worker = join(resources, 'workers', name)
  const original = await readFile(worker), bom = await readSidecar(directory, manifest, 0)
  expect(bom.components.find(c => c['bom-ref'] === `app-code:workers/${name}`)).toMatchObject({
    type: 'file', name: `workers/${name}`, hashes: [{ alg: 'SHA-256', content: createHash('sha256').update(original).digest('hex') }]
  })
  expect(bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn).toContain(`app-code:workers/${name}`)
  // Same length defeats a size-only check.
  await writeFile(worker, Buffer.alloc(original.length, 65))
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed application resource')
  await rm(worker)
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('ENOENT')
  await writeFile(worker, original)
  if (process.platform !== 'win32') {
    const outside = join(directory, 'outside-worker.cjs'); await writeFile(outside, original)
    await rm(worker); await symlink(outside, worker)
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('regular files and directories')
    await rm(worker); await writeFile(worker, original)
    const outsideDirectory = join(directory, 'outside-workers'); await mkdir(outsideDirectory); await writeFile(join(outsideDirectory, name), original)
    await rm(join(resources, 'workers'), { recursive: true }); await symlink(outsideDirectory, join(resources, 'workers'))
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('regular files and directories')
  }
})
it('rejects omitted, malformed or disconnected worker inventory despite refreshed sidecar checksums', async () => {
  const { directory, manifest } = await fixture(), original = await readSidecar(directory, manifest, 0)
  for (const change of ['absent', 'unsafe', 'hash', 'size', 'edge']) {
    const bom = structuredClone(original), worker = bom.components.find(c => c['bom-ref'] === 'app-code:workers/sqlite-worker.cjs')
    if (change === 'absent') { bom.components = bom.components.filter(c => c !== worker); bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn = bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn.filter(ref => ref !== worker['bom-ref']) }
    if (change === 'unsafe') worker.name = '../private.cjs'
    if (change === 'hash') worker.hashes[0].content = 'invalid'
    if (change === 'size') worker.properties[0].value = '0'
    if (change === 'edge') bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn = bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn.filter(ref => ref !== worker['bom-ref'])
    await rewriteSidecar(directory, manifest, 0, bom)
    await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow(/application resource|Invalid CycloneDX/)
  }
})
it.each([2, 3, 4])('reads historical unsigned schema-%s inventories without granting current release qualification', async schema => {
  const { directory, manifest } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  manifest.inventory.schema = schema
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('schema mismatch')
  bom.metadata.component.properties.find(p => p.name === 'dbcommander:inventory-schema').value = String(schema)
  if (schema === 2) {
    bom.components = bom.components.filter(c => !c['bom-ref'].startsWith('app-code:'))
    bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn = bom.dependencies.find(d => d.ref === 'dbcommander').dependsOn.filter(ref => !ref.startsWith('app-code:'))
  }
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(stageRelease(directory, join(directory, 'legacy-refused'))).rejects.toThrow('current release runtime inventory')
  manifest.mode = 'signed'
  bom.metadata.component.properties.find(p => p.name === 'dbcommander:mode').value = 'signed'
  const notices = await readSidecar(directory, manifest, 1); notices.mode = 'signed'
  await rewriteSidecar(directory, manifest, 0, bom); await rewriteSidecar(directory, manifest, 1, notices)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('current native library inventory')
})
it('probes only the packaged executable with a bounded fixed expression and no inherited launch/signing secrets', async () => {
  const { manifest, resources, runtime } = await fixture()
  runtime.versions.modules = '149'; runtime.versions.napi = '10'; runtime.versions.unicode = '17.0'; runtime.versions.future_key = '1.2.3'
  const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(runtime) })
  const report = await inspectRuntime(resources, manifest, { PATH: 'fixture-path', SystemRoot: 'fixture-windows', NODE_OPTIONS: '--require private.js', AZURE_CLIENT_SECRET: 'private', ELECTRON_RUN_AS_NODE: '0', ELECTRON_ENABLE_LOGGING: '1' }, run)
  expect(report).toEqual(runtime)
  expect(run.mock.calls[0]).toEqual([join(runtimeLayout(resources, manifest.platform).root, 'DbCommander.exe'), ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,versions:process.versions})'], { env: { PATH: 'fixture-path', SystemRoot: 'fixture-windows', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, timeout: 30_000, maxBuffer: 65536, windowsHide: true }])
  const other = join(resources, '..', '..', 'probe-inventory'); await mkdir(other)
  const descriptor = await writeReleaseInventory(other, manifest, resources, report)
  const bom = await readSidecar(other, { ...manifest, inventory: descriptor }, 0)
  for (const key of ['modules', 'napi', 'unicode', 'future_key']) expect(bom.components.some(c => c['bom-ref'] === `runtime-library:${key}`)).toBe(false)
  for (const change of [{ platform: 'linux' }, { arch: 'arm64' }, ...['electron', 'node', 'chrome', 'sqlite'].map(key => ({ versions: { ...runtime.versions, [key]: key === 'electron' ? '1.0.0' : '0.0.0' } }))]) await expect(inspectRuntime(resources, manifest, {}, vi.fn().mockResolvedValue({ stdout: JSON.stringify({ ...runtime, ...change }) }))).rejects.toThrow(/target mismatch|runtime version/)
  await expect(inspectRuntime(resources, manifest, {}, vi.fn().mockResolvedValue({ stdout: 'invalid JSON' }))).rejects.toThrow('Cannot inspect')
  await expect(inspectRuntime(resources, manifest, {}, vi.fn().mockRejectedValue(new Error('timeout')))).rejects.toThrow('Cannot inspect')
})
it('binds runtime executables and external shared libraries to installed bytes on every target layout', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-runtime-unit-')); directories.push(directory)
    const manifest = { schema: 1, version: '1.0.0', platform, arch, commit: 'a'.repeat(40), buildId: '42', mode: 'unsigned', files: [] }
    const { resources } = await seedInventory(directory, manifest), layout = runtimeLayout(resources, platform)
    const binaries = await runtimeBinaries(resources, platform)
    expect(binaries).toHaveLength(2); expect(binaries.some(file => file.name === layout.executable)).toBe(true)
    await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
    const library = binaries.find(file => file.name !== layout.executable), destination = join(layout.root, library.name), original = await readFile(destination)
    await writeFile(destination, Buffer.alloc(original.length, 1))
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed runtime payload')
    await writeFile(destination, original)
    // NSIS creates an uninstaller after extraction; extra files do not stand in
    // for a changed/missing recorded executable or library.
    await writeFile(join(layout.root, 'Uninstall DbCommander.exe'), Buffer.from('MZuninstaller fixture'))
    await expect(verifyInstalledInventory(resources, directory, manifest)).resolves.toBeUndefined()
    await rm(destination)
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('ENOENT')
  }
})
it('skips native symlink aliases when collecting and rejects redirected installed runtime paths', async () => {
  if (process.platform === 'win32') return
  const { directory, manifest, resources } = await fixture(), layout = runtimeLayout(resources, manifest.platform)
  const alias = join(layout.root, 'runtime-alias.dll'); await symlink('ffmpeg.dll', alias)
  expect((await runtimeBinaries(resources, manifest.platform)).some(file => file.name === 'runtime-alias.dll')).toBe(false)
  await rm(alias)
  const bytes = await readFile(join(layout.root, 'ffmpeg.dll'))
  await writeFile(join(directory, 'outside-runtime.dll'), bytes)
  await rm(join(layout.root, 'ffmpeg.dll')); await symlink(join(directory, 'outside-runtime.dll'), join(layout.root, 'ffmpeg.dll'))
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('regular files and directories')
})
it('verifies the relocated AppImage helper against its original inventory without skipping any runtime bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-helper-unit-')); directories.push(directory)
  const manifest = { schema: 1, version: '1.0.0', platform: 'linux', arch: 'x64', commit: 'a'.repeat(40), buildId: '42', mode: 'unsigned', files: [] }
  const { resources, runtime } = await seedInventory(directory, manifest), layout = runtimeLayout(resources, 'linux')
  const source = join(layout.root, 'chrome-sandbox'), helper = join(directory, 'chrome-sandbox'), options = { appImageSandboxHelper: helper }
  const bytes = Buffer.from('7f454c4668656c706572', 'hex')
  await writeFile(source, bytes)
  for (const file of manifest.inventory.files) await rm(join(directory, file.name))
  manifest.inventory = await writeReleaseInventory(directory, manifest, resources, runtime)
  await expect(verifyInstalledInventory(resources, directory, manifest, options)).rejects.toThrow('adjacent copy')
  await rename(source, helper)
  await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('ENOENT')
  await expect(verifyInstalledInventory(resources, directory, manifest, options)).resolves.toBeUndefined()
  await writeFile(helper, Buffer.alloc(bytes.length, 1))
  await expect(verifyInstalledInventory(resources, directory, manifest, options)).rejects.toThrow('Installed runtime payload')
  await writeFile(helper, bytes)
  const executable = join(layout.root, layout.executable), original = await readFile(executable)
  await writeFile(executable, Buffer.alloc(original.length, 1))
  await expect(verifyInstalledInventory(resources, directory, manifest, options)).rejects.toThrow('Installed runtime payload')
  await writeFile(executable, original)
  await rm(helper)
  await expect(verifyInstalledInventory(resources, directory, manifest, options)).rejects.toThrow('ENOENT')
  if (process.platform !== 'win32') {
    await writeFile(source, bytes); await symlink(source, helper); await rm(source)
    await expect(verifyInstalledInventory(resources, directory, manifest, options)).rejects.toThrow('regular files and directories')
  }
})
it('keeps legacy unsigned inventory readable without allowing schema downgrade or signed qualification', async () => {
  const { directory, manifest } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  manifest.inventory.schema = 1
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Legacy inventory')
  bom.metadata.component.properties = bom.metadata.component.properties.filter(p => p.name !== 'dbcommander:inventory-schema')
  bom.components = bom.components.filter(c => !c['bom-ref'].startsWith('runtime-library:') && !c['bom-ref'].startsWith('runtime-file:'))
  bom.dependencies = bom.dependencies.filter(d => d.ref !== 'electron-runtime')
  await rewriteSidecar(directory, manifest, 0, bom); delete manifest.inventory.runtime
  await expect(verifyReleaseInventory(directory, manifest)).resolves.toEqual(manifest.inventory.files)
  manifest.mode = 'signed'
  bom.metadata.component.properties.find(p => p.name === 'dbcommander:mode').value = 'signed'
  const notices = await readSidecar(directory, manifest, 1); notices.mode = 'signed'
  await rewriteSidecar(directory, manifest, 0, bom); await rewriteSidecar(directory, manifest, 1, notices)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Legacy inventory cannot qualify a signed release')
})
it('rejects a missing main executable and unsafe native paths despite refreshed outer checksums', async () => {
  const { directory, manifest } = await fixture(), bom = await readSidecar(directory, manifest, 0)
  const original = structuredClone(bom), main = bom.components.find(c => c['bom-ref'] === 'runtime-file:DbCommander.exe')
  bom.components = bom.components.filter(c => c !== main)
  bom.dependencies.find(d => d.ref === 'electron-runtime').dependsOn = bom.dependencies.find(d => d.ref === 'electron-runtime').dependsOn.filter(ref => ref !== main['bom-ref'])
  await rewriteSidecar(directory, manifest, 0, bom)
  await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Missing packaged executable')
  for (const name of ['../private', 'C:/private', '/private', 'foo/../../private']) {
    const changed = structuredClone(original), component = changed.components.find(c => c['bom-ref'] === 'runtime-file:DbCommander.exe')
    component.name = name; component['bom-ref'] = `runtime-file:${name}`
    changed.dependencies.find(d => d.ref === 'electron-runtime').dependsOn = changed.dependencies.find(d => d.ref === 'electron-runtime').dependsOn.filter(ref => ref !== 'runtime-file:DbCommander.exe')
    changed.dependencies.find(d => d.ref === 'electron-runtime').dependsOn.push(component['bom-ref'])
    await rewriteSidecar(directory, manifest, 0, changed)
    await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow(/Invalid packaged inventory path|Invalid native runtime inventory/)
  }
})
it('requires both pinned Mac framework notices even after an outer sidecar checksum is refreshed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-framework-inventory-')); directories.push(directory)
  const manifest = { schema: 1, version: '1.0.0', platform: 'darwin', arch: 'arm64', commit: 'a'.repeat(40), buildId: '42', mode: 'unsigned', files: [] }
  const { resources, runtime } = await seedInventory(directory, manifest)
  const notices = await readSidecar(directory, manifest, 1)
  for (const file of vendorNotices) {
    expect(notices.notices.find(n => n.path === `resources/${file.destination}`)?.sha256).toBe(file.sha256)
    const changed = structuredClone(notices); changed.notices = changed.notices.filter(n => n.path !== `resources/${file.destination}`)
    await rewriteSidecar(directory, manifest, 1, changed)
    await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Required pinned framework notice')
  }
  const next = join(directory, 'regenerated'); await mkdir(next)
  await rm(join(resources, vendorNotices[0].destination))
  await expect(writeReleaseInventory(next, manifest, resources, runtime)).rejects.toThrow('ENOENT')
})
it('includes all target native notices and rejects removal, replacement or installed corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-native-notice-inventory-')); directories.push(directory)
  const manifest = { schema: 1, version: '1.0.0', platform: 'darwin', arch: 'arm64', commit: 'a'.repeat(40), buildId: '42', mode: 'unsigned', files: [] }
  const { resources, runtime } = await seedInventory(directory, manifest)
  const notices = await readSidecar(directory, manifest, 1)
  for (const file of nativeDependencyNotices.filter(file => file.platform === manifest.platform && file.arch === manifest.arch)) {
    const path = `resources/${file.destination}`, installed = join(resources, file.destination), original = await readFile(installed)
    expect(notices.notices.find(n => n.path === path)?.sha256).toBe(file.sha256)
    for (const removed of [true, false]) {
      const changed = structuredClone(notices)
      if (removed) changed.notices = changed.notices.filter(n => n.path !== path)
      else {
        const notice = changed.notices.find(n => n.path === path); notice.text = 'replacement license'
        notice.sha256 = createHash('sha256').update(notice.text).digest('hex')
      }
      await rewriteSidecar(directory, manifest, 1, changed)
      await expect(verifyReleaseInventory(directory, manifest)).rejects.toThrow('Required pinned native dependency notice')
    }
    await rewriteSidecar(directory, manifest, 1, notices)
    await writeFile(installed, 'altered installed notice')
    await expect(verifyInstalledInventory(resources, directory, manifest)).rejects.toThrow('Installed notices')
    await rm(installed)
    const next = join(directory, `regenerated-${file.source}`); await mkdir(next)
    await expect(writeReleaseInventory(next, manifest, resources, runtime)).rejects.toThrow('ENOENT')
    await writeFile(installed, original)
  }
})
