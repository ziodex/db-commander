import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, lstat, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, normalize, posix } from 'node:path'
import { artifactNames, platforms, safeArtifact, applicationResourcesFor, runtimeNotices, dependencyNotices, vendorNotices, nativeDependencyNotices } from './config.cjs'
import semver from 'semver'
import { runtimeLayout, validateRuntimeReport, runtimeLibraries, runtimeBinaries } from './runtime.mjs'
import { nativeLibraryInventory, verifyNativeLibraryInventory } from './native-libraries.mjs'
import { verifyOracleThinPackage } from './oracle-thin.cjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = libRequire('@electron/asar')
const maxSidecarBytes = 64 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const property = (name, value) => ({ name: `dbcommander:${name}`, value: String(value) })
const noticeName = /^(?:(?:third[-_]party[-_])?(?:licen[sc]es?|notices?)|copying|copyright)(?:[._-].*)?$/i
let schemaValidator, licenseIds

export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function schemas() {
  if (!schemaValidator) {
    const [bom, spdx, jsf] = await Promise.all(['bom-1.6.schema.json', 'spdx.schema.json', 'jsf-0.82.schema.json'].map(async name => JSON.parse(await readFile(new URL(`schemas/${name}`, import.meta.url), 'utf8'))))
    const Ajv = libRequire('ajv'), ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
    ajv.addSchema(spdx); ajv.addSchema(jsf); schemaValidator = ajv.compile(bom)
    licenseIds = new Set(spdx.enum)
  }
  return schemaValidator
}
function archivePath(path) {
  const value = path.replaceAll('\\', '/').replace(/^\//, '')
  if (!value || value.split('/').some(part => !part || part === '..' || part === '.') || /[:\x00-\x1f]/.test(value)) throw new Error('Invalid packaged inventory path.')
  return value
}
async function regularBytes(path, limit = maxSidecarBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error('Expected a regular, nonempty bounded inventory file.')
  return readFile(path)
}
async function physicalPath(resources, name) {
  if (archivePath(name) !== name) throw new Error('Invalid application resource path.')
  let path = resources
  const parts = name.split('/')
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    const info = await lstat(path)
    if (index < parts.length - 1 ? !info.isDirectory() || info.isSymbolicLink() : !info.isFile() || info.isSymbolicLink()) throw new Error('Application resource must have regular files and directories.')
  }
  return path
}
async function physicalResource(resources, name) {
  const bytes = await regularBytes(await physicalPath(resources, name))
  return { bytes: bytes.length, sha256: digest(bytes) }
}
const nativeName = /\.(?:node|dll|dylib|so)(?:\.\d+)*$/i
function archiveEntries(path) {
  return asar.listPackage(path).map(archivePath).sort().map(name => ({ name, info: asar.statFile(path, normalize(name), false) }))
}
async function verifyUnpackedTree(resources, entries) {
  const files = new Set(), directories = new Set([''])
  for (const { name, info } of entries) {
    if (!info.unpacked) continue
    if (info.link) throw new Error('Unpacked payload must have regular files and directories.')
    if (!info.files) files.add(name)
    let parent = info.files ? name : posix.dirname(name)
    while (parent !== '.') { directories.add(parent); parent = posix.dirname(parent) }
  }
  const root = join(resources, 'app.asar.unpacked')
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unpacked payload must have regular files and directories.')
  } catch (error) { if (error.code === 'ENOENT' && files.size === 0 && directories.size === 1) return; throw error }
  async function walk(parent) {
    for (const name of await readdir(join(root, parent))) {
      const relative = parent ? `${parent}/${name}` : name, info = await lstat(join(root, relative))
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Unpacked payload must have regular files and directories.')
      if (info.isDirectory()) {
        if (!directories.has(relative)) throw new Error('Unexpected unpacked payload directory.')
        await walk(relative)
      } else if (!files.has(relative)) throw new Error('Unexpected unpacked payload file.')
    }
  }
  await walk('')
}
function identity(manifest) {
  const value = Object.fromEntries(['version', 'platform', 'arch', 'commit', 'buildId', 'mode'].map(key => [key, manifest[key]]))
  if (Object.values(value).some(item => typeof item !== 'string' || !item || item.length > 256 || /[\x00-\x1f]/.test(item)) || !/^[a-f0-9]{40}$/.test(value.commit) || !['signed', 'unsigned'].includes(value.mode) || !semver.valid(manifest.tools?.electron)) throw new Error('Invalid release inventory identity.')
  inventoryNames(value.version, value.platform, value.arch)
  return value
}
function declaredLicense(metadata) {
  const primary = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type
  // ssh2 still declares its MIT license through npm's legacy licenses array.
  const values = primary ? [primary] : Array.isArray(metadata.licenses) ? metadata.licenses.map(value => typeof value === 'string' ? value : value?.type) : []
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]
    .map(value => ({ license: licenseIds.has(value) ? { id: value } : { name: value } }))
}
function npmPurl(name, version) { return `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}` }
export function inventoryNames(version, platform, arch) {
  artifactNames(version, platform, arch)
  const stem = `DbCommander-${version}-${platforms[platform].name}-${arch}`
  return [`${stem}-sbom.cdx.json`, `${stem}-notices.json`]
}
export async function inventoryRecords(directory, manifest) {
  return Promise.all(inventoryNames(manifest.version, manifest.platform, manifest.arch).map(async name => {
    const bytes = await regularBytes(safeArtifact(directory, name))
    return { name, bytes: bytes.length, sha256: digest(bytes) }
  }))
}

