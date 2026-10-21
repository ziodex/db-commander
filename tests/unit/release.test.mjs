import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { createRequire } from 'node:module'
import { builderConfig, signingSettings, artifactNames, safeArtifact } from '../../scripts/release/config.cjs'
import { artifactRecords, readManifest, requireNativeWindowsX64 } from '../../scripts/release/common.mjs'
import { validateReleaseGate } from '../../scripts/check-release.mjs'
import { requireDisposableHost } from '../../scripts/release/install.mjs'
import { releaseBuildEnvironment } from '../../scripts/build-release.mjs'
import { promoteRelease, validateCandidate, releaseTargets } from '../../scripts/promote-release.mjs'
import { seedInventory } from '../fixtures/release-inventory.mjs'
import { inventoryNames } from '../../scripts/release/inventory.mjs'

const commit = 'a'.repeat(40), directories = []
const passedLifecycle = (platform, format) => ({ format, status: 'passed', chromiumSandbox: platform !== 'linux' ? 'platform-default' : format === 'rpm' ? 'disabled-disposable-container' : 'enforced' })
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('release safety and evidence', () => {
  it('retains pnpm collection when a workspace probe returns an unreadable path', async () => {
    const env = releaseBuildEnvironment({ packageManager: 'pnpm@11.25.0' }, { destination: 'output' }, { npm_config_user_agent: 'npm/11.0.0', npm_execpath: 'npm-cli.js' })
    for (const key of ['npm_config_user_agent', 'npm_execpath', 'npm_package_json', 'INIT_CWD']) vi.stubEnv(key, env[key])
    const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'))
    const { detectPackageManager } = builderRequire('app-builder-lib/out/node-module-collector/packageManager.js')
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-missing-workspace-')); directories.push(directory)
    expect((await detectPackageManager([join(directory, 'unreadable-workspace')])).pm).toBe('pnpm')
    expect(env.npm_package_json).toBe(join(process.cwd(), 'package.json'))
  })
  it('keeps standalone pnpm builds unsigned and does not inherit a stale fixture version', () => {
    const inherited = { CSC_LINK: 'private.p12', AZURE_CLIENT_SECRET: 'private', SQLCOMMANDER_FIXTURE_VERSION: '0.0.0' }
    const env = releaseBuildEnvironment({ packageManager: 'pnpm@11.25.0' }, { destination: 'output' }, inherited)
    expect(env).toMatchObject({ SQLCOMMANDER_SIGNED_RELEASE: '0', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    for (const key of Object.keys(inherited)) expect(env).not.toHaveProperty(key)
    expect(releaseBuildEnvironment({ packageManager: 'pnpm@11.25.0' }, { destination: 'output', fixture: true }, inherited).SQLCOMMANDER_FIXTURE_VERSION).toBe('0.0.0')
    expect(() => releaseBuildEnvironment({ packageManager: 'npm@11.0.0' }, { destination: 'output' })).toThrow('pinned pnpm')
    expect(inherited.CSC_LINK).toBe('private.p12')
  })
  it('accepts Windows x64 only when its processor confirms the process architecture', async () => {
    const execute = vi.fn().mockResolvedValue('9')
    await expect(requireNativeWindowsX64({ PROCESSOR_ARCHITECTURE: 'AMD64' }, execute)).resolves.toBeUndefined()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toBe('powershell.exe')
  })
  it('rejects Windows ARM64 emulation even when Node sees an AMD64 environment', async () => {
    await expect(requireNativeWindowsX64({ PROCESSOR_ARCHITECTURE: 'AMD64' }, vi.fn().mockResolvedValue('12'))).rejects.toThrow('emulated runs cannot qualify')
  })
  it('rejects non-x64 Windows environments before starting a processor probe', async () => {
    const execute = vi.fn()
    for (const env of [{}, { PROCESSOR_ARCHITECTURE: 'ARM64' }, { PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: 'ARM64' }]) await expect(requireNativeWindowsX64(env, execute)).rejects.toThrow('native x64')
    expect(execute).not.toHaveBeenCalled()
  })
  it('refuses Windows release qualification when CIM is unavailable', async () => {
    await expect(requireNativeWindowsX64({ PROCESSOR_ARCHITECTURE: 'AMD64' }, vi.fn().mockRejectedValue(new Error('CIM unavailable')))).rejects.toThrow('Cannot verify')
  })
  it('refuses empty, mixed and unknown Windows processor results', async () => {
    for (const result of ['', '9,12', '0', 'unknown']) await expect(requireNativeWindowsX64({ PROCESSOR_ARCHITECTURE: 'AMD64' }, vi.fn().mockResolvedValue(result))).rejects.toThrow('native x64')
  })
  it('keeps ordinary builds unsigned even when the environment contains signing credentials', () => {
    const config = builderConfig({ CSC_LINK: 'secret.p12', SQLCOMMANDER_APPLE_IDENTITY: 'Developer ID Application: Example', AZURE_CLIENT_SECRET: 'secret' })
    expect(config.mac.identity).toBeNull(); expect(config.mac.notarize).toBe(false)
    expect(config.win.signExecutable).toBe(false); expect(config.forceCodeSigning).toBe(false)
    expect(config.publish).toBeNull(); expect(config.nsis.deleteAppDataOnUninstall).toBe(false)
    expect(JSON.stringify(config)).not.toContain('secret')
  })
  it('fails closed for missing or unresolved signing secrets and wrong identity/endpoint', () => {
    expect(() => signingSettings({}, 'darwin')).toThrow('CSC_LINK')
    const mac = Object.fromEntries(['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'SQLCOMMANDER_APPLE_IDENTITY', 'SQLCOMMANDER_APPLE_TEAM_ID'].map(key => [key, 'configured']))
    expect(() => signingSettings(mac, 'darwin')).toThrow('Developer ID')
    mac.SQLCOMMANDER_APPLE_IDENTITY = 'Developer ID Application: Example (TEAM123456)'
    expect(() => signingSettings(mac, 'darwin')).not.toThrow()
    mac.CSC_KEY_PASSWORD = '$(APPLE_CERTIFICATE_PASSWORD)'
    expect(() => signingSettings(mac, 'darwin')).toThrow('Missing release setting')
    const win = Object.fromEntries(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'SQLCOMMANDER_SIGN_ENDPOINT', 'SQLCOMMANDER_SIGN_ACCOUNT', 'SQLCOMMANDER_SIGN_PROFILE', 'SQLCOMMANDER_SIGN_PUBLISHER'].map(key => [key, 'configured']))
    win.SQLCOMMANDER_SIGN_ENDPOINT = 'https://example.invalid'
    expect(() => signingSettings(win, 'win32')).toThrow('endpoint')
    win.SQLCOMMANDER_SIGN_ENDPOINT = 'https://eus.codesigning.azure.net'
    expect(() => signingSettings(win, 'win32')).not.toThrow()
  })
  it('uses the builder certificate qualifier while keeping signature verification tied to the full identity', () => {
    const config = builderConfig({ SQLCOMMANDER_SIGNED_RELEASE: '1', SQLCOMMANDER_APPLE_IDENTITY: 'Developer ID Application: Example (TEAM123456)', SQLCOMMANDER_SIGN_PUBLISHER: 'Example' })
    expect(config.mac.identity).toBe('Example (TEAM123456)')
    expect(config.mac.hardenedRuntime).toBe(true); expect(config.mac.notarize).toBe(true)
    expect(config.dmg.sign).toBe(true); expect(config.win.signExecutable).toBe(true)
    expect(config.win.azureSignOptions.publisherName).toBe('Example')
  })
  it('requires main and a configured native ARM pool for a complete release', () => {
    expect(() => validateReleaseGate({ BUILD_SOURCEBRANCH: 'refs/heads/development', BUILD_SOURCEVERSION: commit }, 'AppleSilicon')).toThrow('main')
    expect(() => validateReleaseGate({ BUILD_SOURCEBRANCH: 'refs/heads/main', BUILD_SOURCEVERSION: commit }, '')).toThrow('native Apple Silicon')
    expect(() => validateReleaseGate({ BUILD_SOURCEBRANCH: 'refs/heads/main', BUILD_SOURCEVERSION: commit }, 'AppleSilicon')).not.toThrow()
  })
  it('restricts installer formats and paths to the supported native targets', () => {
    expect(releaseTargets).toEqual(['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64'])
    expect(artifactNames('0.1.0', 'darwin', 'arm64')).toEqual(['DbCommander-0.1.0-mac-arm64.dmg', 'DbCommander-0.1.0-mac-arm64.zip'])
    expect(() => artifactNames('1.0.0', 'linux', 'arm64')).toThrow('Unsupported')
    expect(() => artifactNames('../1', 'linux', 'x64')).toThrow('semantic')
    for (const name of ['../secret', '..\\secret', '/absolute', 'foo\nbar', '.']) expect(() => safeArtifact('/tmp', name)).toThrow('Invalid')
    expect(() => builderConfig({ SQLCOMMANDER_FIXTURE_VERSION: '1.0.0' })).toThrow('fixture')
  })
  it('refuses system installation on developer machines', () => {
    for (const format of ['exe', 'deb', 'rpm']) {
      expect(() => requireDisposableHost(format, {})).toThrow('disposable')
      expect(() => requireDisposableHost(format, { CI: 'true' })).toThrow('disposable')
      expect(() => requireDisposableHost(format, { CI: 'true', SQLCOMMANDER_DISPOSABLE_INSTALL_TEST: '1' })).not.toThrow()
    }
    expect(() => requireDisposableHost('dmg', {})).not.toThrow()
  })
  it('collects Linux artifacts using the native package architecture names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-linux-artifacts-')); directories.push(directory)
    // Names emitted by electron-builder 26 for the configured ${arch} pattern.
    const names = ['DbCommander-0.1.0-linux-x86_64.AppImage', 'DbCommander-0.1.0-linux-amd64.deb', 'DbCommander-0.1.0-linux-x86_64.rpm']
    for (const name of names) await writeFile(join(directory, name), `built ${name}`)
    expect((await artifactRecords(directory, '0.1.0', 'linux', 'x64')).map(file => file.name)).toEqual(names)
  })
  it('detects changed installer bytes and refuses symlink artifacts before promotion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-release-unit-')); directories.push(directory)
    const name = artifactNames('1.0.0', 'win32', 'x64')[0]
    await writeFile(join(directory, name), 'installer')
    const manifest = { schema: 1, version: '1.0.0', platform: 'win32', arch: 'x64', commit, buildId: '42', mode: 'signed', files: await artifactRecords(directory, '1.0.0', 'win32', 'x64') }
    await seedInventory(directory, manifest)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    expect((await readManifest(directory)).version).toBe('1.0.0')
    await writeFile(join(directory, name), 'changed')
    await expect(readManifest(directory)).rejects.toThrow('checksum')
    if (process.platform !== 'win32') {
      await rm(join(directory, name)); await writeFile(join(directory, 'target'), 'installer'); await symlink('target', join(directory, name))
      await expect(readManifest(directory)).rejects.toThrow('regular release artifact')
    }
  })
  it('rejects unsigned, unnotarized, stale, incomplete, failed or mismatched release evidence', () => {
    const manifest = { version: '1.0.0', platform: 'darwin', arch: 'arm64', commit, buildId: '42', mode: 'signed', fixture: false, verification: { codeSignature: true, notarization: true }, files: [{ name: 'installer', bytes: 1, sha256: 'b'.repeat(64) }] }
    manifest.inventory = { schema: 5, files: inventoryNames(manifest.version, manifest.platform, manifest.arch).map(name => ({ name })) }
    const report = { ...manifest, previousVersion: '0.0.0', tests: ['dmg', 'zip'].map(format => passedLifecycle('darwin', format)) }
    const expected = { version: '1.0.0', commit, buildId: '42' }
    expect(validateCandidate(manifest, [report], expected)).toBe('darwin-arm64')
    for (const schema of [1, 2, 3, 4]) expect(() => validateCandidate({ ...manifest, inventory: { ...manifest.inventory, schema } }, [report], expected)).toThrow('current release runtime inventory')
    for (const change of [{ mode: 'unsigned' }, { fixture: true }, { commit: 'c'.repeat(40) }, { buildId: '41' }, { verification: { codeSignature: false, notarization: true } }, { verification: { codeSignature: true, notarization: false } }]) expect(() => validateCandidate({ ...manifest, ...change }, [report], expected)).toThrow()
    for (const change of [{ tests: [] }, { tests: [{ format: 'dmg', status: 'failed' }] }, { previousVersion: '1.0.0' }, { previousVersion: '2.0.0' }, { files: [] }, { arch: 'x64' }]) expect(() => validateCandidate(manifest, [{ ...report, ...change }], expected)).toThrow()
  })
  it('requires RPM lifecycle evidence in addition to Debian and AppImage', () => {
    const manifest = { version: '1.0.0', platform: 'linux', arch: 'x64', commit, buildId: '42', mode: 'signed', fixture: false, files: [], verification: { codeSignature: false, notarization: false } }
    manifest.inventory = { schema: 5, files: inventoryNames(manifest.version, manifest.platform, manifest.arch).map(name => ({ name })) }
    const report = { ...manifest, previousVersion: '0.0.0', tests: ['deb', 'AppImage'].map(format => passedLifecycle('linux', format)) }
    expect(() => validateCandidate(manifest, [report], manifest)).toThrow('incomplete')
    const rpm = { ...report, tests: [passedLifecycle('linux', 'rpm')] }
    expect(validateCandidate(manifest, [report, rpm], manifest)).toBe('linux-x64')
    for (const mode of [undefined, 'platform-default', 'disabled-disposable-container']) {
      for (const format of ['deb', 'AppImage']) {
        const altered = { ...report, tests: report.tests.map(test => test.format === format ? { ...test, chromiumSandbox: mode } : test) }
        expect(() => validateCandidate(manifest, [altered, rpm], manifest)).toThrow('Chromium sandbox')
      }
    }
    expect(() => validateCandidate(manifest, [report, { ...rpm, tests: [{ ...rpm.tests[0], chromiumSandbox: 'platform-default' }] }], manifest)).toThrow('Chromium sandbox')
    expect(validateCandidate(manifest, [report, { ...rpm, tests: [{ ...rpm.tests[0], chromiumSandbox: 'enforced' }] }], manifest)).toBe('linux-x64')
  })
  it('promotes a complete same-run set and refuses changed bytes before creating any output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-promotion-unit-')); directories.push(directory)
    const env = { BUILD_SOURCEBRANCH: 'refs/heads/main', BUILD_SOURCEVERSION: commit, BUILD_BUILDID: '42' }
    for (const target of releaseTargets) {
      const [platform, arch] = target.split('-'), input = join(directory, `release-${target}`)
      await mkdir(input)
      for (const name of artifactNames('1.0.0', platform, arch)) await writeFile(join(input, name), `test artifact ${name}`)
      const manifest = { schema: 1, version: '1.0.0', platform, arch, commit, buildId: '42', mode: 'signed', fixture: false, files: await artifactRecords(input, '1.0.0', platform, arch), verification: { codeSignature: platform !== 'linux', notarization: platform === 'darwin' } }
      await seedInventory(input, manifest)
      await writeFile(join(input, 'manifest.json'), JSON.stringify(manifest))
      const formats = platform === 'darwin' ? ['dmg', 'zip'] : platform === 'win32' ? ['exe'] : ['deb', 'AppImage']
      const report = { ...manifest, previousVersion: '0.1.0', tests: formats.map(format => passedLifecycle(platform, format)) }
      await writeFile(join(input, 'lifecycle.json'), JSON.stringify(report))
      if (platform === 'linux') await writeFile(join(input, 'lifecycle-rpm.json'), JSON.stringify({ ...report, tests: [passedLifecycle('linux', 'rpm')] }))
    }
    const output = join(directory, 'promoted')
    await promoteRelease(directory, output, env)
    const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'))
    expect(release.targets).toEqual(releaseTargets); expect(release.files).toHaveLength(8)
    expect(release.inventory).toHaveLength(8)
    expect((await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n')).toHaveLength(16)
    for (const file of release.files) expect((await readFile(join(output, file.name), 'utf8')).startsWith('test artifact')).toBe(true)
    await writeFile(join(directory, 'release-linux-x64', artifactNames('1.0.0', 'linux', 'x64')[0]), 'changed after tests')
    const refusedOutput = join(directory, 'refused')
    await expect(promoteRelease(directory, refusedOutput, env)).rejects.toThrow('checksum')
    await expect(access(refusedOutput)).rejects.toThrow()
  })
})

