import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { nativeDependencyNotices } from './config.cjs'

const require = createRequire(import.meta.url)
const duckdb = require('../../build/vendor-notices/duckdb-dependency-provenance.json')
const property = (name, value) => ({ name: `dbcommander:${name}`, value: String(value) })
const value = (component, name) => {
  const matches = component.properties?.filter(p => p.name === `dbcommander:${name}`) || []
  return matches.length === 1 ? matches[0].value : undefined
}
function libraries(file) {
  if (file.crates) return [
    ...file.crates.map(crate => ({ name: crate.name, version: crate.version, purl: `pkg:cargo/${crate.name}@${crate.version}`, license: crate.declaredLicense,
      source: crate.crateUrl, sha256: crate.crateSha256, basis: 'Versioned crate source path retained in the reviewed native binary; transitive Cargo relationships unresolved.' })),
    ...(file.nativeLibraries || []).map(library => ({ name: library.name, version: library.version, purl: `pkg:generic/${library.name}@${library.version}`,
      source: library.sourceArchive, sha256: library.sourceArchiveSha256, basis: library.identification }))
  ]
  if (file.package.startsWith('@duckdb/node-bindings-')) return file.binary === 'duckdb.node'
    ? [{ name: 'node-addon-api', version: duckdb.nodeAddonApi.version, purl: `pkg:npm/node-addon-api@${duckdb.nodeAddonApi.version}`, license: 'MIT',
      source: duckdb.nodeAddonApi.sourceArchive, revision: duckdb.nodeAddonApi.sourceRevision,
      sha512: Buffer.from(duckdb.nodeAddonApi.registryIntegrity.slice('sha512-'.length), 'base64').toString('hex'),
      basis: 'Header dependency pinned by the verified binding source lockfile and build rules; not a separate runtime npm installation.' }]
    : [{ name: 'DuckDB', version: duckdb.duckdb.version, purl: `pkg:generic/duckdb@${duckdb.duckdb.version}`, license: 'MIT',
      source: duckdb.duckdb.sourceArchive.url, sha256: duckdb.duckdb.sourceArchive.sha256, revision: duckdb.duckdb.sourceRevision,
      basis: 'Reviewed library matches the official versioned release archive; source-notice superset does not identify every compiled vendor dependency.' }]
  return []
}

