import { spawn } from 'node:child_process'
import { readFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platforms, artifactNames, safeArtifact } from './config.cjs'
import { hashFile as sha256, verifyReleaseInventory } from './inventory.mjs'
export { sha256 }

export const root = fileURLToPath(new URL('../../', import.meta.url))
export function githubBuildId(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return 'local'
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('A GitHub Actions run ID and attempt are required.')
  return `${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`
}
export function run(command, args, options = {}) {
  const { capture = false, timeout = 15 * 60_000, ...rest } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false, ...rest })
    let output = '', error = '', expired = false
    child.stdout?.on('data', chunk => { output += chunk; if (output.length > 8_000_000) child.kill() })
    child.stderr?.on('data', chunk => { error += chunk; if (error.length > 8_000_000) child.kill() })
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      // Commands and captured signing-tool errors can contain credentials.
      if (code !== 0 || expired) reject(Object.assign(new Error(`${command} ${expired ? 'timed out' : `failed (${code})`}. See the tool output above.`), { exitCode: code }))
      else resolve((capture === 'all' ? output + error : output).trim())
    })
  })
}
export async function nativeTarget(expectedArch = process.arch) {
  if (process.arch !== expectedArch || !platforms[process.platform]?.architectures.includes(process.arch)) throw new Error(`A native ${expectedArch} release worker is required; got ${process.platform}/${process.arch}.`)
  if (process.platform === 'darwin') {
    const architecture = await run('uname', ['-m'], { capture: true })
    const translated = await run('sysctl', ['-in', 'sysctl.proc_translated'], { capture: true }).catch(() => '0')
    if (translated === '1' || architecture !== (process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('Release tests must run natively, without Rosetta.')
  }
  if (process.platform === 'linux' && await run('uname', ['-m'], { capture: true }) !== 'x86_64') throw new Error('Linux releases require a native x64 host.')
  if (process.platform === 'win32') await requireNativeWindowsX64()
  return { platform: process.platform, arch: process.arch }
}
export async function requireNativeWindowsX64(env = process.env, execute = run) {
  if ((env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE)?.toUpperCase() !== 'AMD64') throw new Error('Windows releases require a native x64 host.')
  // Windows x64 emulation can report AMD64 in both Node and the environment.
  // Query the platform's processor through CIM: x64=9, ARM64=12.
  // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor
  let architecture
  try {
    architecture = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $codes = @(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -ExpandProperty Architecture -Unique); if ($codes.Count -eq 0) { throw 'Processor architecture is unavailable.' }; $codes -join ','"], { capture: true, timeout: 30_000 })
  } catch (cause) { throw new Error('Cannot verify the Windows processor architecture. A native x64 Windows worker with working CIM is required.', { cause }) }
  if (architecture !== '9') throw new Error('Windows releases require a native x64 host. The Windows processor architecture is not x64; emulated runs cannot qualify a release.')
}
export async function artifactRecords(directory, version, platform, arch) {
  const files = []
  for (const name of artifactNames(version, platform, arch)) {
    const path = safeArtifact(directory, name), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular release artifact: ${name}`)
    files.push({ name, bytes: info.size, sha256: await sha256(path) })
  }
  return files
}
export async function readManifest(directory, { requireInventory = true } = {}) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit) || !['signed', 'unsigned'].includes(manifest.mode)) throw new Error('Invalid release manifest.')
  const actual = await artifactRecords(directory, manifest.version, manifest.platform, manifest.arch)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Release artifact checksum or size mismatch.')
  // Historical baselines may omit inventory. Never ignore one that is present
  // but damaged merely because the caller allowed the older format.
  if (requireInventory || manifest.inventory !== undefined) await verifyReleaseInventory(directory, manifest)
  return manifest
}
export function appExecutable(directory, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return join(directory, arch === 'arm64' ? 'mac-arm64' : 'mac', 'DbCommander.app', 'Contents', 'MacOS', 'DbCommander')
  if (platform === 'win32') return join(directory, 'win-unpacked', 'DbCommander.exe')
  return join(directory, 'linux-unpacked', 'dbcommander')
}
export function isMain(meta) { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(meta.url) }
