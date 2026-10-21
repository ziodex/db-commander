import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { createRequire } from 'node:module'
import { builderConfig, signingSettings, artifactNames, safeArtifact } from '../../scripts/release/config.cjs'
import { artifactRecords, githubBuildId, readManifest, requireNativeWindowsX64 } from '../../scripts/release/common.mjs'
import { validateReleaseGate } from '../../scripts/check-release.mjs'
import { requireDisposableHost } from '../../scripts/release/install.mjs'
import { releaseBuildEnvironment } from '../../scripts/build-release.mjs'
import { promoteRelease, validateCandidate, releaseTargets } from '../../scripts/promote-release.mjs'
import { seedInventory } from '../fixtures/release-inventory.mjs'
import { inventoryNames } from '../../scripts/release/inventory.mjs'

const commit = 'a'.repeat(40), directories = []
const releaseEnvironment = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', SQLCOMMANDER_RELEASE_GATE: 'main-ci-passed' }
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
    expect(config.appImage.executableArgs).toEqual([])
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
  it('requires an explicit main GitHub Actions release with the same-run CI gate', () => {
    expect(() => validateReleaseGate(releaseEnvironment)).not.toThrow()
    for (const change of [
      { GITHUB_REF: 'refs/heads/development' }, { GITHUB_REF: 'refs/pull/1/merge' },
      { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_ACTIONS: undefined }, { GITHUB_SHA: 'short-sha' },
      { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' }, { SQLCOMMANDER_RELEASE_GATE: '' }
    ]) expect(() => validateReleaseGate({ ...releaseEnvironment, ...change })).toThrow()
  })
  it('binds GitHub manifests to both the workflow run and its attempt', () => {
    expect(githubBuildId({})).toBe('local')
    expect(githubBuildId(releaseEnvironment)).toBe('42.1')
    expect(githubBuildId({ ...releaseEnvironment, GITHUB_RUN_ATTEMPT: '2' })).toBe('42.2')
    for (const change of [{ GITHUB_RUN_ID: 'bad' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: undefined }]) expect(() => githubBuildId({ ...releaseEnvironment, ...change })).toThrow('run ID and attempt')
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
    const env = releaseEnvironment
    for (const target of releaseTargets) {
      const [platform, arch] = target.split('-'), input = join(directory, `release-${target}`)
      await mkdir(input)
      for (const name of artifactNames('1.0.0', platform, arch)) await writeFile(join(input, name), `test artifact ${name}`)
      const manifest = { schema: 1, version: '1.0.0', platform, arch, commit, buildId: githubBuildId(env), mode: 'signed', fixture: false, files: await artifactRecords(input, '1.0.0', platform, arch), verification: { codeSignature: platform !== 'linux', notarization: platform === 'darwin' } }
      await seedInventory(input, manifest)
      await writeFile(join(input, 'manifest.json'), JSON.stringify(manifest))
      const formats = platform === 'darwin' ? ['dmg', 'zip'] : platform === 'win32' ? ['exe'] : ['deb', 'AppImage']
      const report = { ...manifest, previousVersion: '0.1.0', tests: formats.map(format => passedLifecycle(platform, format)) }
      await writeFile(join(input, 'lifecycle.json'), JSON.stringify(report))
      if (platform === 'linux') await writeFile(join(input, 'lifecycle-rpm.json'), JSON.stringify({ ...report, tests: [passedLifecycle('linux', 'rpm')] }))
    }
    const staleOutput = join(directory, 'stale-attempt')
    await expect(promoteRelease(directory, staleOutput, { ...env, GITHUB_RUN_ATTEMPT: '2' })).rejects.toThrow('same main CI run')
    await expect(access(staleOutput)).rejects.toThrow()
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

describe('GitHub Actions CI contracts', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const actions = readdirSync('.github/actions').map(name => parse(readFileSync(`.github/actions/${name}/action.yml`, 'utf8')))

  it('covers native desktop targets and all real driver contracts on pushes and pull requests', () => {
    expect(workflow.on.push.branches).toEqual(['main', 'development'])
    expect(workflow.on.pull_request.branches).toEqual(['main', 'development'])
    expect(workflow.on).not.toHaveProperty('pull_request_target')
    const targets = workflow.jobs.desktop.strategy.matrix.include
    expect(targets).toEqual([
      { os: 'macos-15-intel', platform: 'darwin', arch: 'x64' },
      { os: 'macos-15', platform: 'darwin', arch: 'arm64' },
      { os: 'windows-2025', platform: 'win32', arch: 'x64' },
      { os: 'ubuntu-24.04', platform: 'linux', arch: 'x64' }
    ])
    expect(workflow.jobs.release.strategy.matrix.include).toEqual(targets)
    expect(workflow.jobs.drivers['runs-on']).toBe('ubuntu-24.04')
    expect(new Set(workflow.jobs.drivers.strategy.matrix.driver)).toEqual(new Set(['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'oracle', 'duckdb']))
    expect(workflow.jobs.drivers.strategy['max-parallel']).toBe(3)
    expect(JSON.stringify(actions)).toContain('pnpm install --frozen-lockfile')
    expect(JSON.stringify(workflow.jobs.drivers.steps)).toContain('scripts/with-test-desktop.mjs pnpm test:desktop --driver')
    expect(existsSync('azure-pipelines.yml')).toBe(false)
    expect(existsSync('.azure-pipelines')).toBe(false)
  })

  it('keeps signing opt-in, main-only and downstream of all validation, with no fork secrets', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.workflow_dispatch.inputs.create_release.default).toBe(false)
    const release = workflow.jobs.release
    expect(release.needs).toEqual(['desktop', 'drivers', 'release-request'])
    for (const required of ["github.event_name == 'workflow_dispatch'", 'inputs.create_release', "github.ref == 'refs/heads/main'", "needs.desktop.result == 'success'", "needs.drivers.result == 'success'", "needs.release-request.result == 'success'"]) expect(release.if).toContain(required)
    expect(release.environment).toBe('release')
    expect(JSON.stringify(release)).toContain('secrets.APPLE_CERTIFICATE_BASE64')
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'release') expect(JSON.stringify(job)).not.toContain('secrets.')
      for (const step of job.steps) if (step.uses?.startsWith('actions/checkout@')) expect(step.with['persist-credentials']).toBe(false)
    }
    for (const step of [...Object.values(workflow.jobs).flatMap(job => job.steps), ...actions.flatMap(action => action.runs.steps)]) if (step.uses && !step.uses.startsWith('./')) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
  })

  it('promotes only staged candidates from this run after every signed target succeeds', () => {
    expect(workflow.jobs.promote.needs).toBe('release')
    const download = workflow.jobs.promote.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
    expect(download.with.pattern).toBe('release-*')
    expect(download.with).not.toHaveProperty('run-id')
    expect(download.with).not.toHaveProperty('repository')
    const reports = parse(readFileSync('.github/actions/reports/action.yml', 'utf8'))
    expect(reports.runs.steps[0].if).toBe('always()')
    for (const job of [workflow.jobs.desktop, workflow.jobs.release]) {
      const stage = job.steps.findIndex(step => step.run?.startsWith('node scripts/stage-release.mjs'))
      expect(stage).toBeGreaterThan(job.steps.findIndex(step => step.uses === './.github/actions/installers'))
      const upload = job.steps[stage + 1]
      expect(upload.uses).toMatch(/^actions\/upload-artifact@/)
      expect(upload.with.path).toMatch(/^\.test-artifacts\/(staged-installers|release-candidate)$/)
      expect(job.steps.at(-1)).toMatchObject({ uses: './.github/actions/reports', if: 'always()' })
    }
  })

  it('keeps manual Windows diagnostics unsigned and separate from release qualification', () => {
    const diagnostic = parse(readFileSync('.github/workflows/windows-diagnostics.yml', 'utf8'))
    expect(Object.keys(diagnostic.on)).toEqual(['workflow_dispatch'])
    expect(diagnostic.on.workflow_dispatch.inputs.installers.default).toBe(false)
    expect(diagnostic.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(diagnostic)).not.toContain('secrets.')
    expect(JSON.stringify(diagnostic)).not.toContain('--signed')
    expect(JSON.stringify(diagnostic)).toContain('SQLCOMMANDER_STARTUP_ONLY')
  })
})
