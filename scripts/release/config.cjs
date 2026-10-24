const path = require('node:path')
const { createRequire } = require('node:module')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const semver = require('semver')
const vendorProvenance = require('../../build/vendor-notices/provenance.json')
const nativeDependencyProvenance = require('../../build/vendor-notices/native-dependency-provenance.json')
const duckdbDependencyProvenance = require('../../build/vendor-notices/duckdb-dependency-provenance.json')

const platforms = {
  darwin: { name: 'mac', architectures: ['x64', 'arm64'], extensions: ['dmg', 'zip'] },
  win32: { name: 'win', architectures: ['x64'], extensions: ['exe'] },
  linux: { name: 'linux', architectures: ['x64'], extensions: ['AppImage', 'deb', 'rpm'] }
}
const runtimeNotices = [
  { source: 'LICENSE', destination: 'licenses/LICENSE.electron.txt' },
  { source: 'LICENSES.chromium.html', destination: 'licenses/LICENSES.chromium.html' }
]
const applicationResources = [
  { source: 'out/worker/sqlite-worker.cjs', destination: 'workers/sqlite-worker.cjs' },
  { source: 'out/worker/windows-owner-guard.exe', destination: 'workers/windows-owner-guard.exe', platform: 'win32' }
]
const applicationResourcesFor = platform => applicationResources.filter(file => !file.platform || file.platform === platform)
// Builder drops dependency READMEs, including these upstream license texts.
// Review the notice source again when any of these pinned versions changes.
const dependencyNotices = [
  { package: 'pg-types', version: '2.2.0', parents: ['pg'], source: 'README.md', destination: 'licenses/pg-types-2.2.0.README.md' },
  { package: 'pgpass', version: '1.0.5', parents: ['pg'], source: 'README.md', destination: 'licenses/pgpass-1.0.5.README.md' },
  { package: 'railroad-diagrams', version: '1.0.0', parents: ['sql-formatter', 'nearley'], source: 'README.md', destination: 'licenses/railroad-diagrams-1.0.0.README.md' }
]
const vendorNotices = vendorProvenance.frameworks.map(file => ({ ...file, platform: 'darwin', electronVersion: vendorProvenance.electronVersion, destination: `licenses/${file.source}` }))
const nativeDependencyNotices = [...nativeDependencyProvenance.targets, ...duckdbDependencyProvenance.targets].map(file => ({ ...file, destination: `licenses/${file.source}` }))
function vendorNoticeSources(expectedElectron, platform, projectDir = path.resolve(__dirname, '../..')) {
  if (platform !== 'darwin') return []
  if (expectedElectron !== vendorProvenance.electronVersion) throw new Error('Review native framework notice sources for the new Electron version.')
  return vendorNotices.map(file => {
    if (path.basename(file.source) !== file.source || !/^[a-f0-9]{40}$/.test(file.revision) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid framework notice provenance.')
    const sourcePath = path.join(projectDir, 'build/vendor-notices', file.source), bytes = readFileSync(sourcePath)
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Framework notice differs from pinned upstream bytes: ${file.name}`)
    return { ...file, sourcePath }
  })
}
function dependencyNoticeSources(projectDir = path.resolve(__dirname, '../..')) {
  return dependencyNotices.map(file => {
    let resolver = createRequire(path.join(projectDir, 'package.json'))
    for (const parent of file.parents) resolver = createRequire(resolver.resolve(parent))
    const metadataPath = resolver.resolve(`${file.package}/package.json`)
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    if (metadata.name !== file.package || metadata.version !== file.version) throw new Error(`Review the dependency notice source for ${file.package}: expected ${file.version}.`)
    return { ...file, sourcePath: path.join(path.dirname(metadataPath), file.source) }
  })
}

function pinnedNativeNoticeSource(file, projectDir = path.resolve(__dirname, '../..')) {
  if (path.basename(file.source) !== file.source || path.basename(file.binary) !== file.binary || !/^[a-f0-9]{64}$/.test(file.sha256) || !/^[a-f0-9]{64}$/.test(file.binarySha256)) throw new Error('Invalid native dependency notice provenance.')
  let resolver = createRequire(path.join(projectDir, 'package.json'))
  for (const parent of file.parents) resolver = createRequire(resolver.resolve(parent))
  const metadataPath = resolver.resolve(`${file.package}/package.json`)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (metadata.name !== file.package || metadata.version !== file.version) throw new Error(`Review native dependency notices for ${file.package}: expected ${file.version}.`)
  const binary = readFileSync(path.join(path.dirname(metadataPath), file.binary))
  if (createHash('sha256').update(binary).digest('hex') !== file.binarySha256) throw new Error(`Review native dependency notices for changed binary: ${file.package}`)
  const sourcePath = path.join(projectDir, 'build/vendor-notices', file.source), bytes = readFileSync(sourcePath)
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Native dependency notice differs from pinned upstream texts: ${file.package}`)
  return { ...file, sourcePath, destination: `licenses/${file.source}`, binaryPath: `node_modules/${file.package}/${file.binary}` }
}

// Bind reviewed binary/source notice mappings to their exact target. These
// partial inventories do not establish a complete compiled dependency graph.
function nativeDependencyNoticeSources(platform, arch, projectDir = path.resolve(__dirname, '../..')) {
  return nativeDependencyNotices.filter(file => file.platform === platform && file.arch === arch)
    .map(file => pinnedNativeNoticeSource(file, projectDir))
}

function required(env, name) {
  const value = env[name]
  if (!value?.trim() || /^\$\([^)]+\)$/.test(value)) throw new Error(`Missing release setting: ${name}`)
  return value
}

function signingSettings(env, platform) {
  if (platform === 'darwin') {
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'SQLCOMMANDER_APPLE_IDENTITY', 'SQLCOMMANDER_APPLE_TEAM_ID']) required(env, name)
    if (!env.SQLCOMMANDER_APPLE_IDENTITY.startsWith('Developer ID Application: ')) throw new Error('Use a Developer ID Application signing identity.')
  } else if (platform === 'win32') {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'SQLCOMMANDER_SIGN_ENDPOINT', 'SQLCOMMANDER_SIGN_ACCOUNT', 'SQLCOMMANDER_SIGN_PROFILE', 'SQLCOMMANDER_SIGN_PUBLISHER']) required(env, name)
    const endpoint = new URL(env.SQLCOMMANDER_SIGN_ENDPOINT)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !endpoint.hostname.endsWith('.codesigning.azure.net')) throw new Error('Use an HTTPS Azure Trusted Signing endpoint.')
  }
}