// These flat constituent links describe positive source/binary identification,
// not a reconstructed Cargo/C++ transitive dependency graph. Never turn the
// DuckDB source-license superset into claims that all its vendors are linked.
export function nativeLibraryInventory(manifest, packageComponents, nativeComponents) {
  const selected = nativeDependencyNotices.filter(file => file.platform === manifest.platform && file.arch === manifest.arch)
  const components = [], dependencies = [], ownership = new Map()
  const owners = packageComponents.filter(pkg => value(pkg, 'package-path'))
  for (const file of selected) {
    const owner = owners.find(pkg => value(pkg, 'package-path') === `node_modules/${file.package}`)
    const binary = nativeComponents.find(c => c.name === `node_modules/${file.package}/${file.binary}`)
    if (owner && !binary) throw new Error(`Native library binary is absent from the inventory: ${file.package}/${file.binary}`)
  }
  for (const binary of nativeComponents) {
    const owner = owners.filter(pkg => binary.name.startsWith(value(pkg, 'package-path') + '/'))
      .sort((a, b) => value(b, 'package-path').length - value(a, 'package-path').length)[0]
    if (owner) {
      if (!ownership.has(owner['bom-ref'])) ownership.set(owner['bom-ref'], new Set())
      ownership.get(owner['bom-ref']).add(binary['bom-ref'])
    }
    const file = selected.find(file => binary.name === `node_modules/${file.package}/${file.binary}`)
    const refs = []
    if (file) {
      if (!owner || owner.name !== file.package || owner.version !== file.version) throw new Error(`Native library package identity requires renewed source review: ${binary.name}`)
      const hash = binary.hashes?.[0]
      if (binary['bom-ref'] !== `native:${binary.name}` || binary.hashes?.length !== 1 || hash.alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(hash.content)) throw new Error('Native library binary reference/hash is invalid.')
      const transformed = hash.content !== file.binarySha256
      // afterPack verifies the original source before signing. The release
      // builder sets this receipt only after verifying actual signed output.
      if (transformed && !(manifest.mode === 'signed' && ['darwin', 'win32'].includes(manifest.platform) && manifest.verification?.codeSignature === true)) throw new Error(`Native library source hash requires renewed review: ${binary.name}`)
      for (const library of libraries(file)) {
        const ref = `native-library:${binary.name}#${library.purl}`
        refs.push(ref)
        const properties = [property('identification-basis', library.basis), property('native-file', binary['bom-ref']),
          property('reviewed-native-sha256', file.binarySha256), property('payload-relationship', transformed ? 'signed-payload-after-source-audit' : 'exact-reviewed-source-bytes'),
          property('notice-path', `resources/${file.destination}`)]
        if (library.revision) properties.push(property('source-revision', library.revision))
        components.push({ type: 'library', 'bom-ref': ref, name: library.name, version: library.version, purl: library.purl,
          ...(library.license ? { licenses: [{ expression: library.license }] } : {}),
          externalReferences: [{ type: 'distribution', url: library.source, ...(library.sha256 ? { hashes: [{ alg: 'SHA-256', content: library.sha256 }] } : library.sha512 ? { hashes: [{ alg: 'SHA-512', content: library.sha512 }] } : {}) }],
          properties })
      }
    }
    dependencies.push({ ref: binary['bom-ref'], dependsOn: refs.sort() })
  }
  return { components: components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])), dependencies,
    ownership: [...ownership].map(([ref, ids]) => ({ ref, dependsOn: [...ids].sort() })) }
}

export function verifyNativeLibraryInventory(bom, manifest) {
  const native = bom.components.filter(c => c['bom-ref'].startsWith('native:'))
  const actual = bom.components.filter(c => c['bom-ref'].startsWith('native-library:'))
  const expected = nativeLibraryInventory(manifest, bom.components, native)
  if (actual.length !== expected.components.length || expected.components.some(component => !isDeepStrictEqual(actual.find(c => c['bom-ref'] === component['bom-ref']), component))) throw new Error('Native library identity/source inventory is incomplete or changed.')
  for (const edge of expected.dependencies) {
    const found = bom.dependencies.filter(d => d.ref === edge.ref)
    if (found.length !== 1 || !isDeepStrictEqual(found[0].dependsOn, edge.dependsOn)) throw new Error('Native library constituent references are incomplete or changed.')
  }
  for (const edge of expected.ownership) {
    const found = bom.dependencies.filter(d => d.ref === edge.ref)
    if (found.length !== 1 || edge.dependsOn.some(ref => !found[0].dependsOn?.includes(ref))) throw new Error('Native library package ownership references are incomplete.')
  }
  const archive = bom.dependencies.filter(d => d.ref === 'app-asar')
  const files = bom.components.filter(c => /^(?:native|unpacked):/.test(c['bom-ref']))
  if (archive.length !== 1 || !isDeepStrictEqual(archive[0].dependsOn, files.map(c => c['bom-ref']).sort())) throw new Error('Native library ASAR references are incomplete.')
  const incomplete = ['dbcommander', 'electron-runtime', ...native.map(c => c['bom-ref']), ...expected.components.map(c => c['bom-ref'])]
  if (!bom.compositions?.some(c => c.aggregate === 'incomplete' && incomplete.every(ref => c.assemblies?.includes(ref))) ||
    bom.compositions.some(c => c.aggregate === 'complete' && c.assemblies?.some(ref => incomplete.includes(ref)))) throw new Error('Native library inventory must disclose incomplete transitive composition.')
}
