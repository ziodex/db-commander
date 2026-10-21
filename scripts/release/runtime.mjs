import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'

const execute = promisify(execFile)
const probe = 'JSON.stringify({platform:process.platform,arch:process.arch,versions:process.versions})'
const nativeHeaders = new Set(['7f454c46', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const libraryKeys = new Set(['node', 'chrome', 'v8', 'acorn', 'ada', 'amaro', 'ares', 'brotli', 'icu', 'llhttp', 'merve', 'nbytes', 'ncrypto', 'nghttp2', 'nghttp3', 'ngtcp2', 'openssl', 'simdjson', 'simdutf', 'sqlite', 'undici', 'uv', 'uvwasi', 'zlib', 'zstd'])

export function runtimeLayout(resources, platform) {
  if (platform === 'darwin') return { root: dirname(resources), executable: 'MacOS/DbCommander' }
  if (platform === 'win32') return { root: dirname(resources), executable: 'DbCommander.exe' }
  if (platform === 'linux') return { root: dirname(resources), executable: 'dbcommander' }
  throw new Error('Unsupported runtime inventory platform.')
}

export function validateRuntimeReport(report, manifest) {
  if (!report || report.platform !== manifest.platform || report.arch !== manifest.arch || !report.versions || Array.isArray(report.versions) || typeof report.versions !== 'object') throw new Error('Runtime inventory target mismatch.')
  const entries = Object.entries(report.versions)
  if (!entries.length || entries.length > 128 || entries.some(([name, version]) => !/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof version !== 'string' || version.length > 128 || !/^[a-zA-Z0-9.+_-]*$/.test(version))) throw new Error('Invalid reported runtime versions.')
  if (report.versions.electron !== manifest.tools?.electron || !semver.valid(report.versions.node) || semver.major(report.versions.node) === 0 || !/^[1-9]\d*\.\d+\.\d+\.\d+$/.test(report.versions.chrome || '') || !semver.valid(report.versions.sqlite) || semver.major(report.versions.sqlite) === 0) throw new Error('Missing or mismatched Electron/Node/Chromium/SQLite runtime version.')
}

// Run only the just-built executable, with a fixed Node expression. Do not pass
// signing credentials, NODE_OPTIONS or Electron launch/debug overrides to it.
export async function inspectRuntime(resources, manifest, inherited = process.env, run = execute) {
  const layout = runtimeLayout(resources, manifest.platform), executable = join(layout.root, layout.executable)
  const info = await lstat(executable)
  if (!info.isFile() || info.size === 0) throw new Error('Runtime probe requires a regular, nonempty packaged executable.')
  const env = { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) if (inherited[key] !== undefined) env[key] = inherited[key]
  let report
  try {
    const { stdout } = await run(executable, ['-p', probe], { env, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true })
    report = JSON.parse(stdout)
  } catch { throw new Error('Cannot inspect the packaged Electron runtime versions.') }
  validateRuntimeReport(report, manifest)
  return { platform: report.platform, arch: report.arch, versions: Object.fromEntries(Object.entries(report.versions).sort(([a], [b]) => a.localeCompare(b))) }
}

export function runtimeLibraries(report) {
  // Empty/zero values (for example Electron's OpenSSL placeholder) are retained
  // as reported properties, but must never become a claimed component version.
  // ABI numbers and Unicode/time-zone data revisions are properties, not
  // independently identified software libraries. Unknown future keys stay raw.
  return Object.entries(report.versions).filter(([name, version]) => libraryKeys.has(name) && version && !/^0(?:\.0)*(?:[-+].*)?$/.test(version))
    .map(([name, version]) => ({ key: name, name: { node: 'Node.js', chrome: 'Chromium', sqlite: 'SQLite' }[name] || name, version }))
}

// Enumerate regular Mach-O/PE/ELF files from the actual bundle, including
// helpers/frameworks. Skip symlink aliases and ASAR-unpacked bytes (inventoried
// separately). No directory symlink is followed outside the bundle.
export async function runtimeBinaries(resources, platform) {
  const { root, executable } = runtimeLayout(resources, platform), records = []
  let visited = 0
  async function visit(relative) {
    const directory = join(root, relative)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error('Runtime inventory exceeds its file limit.')
      const name = posix.join(relative, entry.name)
      if (/^(?:Resources|resources)\/app\.asar\.unpacked(?:\/|$)/.test(name) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(name); continue }
      if (!entry.isFile()) throw new Error('Runtime inventory contains a non-regular file.')
      const path = join(root, name), handle = await open(path, 'r')
      const header = Buffer.alloc(4)
      try { await handle.read(header, 0, 4, 0) } finally { await handle.close() }
      if (!nativeHeaders.has(header.toString('hex')) && header.subarray(0, 2).toString('ascii') !== 'MZ') continue
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      records.push({ name, bytes: (await lstat(path)).size, sha256: hash.digest('hex') })
    }
  }
  await visit('')
  if (!records.some(file => file.name === executable)) throw new Error('Packaged executable is absent from the native runtime inventory.')
  return records.sort((a, b) => a.name.localeCompare(b.name))
}