export async function writeReleaseInventory(directory, manifest, resources, runtime) {
  identity(manifest)
  validateRuntimeReport(runtime, manifest)
  await schemas()
  const path = join(resources, 'app.asar'), asarSha256 = await hashFile(path)
  const entries = archiveEntries(path), files = entries.map(entry => entry.name)
  await verifyUnpackedTree(resources, entries)
  const packagePaths = files.filter(file => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(file))
  const readArchive = file => {
    // Sidecars use portable '/' paths. ASAR's reader splits directories with
    // the current host's path.sep, so convert only at that API boundary.
    const entry = normalize(file), info = asar.statFile(path, entry)
    if (!info || info.size > maxSidecarBytes) throw new Error('Packaged inventory input is too large.')
    return asar.extractFile(path, entry)
  }
  const metadata = JSON.parse(readArchive('package.json').toString('utf8'))
  // electron-builder removes devDependencies from the production manifest.
  // The pinned runtime identity comes from the build manifest and the afterPack
  // audit, which checks its version and exact upstream notice bytes.
  if (metadata.version !== manifest.version || metadata.devDependencies?.electron && metadata.devDependencies.electron !== manifest.tools.electron) throw new Error('Inventory application/runtime identity does not match the release manifest.')
  const packages = packagePaths.map(file => {
    const bytes = readArchive(file), data = JSON.parse(bytes.toString('utf8'))
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(data.name || '') || !semver.valid(data.version)) throw new Error('Packaged dependency is missing its name/version.')
    const purl = npmPurl(data.name, data.version), location = posix.dirname(file)
    return { data, location, ref: `${purl}#${encodeURIComponent(location)}`, component: { type: 'library', name: data.name, version: data.version, purl, licenses: declaredLicense(data), properties: [property('package-path', location), property('package-json-sha256', digest(bytes))] } }
  })
  const byLocation = new Map(packages.map(pkg => [pkg.location, pkg]))
  const components = packages.map(pkg => ({ ...pkg.component, 'bom-ref': pkg.ref }))
  const dependencies = []
  for (const pkg of [{ data: metadata, location: '.', ref: 'dbcommander' }, ...packages]) {
    const resolved = new Set(pkg.ref === 'dbcommander' ? ['electron-runtime', 'app-asar', ...applicationResourcesFor(manifest.platform).map(file => `app-code:${file.destination}`)] : [])
    const optional = pkg.data.optionalDependencies || {}
    for (const name of new Set([...Object.keys(pkg.data.dependencies || {}), ...Object.keys(optional), ...Object.keys(pkg.data.peerDependencies || {})])) {
      let parent = pkg.location, found
      for (;;) {
        found = byLocation.get(posix.join(parent, 'node_modules', name))
        if (found || parent === '.') break
        parent = posix.dirname(parent)
      }
      if (found) resolved.add(found.ref)
      else if (name in (pkg.data.dependencies || {}) && !(name in optional)) throw new Error(`Required dependency is absent from the packaged inventory: ${pkg.data.name} → ${name}`)
    }
    dependencies.push({ ref: pkg.ref, dependsOn: [...resolved].sort() })
  }
  components.push({ type: 'framework', 'bom-ref': 'electron-runtime', name: 'Electron', version: manifest.tools.electron, licenses: [{ license: { id: 'MIT' } }], description: 'Embedded versions are reported by the packaged executable. Empty/zero placeholders are not component versions. Upstream notices are retained; internal native/vendor composition remains incomplete.', properties: Object.entries(runtime.versions).map(([key, value]) => property(`reported-version:${key}`, value)) })
  const libraries = runtimeLibraries(runtime)
  for (const library of libraries) components.push({ type: 'library', 'bom-ref': `runtime-library:${library.key}`, name: library.name, version: library.version, properties: [property('version-source', 'packaged process.versions'), property('notice-path', 'resources/licenses/LICENSES.chromium.html')] })
  const binaries = await runtimeBinaries(resources, manifest.platform)
  for (const file of binaries) components.push({ type: 'file', 'bom-ref': `runtime-file:${file.name}`, name: file.name, hashes: [{ alg: 'SHA-256', content: file.sha256 }], properties: [property('bytes', file.bytes)] })
  dependencies.push({ ref: 'electron-runtime', dependsOn: [...libraries.map(library => `runtime-library:${library.key}`), ...binaries.map(file => `runtime-file:${file.name}`)].sort() })
  components.push({ type: 'file', 'bom-ref': 'app-asar', name: 'app.asar', hashes: [{ alg: 'SHA-256', content: asarSha256 }] })
  for (const file of applicationResourcesFor(manifest.platform)) {
    const record = await physicalResource(resources, file.destination)
    components.push({ type: 'file', 'bom-ref': `app-code:${file.destination}`, name: file.destination, hashes: [{ alg: 'SHA-256', content: record.sha256 }], properties: [property('bytes', record.bytes)] })
  }
  // The ASAR digest excludes every unpacked file, including package metadata,
  // JavaScript and empty assets. Signed native sizes can differ from the index.
  for (const { name: file, info } of entries.filter(({ name, info }) => !info.files && (info.unpacked || nativeName.test(name)))) {
    const unpacked = info.unpacked ? await physicalPath(resources, `app.asar.unpacked/${file}`) : undefined
    const hash = unpacked ? await hashFile(unpacked) : digest(readArchive(file))
    const bytes = unpacked ? (await lstat(unpacked)).size : info.size
    components.push({ type: 'file', 'bom-ref': `${nativeName.test(file) ? 'native' : 'unpacked'}:${file}`, name: file, hashes: [{ alg: 'SHA-256', content: hash }], properties: [property('bytes', bytes)] })
  }
  const native = components.filter(component => component['bom-ref'].startsWith('native:'))
  const identified = nativeLibraryInventory(manifest, components, native)
  components.push(...identified.components); dependencies.push(...identified.dependencies)
  dependencies.push({ ref: 'app-asar', dependsOn: components.filter(component => /^(?:native|unpacked):/.test(component['bom-ref'])).map(component => component['bom-ref']).sort() })
  for (const owner of identified.ownership) {
    const edge = dependencies.find(edge => edge.ref === owner.ref)
    edge.dependsOn = [...new Set([...edge.dependsOn, ...owner.dependsOn])].sort()
  }
  for (const file of manifest.files) components.push({ type: 'file', 'bom-ref': `installer:${file.name}`, name: file.name, hashes: [{ alg: 'SHA-256', content: file.sha256 }], properties: [property('installer', true)] })
  const notices = []
  for (const file of files.filter(file => noticeName.test(posix.basename(file)))) {
    if (asar.statFile(path, normalize(file)).files) continue
    const bytes = readArchive(file)
    if (bytes.length) notices.push({ path: `app.asar/${file}`, sha256: digest(bytes), text: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes) })
  }
  for (const file of [...runtimeNotices, ...dependencyNotices, ...vendorNotices.filter(file => file.platform === manifest.platform), ...nativeDependencyNotices.filter(file => file.platform === manifest.platform && file.arch === manifest.arch)]) {
    const bytes = await regularBytes(join(resources, file.destination))
    notices.push({ path: `resources/${file.destination}`, sha256: digest(bytes), text: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes) })
  }
  const properties = [...Object.entries(identity(manifest)).map(([name, value]) => property(name, value)), property('asar-sha256', asarSha256), property('inventory-schema', 5)]
  const bom = { $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json', bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: 'application', 'bom-ref': 'dbcommander', name: 'Db Commander', version: manifest.version, licenses: declaredLicense(metadata), properties } },
    components, dependencies, compositions: [{ aggregate: 'incomplete', assemblies: ['dbcommander', 'electron-runtime', ...native.map(c => c['bom-ref']), ...identified.components.map(c => c['bom-ref'])] }] }
  const noticeBundle = { schema: 1, ...identity(manifest), asarSha256, electronVersion: manifest.tools.electron, notices }
  validateInventory(bom, noticeBundle, manifest, asarSha256, 5, runtime)
  const names = inventoryNames(manifest.version, manifest.platform, manifest.arch)
  for (const [index, value] of [bom, noticeBundle].entries()) {
    const json = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(json) > maxSidecarBytes) throw new Error('Release inventory exceeds its size limit.')
    await writeFile(safeArtifact(directory, names[index]), json, { flag: 'wx' })
  }
  return { schema: 5, asarSha256, runtime, files: await inventoryRecords(directory, manifest) }
}