function builderConfig(env = process.env) {
  const signed = env.SQLCOMMANDER_SIGNED_RELEASE === '1'
  if (env.SQLCOMMANDER_SIGNED_RELEASE && !['0', '1'].includes(env.SQLCOMMANDER_SIGNED_RELEASE)) throw new Error('SQLCOMMANDER_SIGNED_RELEASE must be 0 or 1.')
  const config = {
    appId: 'org.dbcommander.desktop', productName: 'Db Commander', executableName: 'DbCommander',
    directories: { output: env.SQLCOMMANDER_BUILD_OUTPUT || 'release', buildResources: 'build' },
    // Oracle is deliberately Thin-only. Keep dependency installation untouched;
    // omit the upstream-optional Thick addons only from release payloads.
    files: ['out/**/*', '!out/worker/**/*', '!out/main/windows-owner-guard.exe', '!**/node_modules/oracledb/build{,/**/*}', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    extraResources: [
      ...applicationResourcesFor(process.platform).map(file => ({ from: file.source, to: file.destination })),
      { from: 'build/icons/1024x1024.png', to: 'icon.png' },
      { from: 'build/icons/trayTemplate.png', to: 'trayTemplate.png' },
      { from: 'build/icons/trayTemplate@2x.png', to: 'trayTemplate@2x.png' },
      { from: 'src/renderer/themes/LICENSE.txt', to: 'licenses/VSCode-theme-LICENSE.txt' },
      { from: 'src/renderer/assets/material-icons/LICENSE.txt', to: 'licenses/Material-Icon-Theme-LICENSE.txt' },
      ...runtimeNotices.map(file => ({ from: `node_modules/electron/dist/${file.source}`, to: file.destination })),
      ...dependencyNoticeSources().map(file => ({ from: file.sourcePath, to: file.destination })),
      ...nativeDependencyNoticeSources(process.platform, process.arch).map(file => ({ from: file.sourcePath, to: file.destination }))
    ],
    asar: true, publish: null, afterPack: 'scripts/release/verify-native.cjs',
    artifactName: 'DbCommander-${version}-${os}-${arch}.${ext}',
    forceCodeSigning: signed && process.platform !== 'linux',
    mac: {
      icon: 'build/icons/icon.icns',
      extraResources: vendorNoticeSources(vendorProvenance.electronVersion, 'darwin').map(file => ({ from: file.sourcePath, to: file.destination })),
      target: ['dmg', 'zip'], category: 'public.app-category.developer-tools',
      // builder v26 chooses the certificate type itself and rejects its prefix
      // in the qualifier. Retain the full identity separately for verification.
      identity: signed ? env.SQLCOMMANDER_APPLE_IDENTITY?.replace(/^Developer ID Application: /, '') : null,
      hardenedRuntime: signed, notarize: signed,
      ...(signed ? { entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' } : {})
    },
    dmg: { sign: signed },
    win: {
      icon: 'build/icons/icon.ico',
      target: ['nsis'], signExecutable: signed, requestedExecutionLevel: 'asInvoker',
      ...(signed ? { azureSignOptions: {
        publisherName: env.SQLCOMMANDER_SIGN_PUBLISHER,
        endpoint: env.SQLCOMMANDER_SIGN_ENDPOINT,
        codeSigningAccountName: env.SQLCOMMANDER_SIGN_ACCOUNT,
        certificateProfileName: env.SQLCOMMANDER_SIGN_PROFILE,
        fileDigest: 'SHA256', timestampDigest: 'SHA256'
      } } : {})
    },
    nsis: {
      include: 'build/installer.nsh',
      oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false, runAfterFinish: false,
      createDesktopShortcut: false, createStartMenuShortcut: true, uninstallDisplayName: 'Db Commander'
    },
    // electron-builder's AppImage launcher otherwise adds --no-sandbox.
    appImage: { executableArgs: [] },
    linux: {
      icon: 'build/icons',
      target: ['AppImage', 'deb', 'rpm'], category: 'Development',
      executableName: 'dbcommander',
      // electron-builder otherwise requires an email in package.author for deb/rpm.
      maintainer: 'Db Commander contributors', synopsis: 'SQL database editor',
      desktop: { entry: { StartupWMClass: 'Db Commander' } }
    }
  }
  if (env.SQLCOMMANDER_FIXTURE_VERSION) {
    if (env.SQLCOMMANDER_FIXTURE_VERSION !== '0.0.0') throw new Error('Only 0.0.0 upgrade fixtures are permitted.')
    config.extraMetadata = { version: '0.0.0' }
  }
  return config
}

function artifactNames(version, platform, arch) {
  if (semver.valid(version) !== version || version.includes('+')) throw new Error('Use a semantic release version without build metadata.')
  const target = platforms[platform]
  if (!target?.architectures.includes(arch)) throw new Error(`Unsupported release target: ${platform}/${arch}`)
  // electron-builder expands ${arch} using the package format's architecture
  // spelling. Manifest target identities remain Node's x64/arm64 names.
  return target.extensions.map(extension => {
    const artifactArch = platform === 'linux' ? extension === 'deb' ? 'amd64' : 'x86_64' : arch
    return `DbCommander-${version}-${target.name}-${artifactArch}.${extension}`
  })
}

function safeArtifact(root, name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || /[\\/\r\n]/.test(name) || name === '.' || name === '..') throw new Error('Invalid release artifact name.')
  return path.join(root, name)
}

module.exports = { platforms, applicationResources, applicationResourcesFor, runtimeNotices, dependencyNotices, dependencyNoticeSources, vendorNotices, vendorNoticeSources, nativeDependencyNotices, nativeDependencyNoticeSources, pinnedNativeNoticeSource, required, signingSettings, builderConfig, artifactNames, safeArtifact }
