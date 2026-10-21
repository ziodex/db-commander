import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { artifactNames, signingSettings } from './release/config.cjs'
import { root, run, nativeTarget, artifactRecords, appExecutable, githubBuildId, isMain } from './release/common.mjs'
import { validateReleaseGate } from './check-release.mjs'
import { writeReleaseInventory } from './release/inventory.mjs'
import { inspectRuntime } from './release/runtime.mjs'

const require = createRequire(import.meta.url)
const builderCli = require.resolve('electron-builder/cli.js')

export function releaseBuildEnvironment(metadata, { signed = false, fixture = false, destination }, inherited = process.env) {
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(metadata.packageManager)) throw new Error('Release builds require the pinned pnpm package manager.')
  const env = { ...inherited, SQLCOMMANDER_SIGNED_RELEASE: signed ? '1' : '0', SQLCOMMANDER_BUILD_OUTPUT: destination, CSC_IDENTITY_AUTO_DISCOVERY: signed ? 'true' : 'false',
    // On Windows, Git's pwd can return a POSIX workspace path. Builder then
    // falls back to environment detection, so standalone Node entry points
    // need the same pnpm context as `pnpm package`.
    npm_config_user_agent: metadata.packageManager.replace('@', '/'), npm_package_json: join(root, 'package.json'), INIT_CWD: root }
  delete env.SQLCOMMANDER_FIXTURE_VERSION
  if (fixture) env.SQLCOMMANDER_FIXTURE_VERSION = '0.0.0'
  if (!signed) {
    for (const key of Object.keys(env)) if (/^(?:CSC_|WIN_CSC_|APPLE_|AZURE_|SQLCOMMANDER_SIGN_|SQLCOMMANDER_APPLE_)/.test(key)) delete env[key]
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
  return env
}

export async function buildRelease({ signed = false, fixture = false, output, arch = process.arch } = {}) {
  const target = await nativeTarget(arch)
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = fixture ? '0.0.0' : metadata.version
  artifactNames(version, target.platform, target.arch)
  if (!fixture && version === '0.0.0') throw new Error('0.0.0 is reserved for installer test fixtures.')
  const commit = await run('git', ['rev-parse', 'HEAD'], { capture: true })
  const buildId = githubBuildId()
  if (signed) {
    validateReleaseGate(process.env)
    if (commit !== process.env.GITHUB_SHA) throw new Error('The release checkout does not match the validated main commit.')
    if (await run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Signed releases require a clean checkout of the validated main commit.')
    signingSettings(process.env, target.platform)
    if (target.platform === 'darwin') for (const key of ['CSC_LINK', 'APPLE_API_KEY']) await access(process.env[key])
  }
  const destination = resolve(output || join(root, 'release', fixture ? 'baseline' : 'candidate'))
  // Refuse reuse instead of mixing stale installers, checksums or certificates.
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { recursive: false })
  const env = releaseBuildEnvironment(metadata, { signed, fixture, destination })
  try {
    await run(process.execPath, [builderCli, '--config', 'electron-builder.config.cjs', `--${target.platform === 'darwin' ? 'mac' : target.platform === 'win32' ? 'win' : 'linux'}`, `--${arch}`, '--publish', 'never'], { env, timeout: 45 * 60_000 })
    let verification = { codeSignature: false, notarization: false }
    if (signed && target.platform === 'darwin') {
      const app = resolve(appExecutable(destination), '../../..')
      await run('codesign', ['--verify', '--deep', '--strict', app])
      const info = await run('codesign', ['--display', '--verbose=4', app], { capture: 'all' })
      if (!info.includes(`TeamIdentifier=${process.env.SQLCOMMANDER_APPLE_TEAM_ID}`) || !info.includes(`Authority=${process.env.SQLCOMMANDER_APPLE_IDENTITY}`) || !info.includes('runtime')) throw new Error('Unexpected macOS signer or missing hardened runtime.')
      await run('xcrun', ['stapler', 'validate', app])
      await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
      const dmg = join(destination, artifactNames(version, target.platform, arch).find(name => name.endsWith('.dmg')))
      // electron-builder notarizes the app. Also notarize and staple the DMG
      // so its first launch can be verified without a network connection.
      await run('xcrun', ['notarytool', 'submit', dmg, '--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER, '--wait', '--timeout', '30m'], { timeout: 35 * 60_000 })
      await run('xcrun', ['stapler', 'staple', dmg])
      await run('xcrun', ['stapler', 'validate', dmg])
      await run('codesign', ['--verify', '--strict', dmg])
      verification = { codeSignature: true, notarization: true }
    } else if (signed && target.platform === 'win32') {
      await run('pwsh', ['-NoProfile', '-File', join(root, 'scripts/release/verify-windows.ps1'), '-Application', appExecutable(destination), '-Installer', join(destination, artifactNames(version, target.platform, arch)[0])])
      verification = { codeSignature: true, notarization: false }
    }
    if (signed && await run('git', ['rev-parse', 'HEAD'], { capture: true }) !== commit) throw new Error('The release checkout changed during packaging.')
    const manifest = { schema: 1, version, ...target, commit, buildId, mode: signed ? 'signed' : 'unsigned', fixture,
      verification, tools: { electron: metadata.devDependencies.electron, builder: metadata.devDependencies['electron-builder'] },
      files: await artifactRecords(destination, version, target.platform, arch) }
    const resources = target.platform === 'darwin' ? join(dirname(appExecutable(destination)), '..', 'Resources') : join(dirname(appExecutable(destination)), 'resources')
    const runtime = await inspectRuntime(resources, manifest)
    manifest.inventory = await writeReleaseInventory(destination, manifest, resources, runtime)
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    await writeFile(join(destination, 'SHA256SUMS'), [...manifest.files, ...manifest.inventory.files].map(file => `${file.sha256}  ${file.name}\n`).join(''), { flag: 'wx' })
    console.log(`Built ${manifest.mode} ${version} for ${target.platform}/${arch}.`)
    return manifest
  } catch (error) {
    // Never leave a valid-looking manifest for partially signed output.
    await rm(join(destination, 'manifest.json'), { force: true })
    throw error
  }
}

if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { signed: { type: 'boolean' }, fixture: { type: 'boolean' }, output: { type: 'string' }, arch: { type: 'string' } } })
  await buildRelease(values)
}