function validateInventory(bom, notices, manifest, asarSha256, format = manifest.inventory?.schema, reported = manifest.inventory?.runtime) {
  if (!schemaValidator(bom)) throw new Error(`Invalid CycloneDX inventory: ${schemaValidator.errors?.[0]?.instancePath} ${schemaValidator.errors?.[0]?.message}`)
  if (bom.specVersion !== '1.6' || bom.metadata?.component?.name !== 'Db Commander' || bom.metadata.component['bom-ref'] !== 'dbcommander' || bom.metadata.component.version !== manifest.version || !Array.isArray(bom.components) || !Array.isArray(bom.dependencies) || !/^[a-f0-9]{64}$/.test(asarSha256 || '')) throw new Error('Inventory application identity mismatch.')
  const properties = bom.metadata.component.properties || []
  for (const [key, value] of [...Object.entries(identity(manifest)), ['asar-sha256', asarSha256]]) {
    const found = properties.filter(p => p.name === `dbcommander:${key}`)
    if (found.length !== 1 || found[0].value !== String(value) || notices[key === 'asar-sha256' ? 'asarSha256' : key] !== value) throw new Error('Release inventory identity mismatch.')
  }
  const refs = [bom.metadata.component['bom-ref'], ...bom.components.map(c => c['bom-ref'])]
  if (refs.some(ref => !ref) || new Set(refs).size !== refs.length) throw new Error('Duplicate or absent inventory component reference.')
  for (const dependency of bom.dependencies || []) if (!refs.includes(dependency.ref) || dependency.dependsOn?.some(ref => !refs.includes(ref))) throw new Error('Unresolved inventory dependency reference.')
  const runtime = bom.components.find(c => c['bom-ref'] === 'electron-runtime')
  if (runtime?.version !== manifest.tools?.electron || notices.electronVersion !== manifest.tools?.electron) throw new Error('Inventory Electron version mismatch.')
  const schemaProperties = properties.filter(p => p.name === 'dbcommander:inventory-schema')
  if ([2, 3, 4, 5].includes(format)) {
    validateRuntimeReport(reported, manifest)
    if (schemaProperties.length !== 1 || schemaProperties[0].value !== String(format)) throw new Error('Runtime inventory schema mismatch.')
    const actualVersions = runtime.properties?.filter(p => p.name.startsWith('dbcommander:reported-version:')) || []
    if (actualVersions.length !== Object.keys(reported.versions).length || Object.entries(reported.versions).some(([key, value]) => actualVersions.filter(p => p.name === `dbcommander:reported-version:${key}` && p.value === value).length !== 1)) throw new Error('Reported runtime versions do not match the inventory.')
    const libraries = runtimeLibraries(reported), actualLibraries = bom.components.filter(c => c['bom-ref'].startsWith('runtime-library:'))
    if (libraries.length !== actualLibraries.length || libraries.some(library => !actualLibraries.some(c => c['bom-ref'] === `runtime-library:${library.key}` && c.type === 'library' && c.name === library.name && c.version === library.version))) throw new Error('Embedded runtime library inventory mismatch.')
    const binaries = bom.components.filter(c => c['bom-ref'].startsWith('runtime-file:'))
    for (const file of binaries) {
      const size = file.properties?.filter(p => p.name === 'dbcommander:bytes') || []
      if (file.type !== 'file' || archivePath(file.name) !== file.name || file['bom-ref'] !== `runtime-file:${file.name}` || file.hashes?.length !== 1 || file.hashes[0].alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(file.hashes[0].content) || size.length !== 1 || !/^[1-9]\d*$/.test(size[0].value) || !Number.isSafeInteger(Number(size[0].value))) throw new Error('Invalid native runtime inventory reference/hash.')
    }
    if (!binaries.some(c => c.name === runtimeLayout('', manifest.platform).executable)) throw new Error('Missing packaged executable inventory.')
    const edges = bom.dependencies.filter(d => d.ref === 'electron-runtime')
    const expected = [...libraries.map(library => `runtime-library:${library.key}`), ...binaries.map(file => file['bom-ref'])].sort()
    if (edges.length !== 1 || JSON.stringify(edges[0].dependsOn) !== JSON.stringify(expected)) throw new Error('Incomplete runtime inventory dependency references.')
  } else if (schemaProperties.length || manifest.mode === 'signed') throw new Error('Legacy inventory cannot qualify a signed release or claim current runtime coverage.')
  if (format !== 5 && manifest.mode === 'signed') throw new Error('Signed releases require the current native library inventory and complete unpacked payload coverage.')
  if ([3, 4, 5].includes(format) || bom.components.some(c => c['bom-ref'].startsWith('app-code:'))) {
    const resources = bom.components.filter(c => c['bom-ref'].startsWith('app-code:'))
    if (resources.length !== applicationResourcesFor(manifest.platform).length) throw new Error('Incomplete application resource inventory.')
    for (const file of applicationResourcesFor(manifest.platform)) {
      const component = resources.find(c => c['bom-ref'] === `app-code:${file.destination}`)
      const size = component?.properties?.filter(p => p.name === 'dbcommander:bytes') || []
      if (component?.type !== 'file' || component.name !== file.destination || component.hashes?.length !== 1 || component.hashes[0].alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(component.hashes[0].content) || size.length !== 1 || !/^[1-9]\d*$/.test(size[0].value) || !Number.isSafeInteger(Number(size[0].value))) throw new Error('Invalid application resource inventory reference/hash.')
      const edges = bom.dependencies.filter(d => d.ref === 'dbcommander')
      if (edges.length !== 1 || !edges[0].dependsOn?.includes(component['bom-ref'])) throw new Error('Incomplete application resource dependency references.')
    }
  }
  if (bom.components.find(c => c['bom-ref'] === 'app-asar')?.hashes?.[0]?.content !== asarSha256) throw new Error('Inventory ASAR hash mismatch.')
  for (const file of manifest.files) {
    const component = bom.components.find(c => c['bom-ref'] === `installer:${file.name}`)
    if (component?.name !== file.name || component.hashes?.[0]?.alg !== 'SHA-256' || component.hashes[0].content !== file.sha256) throw new Error('Inventory installer hash mismatch.')
  }
  for (const component of bom.components.filter(c => c['bom-ref'].startsWith('native:'))) {
    if (component.type !== 'file' || archivePath(component.name) !== component.name || component['bom-ref'] !== `native:${component.name}` || component.hashes?.length !== 1 || component.hashes[0].alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(component.hashes[0].content)) throw new Error('Invalid native inventory reference/hash.')
  }
  const unpacked = bom.components.filter(c => c['bom-ref'].startsWith('unpacked:'))
  if (unpacked.length && format !== 5) throw new Error('Unpacked payload coverage requires the current inventory schema.')
  for (const component of [...unpacked, ...(format === 5 ? bom.components.filter(c => c['bom-ref'].startsWith('native:')) : [])]) {
    const size = component.properties?.filter(p => p.name === 'dbcommander:bytes') || []
    const prefix = nativeName.test(component.name) ? 'native' : 'unpacked'
    if (component.type !== 'file' || archivePath(component.name) !== component.name || component['bom-ref'] !== `${prefix}:${component.name}` || component.hashes?.length !== 1 || component.hashes[0].alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(component.hashes[0].content) || size.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(size[0].value) || !Number.isSafeInteger(Number(size[0].value))) throw new Error('Invalid unpacked payload inventory reference/hash/size.')
  }
  if (notices.schema !== 1 || !Array.isArray(notices.notices) || new Set(notices.notices.map(n => n.path)).size !== notices.notices.length) throw new Error('Invalid notice inventory.')
  for (const notice of notices.notices) if (typeof notice.path !== 'string' || !(notice.path.startsWith('app.asar/') || notice.path.startsWith('resources/licenses/')) || archivePath(notice.path) !== notice.path || typeof notice.text !== 'string' || !notice.text || digest(Buffer.from(notice.text)) !== notice.sha256) throw new Error('Notice inventory content/hash mismatch.')
  for (const path of ['app.asar/LICENSE', 'app.asar/THIRD_PARTY_NOTICES.md', ...[...runtimeNotices, ...dependencyNotices].map(file => `resources/${file.destination}`)]) if (!notices.notices.some(n => n.path === path)) throw new Error('Required application/runtime notice is absent from the inventory.')
  if ([2, 3, 4, 5].includes(format)) for (const file of vendorNotices.filter(file => file.platform === manifest.platform)) {
    const notice = notices.notices.find(n => n.path === `resources/${file.destination}`)
    if (manifest.tools.electron !== file.electronVersion || notice?.sha256 !== file.sha256) throw new Error('Required pinned framework notice is absent or changed in the inventory.')
  }
  if ([2, 3, 4, 5].includes(format)) for (const file of nativeDependencyNotices.filter(file => file.platform === manifest.platform && file.arch === manifest.arch)) {
    if (notices.notices.find(n => n.path === `resources/${file.destination}`)?.sha256 !== file.sha256) throw new Error('Required pinned native dependency notice is absent or changed in the inventory.')
  }
  if (!bom.compositions?.some(c => c.aggregate === 'incomplete' && c.assemblies?.includes('electron-runtime'))) throw new Error('The inventory must disclose incomplete native/runtime composition.')
  if ([4, 5].includes(format) || bom.components.some(c => c['bom-ref'].startsWith('native-library:'))) verifyNativeLibraryInventory(bom, manifest)
}
export async function verifyReleaseInventory(directory, manifest) {
  if (![1, 2, 3, 4, 5].includes(manifest.inventory?.schema)) throw new Error('Missing release inventory.')
  const actual = await inventoryRecords(directory, manifest)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory.files)) throw new Error('Release inventory checksum or size mismatch.')
  await schemas()
  const [bom, notices] = await Promise.all(actual.map(async file => JSON.parse((await regularBytes(safeArtifact(directory, file.name))).toString('utf8'))))
  validateInventory(bom, notices, manifest, manifest.inventory.asarSha256)
  return actual
}