it('keeps releases downstream of both successful main CI stages and signing secrets out of ordinary builds', () => {
  const pipeline = parse(readFileSync('azure-pipelines.yml', 'utf8'))
  expect(pipeline.trigger.branches.include).toEqual(['main']); expect(pipeline.pr).toBe('none')
  const releaseGroup = pipeline.stages.find(stage => stage['${{ if eq(parameters.createRelease, true) }}'])
  const release = releaseGroup['${{ if eq(parameters.createRelease, true) }}'].find(stage => stage.stage === 'Release')
  expect(release.dependsOn).toEqual(['Desktop', 'Drivers'])
  for (const required of ["eq(dependencies.Desktop.result, 'Succeeded')", "eq(dependencies.Drivers.result, 'Succeeded')", "eq(variables['Build.SourceBranch'], 'refs/heads/main')", 'parameters.createRelease', "eq(parameters.validationScope, 'all')"]) expect(release.condition).toContain(required)
  expect(pipeline.parameters.find(parameter => parameter.name === 'createRelease').default).toBe(false)
  expect(pipeline.parameters.find(parameter => parameter.name === 'validationScope')).toMatchObject({ default: 'all', values: ['all', 'windows-startup', 'windows-installers'] })
  expect(pipeline.stages.find(stage => stage.stage === 'Drivers').condition).toContain("eq(parameters.validationScope, 'all')")
  const desktop = readFileSync('.azure-pipelines/jobs/desktop.yml', 'utf8')
  expect(desktop).not.toMatch(/DownloadSecureFile|AZURE_CLIENT_SECRET|APPLE_CERTIFICATE_PASSWORD/)
  for (const file of ['.azure-pipelines/jobs/desktop.yml', '.azure-pipelines/jobs/release.yml', '.azure-pipelines/steps/installers.yml']) expect(() => parse(readFileSync(file, 'utf8'))).not.toThrow()
})
