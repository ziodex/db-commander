import { createRequire } from 'node:module'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { writeReleaseInventory } from '../../scripts/release/inventory.mjs'
import { applicationResourcesFor, runtimeNotices, dependencyNotices, vendorNoticeSources, nativeDependencyNotices } from '../../scripts/release/config.cjs'
import { runtimeLayout } from '../../scripts/release/runtime.mjs'

const require = createRequire(import.meta.url), b = createRequire(require.resolve('electron-builder')), lib = createRequire(b.resolve('app-builder-lib'))
export const asar = lib('@electron/asar')
export async function seedInventory(directory, manifest, { packages = {}, dependencies = {}, native = false, extraFiles = {}, unpackDir } = {}) {
  manifest.tools ??= { electron: '44.7.0', builder: '26.15.3' }
  const source = join(directory, 'inventory-input'), resources = join(directory, 'inventory-app', ...(manifest.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']))
  await mkdir(source, { recursive: true }); await mkdir(resources, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dbcommander', version: manifest.version, license: 'Apache-2.0', dependencies }))
  await writeFile(join(source, 'LICENSE'), 'Application license fixture\r\n')
  await writeFile(join(source, 'THIRD_PARTY_NOTICES.md'), 'Application notice fixture\n')
  for (const [path, data] of Object.entries(packages)) {
    const destination = join(source, path); await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'package.json'), JSON.stringify(data))
    await writeFile(join(destination, 'LICENSE'), '\ufeffUpstream license fixture\r\n')
  }
  if (native) for (const name of ['fixture.node', 'native/with spaces % # é/fixture.node']) {
    const destination = join(source, name); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, 'native payload')
  }
  for (const [name, value] of Object.entries(extraFiles)) { const destination = join(source, name); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, value) }
  await asar.createPackageWithOptions(source, join(resources, 'app.asar'), { unpack: '*.node', ...(unpackDir ? { unpackDir } : {}) })
  for (const file of applicationResourcesFor(manifest.platform)) { const destination = join(resources, file.destination); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, 'Self-contained worker fixture\n') }
  for (const file of [...runtimeNotices, ...dependencyNotices]) { const destination = join(resources, file.destination); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `Runtime notice ${file.source}\n`) }
  for (const file of vendorNoticeSources(manifest.tools.electron, manifest.platform)) await copyFile(file.sourcePath, join(resources, file.destination))
  for (const file of nativeDependencyNotices.filter(file => file.platform === manifest.platform && file.arch === manifest.arch)) await copyFile(new URL(`../../build/vendor-notices/${file.source}`, import.meta.url), join(resources, file.destination))
  const runtime = { platform: manifest.platform, arch: manifest.arch, versions: { electron: manifest.tools.electron, node: '24.21.0', chrome: '152.0.7977.130', sqlite: '3.53.4', v8: '15.2.124.28-electron.0', openssl: '0.0.0', nghttp3: '' } }
  const layout = runtimeLayout(resources, manifest.platform), executable = join(layout.root, layout.executable)
  await mkdir(dirname(executable), { recursive: true })
  const header = Buffer.from(manifest.platform === 'darwin' ? 'cffaedfe' : manifest.platform === 'win32' ? '4d5a0000' : '7f454c46', 'hex')
  await writeFile(executable, Buffer.concat([header, Buffer.from('executable fixture')]))
  const library = join(layout.root, manifest.platform === 'darwin' ? 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework' : manifest.platform === 'win32' ? 'ffmpeg.dll' : 'libffmpeg.so')
  await mkdir(dirname(library), { recursive: true }); await writeFile(library, Buffer.concat([header, Buffer.from('runtime library fixture')]))
  manifest.inventory = await writeReleaseInventory(directory, manifest, resources, runtime)
  return { source, resources, runtime }
}
