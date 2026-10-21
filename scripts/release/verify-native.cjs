const { lstat, readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { platforms, applicationResourcesFor, runtimeNotices, dependencyNoticeSources, vendorNoticeSources, nativeDependencyNoticeSources } = require('./config.cjs')
const { verifyOracleThinPackage } = require('./oracle-thin.cjs')

function requiredNativeFiles(platform, arch) {
  if (!platforms[platform]?.architectures.includes(arch)) throw new Error(`Unsupported native package target: ${platform}/${arch}`)
  const duckdb = `node_modules/@duckdb/node-bindings-${platform}-${arch}`
  const keyring = platform === 'win32' ? 'win32-x64-msvc' : platform === 'linux' ? 'linux-x64-gnu' : `${platform}-${arch}`
  const library = platform === 'win32' ? 'duckdb.dll' : platform === 'darwin' ? 'libduckdb.dylib' : 'libduckdb.so'
  return [`${duckdb}/duckdb.node`, `${duckdb}/${library}`, `node_modules/@napi-rs/keyring-${keyring}/keyring.${keyring}.node`]
}
async function verifyNativeFiles(resources, platform, arch) {
  for (const file of requiredNativeFiles(platform, arch)) {
    const path = join(resources, 'app.asar.unpacked', file)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) throw new Error(`Packaged ${platform}/${arch} is missing a regular, nonempty native binary: ${file}. Check pnpm dependency collection before building installers.`)
  }
}
async function verifyRuntimeNotices(resources, electronDist, expectedVersion) {
  const version = (await readFile(join(electronDist, 'version'), 'utf8')).trim()
  if (version !== expectedVersion) throw new Error('Electron notice source does not match the packaged runtime version.')
  await verifyNoticeFiles(resources, runtimeNotices.map(file => ({ ...file, sourcePath: join(electronDist, file.source) })))
}
async function verifyDependencyNotices(resources, projectDir) {
  await verifyNoticeFiles(resources, dependencyNoticeSources(projectDir))
}
async function verifyVendorNotices(resources, expectedElectron, platform, projectDir) {
  await verifyNoticeFiles(resources, vendorNoticeSources(expectedElectron, platform, projectDir))
}
async function verifyNativeDependencyNotices(resources, platform, arch, projectDir) {
  const files = nativeDependencyNoticeSources(platform, arch, projectDir)
  await verifyNoticeFiles(resources, files)
  for (const file of files) {
    const binary = await readFile(join(resources, 'app.asar.unpacked', file.binaryPath))
    if (createHash('sha256').update(binary).digest('hex') !== file.binarySha256) throw new Error(`Packaged native dependency differs from reviewed notice source: ${file.package}`)
  }
}
async function verifyNoticeFiles(resources, files, label = 'runtime notice') {
  for (const file of files) {
    const destination = join(resources, file.destination)
    const info = await lstat(destination).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) throw new Error(`Packaged ${label} is missing or not a regular, nonempty file: ${file.destination}`)
    const [actual, expected] = await Promise.all([readFile(destination), readFile(file.sourcePath)])
    if (!actual.equals(expected)) throw new Error(`Packaged ${label} differs from the reviewed upstream source: ${file.destination}`)
  }
}
async function verifyApplicationResources(resources, projectDir, platform = process.platform) {
  const applicationResources = applicationResourcesFor(platform)
  for (const file of applicationResources) {
    let parent = resources
    for (const part of file.destination.split('/').slice(0, -1)) {
      parent = join(parent, part)
      if (!(await lstat(parent)).isDirectory()) throw new Error('Application resources require regular directories.')
    }
  }
  await verifyNoticeFiles(resources, applicationResources.map(file => ({ ...file, sourcePath: join(projectDir, file.source) })), 'application resource')
}
function createAfterPack(nativeAudit = verifyNativeDependencyNotices) {
  return async context => {
    const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
    const resources = context.packager.getResourcesDir(context.appOutDir)
    await verifyNativeFiles(resources, context.electronPlatformName, arch)
    await verifyRuntimeNotices(resources, join(context.packager.projectDir, 'node_modules/electron/dist'), context.packager.info.framework.version)
    await verifyDependencyNotices(resources, context.packager.projectDir)
    await verifyVendorNotices(resources, context.packager.info.framework.version, context.electronPlatformName, context.packager.projectDir)
    await nativeAudit(resources, context.electronPlatformName, arch, context.packager.projectDir)
    await verifyOracleThinPackage(resources)
    await verifyApplicationResources(resources, context.packager.projectDir, context.electronPlatformName)
  }
}
module.exports = createAfterPack()
module.exports.createAfterPack = createAfterPack
module.exports.requiredNativeFiles = requiredNativeFiles
module.exports.verifyNativeFiles = verifyNativeFiles
module.exports.verifyRuntimeNotices = verifyRuntimeNotices
module.exports.verifyDependencyNotices = verifyDependencyNotices
module.exports.verifyVendorNotices = verifyVendorNotices
module.exports.verifyNativeDependencyNotices = verifyNativeDependencyNotices
module.exports.verifyApplicationResources = verifyApplicationResources