// Called for each actually installed candidate (including AppImage/RPM), using
// Electron's resourcesPath rather than guessing a platform's extraction layout.
export async function verifyInstalledInventory(resources, directory, manifest, { appImageSandboxHelper } = {}) {
  await verifyReleaseInventory(directory, manifest)
  const [bom, notices] = await Promise.all(manifest.inventory.files.map(async file => JSON.parse((await regularBytes(safeArtifact(directory, file.name))).toString('utf8'))))
  const path = join(resources, 'app.asar')
  if (await hashFile(path) !== manifest.inventory.asarSha256) throw new Error('Installed ASAR does not match the release inventory.')
  if (manifest.inventory.schema === 5) {
    const entries = archiveEntries(path)
    await verifyUnpackedTree(resources, entries)
    const expected = entries.filter(({ info }) => info.unpacked && !info.files).map(({ name }) => `${nativeName.test(name) ? 'native' : 'unpacked'}:${name}`).sort()
    const actual = bom.components.filter(c => c['bom-ref'].startsWith('unpacked:') || c['bom-ref'].startsWith('native:') && asar.statFile(path, normalize(c.name), false).unpacked).map(c => c['bom-ref']).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Installed unpacked payload coverage is incomplete or changed.')
  }
  // A fully hashed/inventoried Thick addon is still outside the supported
  // release. Inspect the actual archive, independently of sidecar claims.
  if (asar.listPackage(path).map(archivePath).includes('node_modules/oracledb/package.json')) await verifyOracleThinPackage(resources)
  for (const component of bom.components.filter(c => c['bom-ref'].startsWith('app-code:'))) {
    const record = await physicalResource(resources, component.name)
    if (String(record.bytes) !== component.properties.find(p => p.name === 'dbcommander:bytes').value || record.sha256 !== component.hashes[0].content) throw new Error('Installed application resource does not match the release inventory.')
  }
  for (const component of bom.components.filter(c => c['bom-ref'].startsWith('native:'))) {
    const entry = normalize(component.name), info = asar.statFile(path, entry), unpacked = info.unpacked ? await physicalPath(resources, `app.asar.unpacked/${component.name}`) : undefined
    const hash = info.unpacked ? await hashFile(unpacked) : digest(asar.extractFile(path, entry))
    const size = info.unpacked ? (await lstat(unpacked)).size : info.size
    if (hash !== component.hashes[0].content || manifest.inventory.schema === 5 && String(size) !== component.properties.find(p => p.name === 'dbcommander:bytes').value) throw new Error('Installed native payload does not match the release inventory.')
  }
  for (const component of bom.components.filter(c => c['bom-ref'].startsWith('unpacked:'))) {
    const file = await physicalPath(resources, `app.asar.unpacked/${component.name}`)
    if (String((await lstat(file)).size) !== component.properties.find(p => p.name === 'dbcommander:bytes').value || await hashFile(file) !== component.hashes[0].content) throw new Error('Installed unpacked payload does not match the release inventory.')
  }
  const root = runtimeLayout(resources, manifest.platform).root
  if (appImageSandboxHelper) {
    if (manifest.platform !== 'linux' || basename(appImageSandboxHelper) !== 'chrome-sandbox' || !bom.components.some(c => c['bom-ref'] === 'runtime-file:chrome-sandbox')) throw new Error('Only the inventoried Linux AppImage sandbox helper may be relocated.')
    const adjacent = await lstat(join(root, 'chrome-sandbox')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (adjacent) throw new Error('A relocated AppImage sandbox helper must not leave an adjacent copy.')
  }
  for (const component of bom.components.filter(c => c['bom-ref'].startsWith('runtime-file:'))) {
    // The disposable AppImage fixture relocates only its SUID helper to avoid
    // Chromium's whitespace parsing. Bind those actual bytes to the same SBOM.
    const path = appImageSandboxHelper && component.name === 'chrome-sandbox'
      ? await physicalPath(dirname(appImageSandboxHelper), basename(appImageSandboxHelper))
      : await physicalPath(root, component.name)
    const info = await lstat(path), bytes = component.properties.find(p => p.name === 'dbcommander:bytes').value
    if (String(info.size) !== bytes || await hashFile(path) !== component.hashes[0].content) throw new Error('Installed runtime payload does not match the release inventory.')
  }
  for (const notice of notices.notices) {
    const bytes = notice.path.startsWith('app.asar/') ? asar.extractFile(path, normalize(notice.path.slice('app.asar/'.length))) : await regularBytes(join(resources, notice.path.slice('resources/'.length)))
    if (digest(bytes) !== notice.sha256) throw new Error('Installed notices do not match the release inventory.')
  }
}
