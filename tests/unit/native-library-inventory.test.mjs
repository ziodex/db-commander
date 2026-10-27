import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { nativeDependencyNotices } from '../../scripts/release/config.cjs'
import { nativeLibraryInventory, verifyNativeLibraryInventory } from '../../scripts/release/native-libraries.mjs'

const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder')), lib = createRequire(builder.resolve('app-builder-lib'))
const Ajv = lib('ajv'), ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(require('../../scripts/release/schemas/spdx.schema.json'))
ajv.addSchema(require('../../scripts/release/schemas/jsf-0.82.schema.json'))
const schema = ajv.compile(require('../../scripts/release/schemas/bom-1.6.schema.json'))

function fixture(platform = 'darwin', arch = 'arm64') {
  const manifest = { platform, arch, mode: 'unsigned' }
  const files = nativeDependencyNotices.filter(file => file.platform === platform && file.arch === arch)
  const packages = [...new Map(files.map(file => [file.package, { type: 'library', name: file.package, version: file.version, 'bom-ref': `npm:${file.package}`,
    properties: [{ name: 'dbcommander:package-path', value: `node_modules/${file.package}` }] }])).values()]
  // These are schema input records, not foreign native programs. Actual payload
  // reading/hashing is covered by installed inventory tests and offline checks.
  const binaries = files.map(file => ({ type: 'file', name: `node_modules/${file.package}/${file.binary}`, 'bom-ref': `native:node_modules/${file.package}/${file.binary}`,
    hashes: [{ alg: 'SHA-256', content: file.binarySha256 }] }))
  const evidence = nativeLibraryInventory(manifest, packages, binaries)
  const refs = ['dbcommander', 'electron-runtime', ...binaries.map(c => c['bom-ref']), ...evidence.components.map(c => c['bom-ref'])]
  const bom = { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', 'bom-ref': 'dbcommander', name: 'Db Commander', version: '1.0.0' } },
    components: [{ type: 'framework', 'bom-ref': 'electron-runtime', name: 'Electron', version: '44.7.0' }, { type: 'file', 'bom-ref': 'app-asar', name: 'app.asar' }, ...packages, ...binaries, ...evidence.components], dependencies: [...evidence.dependencies, ...evidence.ownership,
    { ref: 'app-asar', dependsOn: binaries.map(c => c['bom-ref']).sort() }], compositions: [{ aggregate: 'incomplete', assemblies: refs }] }
  return { manifest, files, packages, binaries, evidence, bom }
}

it.each([['darwin', 'arm64', 8], ['darwin', 'x64', 8], ['linux', 'x64', 42], ['win32', 'x64', 12]])('records only identified constituents for %s/%s', (platform, arch, count) => {
  const { evidence, bom, manifest } = fixture(platform, arch)
  expect(evidence.components).toHaveLength(count)
  expect(evidence.components.find(c => c.name === 'DuckDB')).toMatchObject({ version: '1.5.6', purl: 'pkg:generic/duckdb@1.5.6' })
  expect(evidence.components.find(c => c.name === 'node-addon-api')).toMatchObject({ version: '8.8.0', purl: 'pkg:npm/node-addon-api@8.8.0' })
  expect(evidence.components.find(c => c.name === 'anyhow')).toMatchObject({ version: '1.0.104', purl: 'pkg:cargo/anyhow@1.0.104' })
  // A source-license superset cannot establish linked ICU/RE2 versions.
  expect(evidence.components.some(c => ['ICU', 'RE2', 'icu', 're2'].includes(c.name))).toBe(false)
  expect(evidence.components.find(c => c.name === 'libdbus')?.version).toBe(platform === 'linux' ? '1.14.4' : undefined)
  expect(schema(bom), JSON.stringify(schema.errors)).toBe(true)
  expect(() => verifyNativeLibraryInventory(bom, manifest)).not.toThrow()
})

it('rejects changed versions, source hashes and missing native files before making software claims', () => {
  const { manifest, packages, binaries } = fixture()
  const changed = structuredClone(packages); changed[0].version = '99.0.0'
  expect(() => nativeLibraryInventory(manifest, changed, binaries)).toThrow('package identity')
  const altered = structuredClone(binaries); altered[0].hashes[0].content = 'b'.repeat(64)
  expect(() => nativeLibraryInventory(manifest, packages, altered)).toThrow('source hash')
  expect(() => nativeLibraryInventory(manifest, packages, binaries.slice(1))).toThrow('binary is absent')
})

it('distinguishes verified signed payload hashes from the reviewed pre-signing source identity', () => {
  const { manifest, packages, binaries } = fixture()
  binaries[0].hashes[0].content = 'b'.repeat(64)
  expect(() => nativeLibraryInventory({ ...manifest, mode: 'signed' }, packages, binaries)).toThrow('source hash')
  const result = nativeLibraryInventory({ ...manifest, mode: 'signed', verification: { codeSignature: true } }, packages, binaries)
  const crate = result.components.find(c => c.name === 'anyhow')
  expect(crate.properties).toContainEqual({ name: 'dbcommander:reviewed-native-sha256', value: nativeDependencyNotices[0].binarySha256 })
  expect(crate.properties).toContainEqual({ name: 'dbcommander:payload-relationship', value: 'signed-payload-after-source-audit' })
  const linux = fixture('linux', 'x64'); linux.binaries[0].hashes[0].content = 'b'.repeat(64)
  expect(() => nativeLibraryInventory({ ...linux.manifest, mode: 'signed', verification: { codeSignature: true } }, linux.packages, linux.binaries)).toThrow('source hash')
})

it.each(['omitted library', 'version', 'source digest', 'constituent edge', 'package edge', 'ASAR edge', 'complete claim'])('rejects %s even when outer file hashes are refreshed', fault => {
  const { bom, manifest } = fixture()
  const library = bom.components.find(c => c['bom-ref'].startsWith('native-library:'))
  if (fault === 'omitted library') bom.components = bom.components.filter(c => c !== library)
  if (fault === 'version') library.version = '99.0.0'
  if (fault === 'source digest') library.externalReferences[0].hashes[0].content = 'c'.repeat(64)
  if (fault === 'constituent edge') bom.dependencies.find(d => d.ref.startsWith('native:')).dependsOn = []
  if (fault === 'package edge') bom.dependencies.find(d => d.ref.startsWith('npm:')).dependsOn = []
  if (fault === 'ASAR edge') bom.dependencies.find(d => d.ref === 'app-asar').dependsOn = []
  if (fault === 'complete claim') bom.compositions[0].aggregate = 'complete'
  expect(() => verifyNativeLibraryInventory(bom, manifest)).toThrow(/Native library/)
})

it('keeps unreviewed native bytes in the graph without inventing software versions or another target qualification', () => {
  const { manifest } = fixture(), foreign = fixture('win32', 'x64')
  const result = nativeLibraryInventory(manifest, foreign.packages, foreign.binaries)
  expect(result.components).toEqual([])
  expect(result.dependencies.every(d => d.dependsOn.length === 0)).toBe(true)
  expect(result.ownership).toHaveLength(2)
})
