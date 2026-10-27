import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { githubBuildId, readManifest, isMain } from './release/common.mjs'
import { validateReleaseGate } from './check-release.mjs'
import { inventoryNames } from './release/inventory.mjs'
import { validateLifecycleReports } from './release/lifecycle.mjs'

export const releaseTargets = ['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64']
export function validateCandidate(manifest, reports, expected) {
  if (manifest.mode !== 'signed' || manifest.fixture || manifest.commit !== expected.commit || manifest.buildId !== expected.buildId || manifest.version !== expected.version) throw new Error('Only verified candidates from the same main CI run and version can be promoted.')
  const target = `${manifest.platform}-${manifest.arch}`
  if (!releaseTargets.includes(target)) throw new Error('Unexpected release architecture.')
  if (manifest.inventory?.schema !== 5 || JSON.stringify(manifest.inventory.files?.map(file => file.name)) !== JSON.stringify(inventoryNames(manifest.version, manifest.platform, manifest.arch))) throw new Error('Missing current release runtime inventory evidence.')
  if (manifest.platform !== 'linux' && manifest.verification?.codeSignature !== true) throw new Error('Missing code-signature verification.')
  if (manifest.platform === 'darwin' && manifest.verification?.notarization !== true) throw new Error('Missing Apple notarization verification.')
  validateLifecycleReports(manifest, reports)
  return target
}

export async function promoteRelease(input, output, env = process.env) {
  validateReleaseGate(env)
  const candidates = []
  let expected
  for (const target of releaseTargets) {
    const directory = join(input, `release-${target}`), manifest = await readManifest(directory)
    expected ??= { commit: env.GITHUB_SHA, buildId: githubBuildId(env), version: manifest.version }
    const reports = [JSON.parse(await readFile(join(directory, 'lifecycle.json'), 'utf8'))]
    if (manifest.platform === 'linux') reports.push(JSON.parse(await readFile(join(directory, 'lifecycle-rpm.json'), 'utf8')))
    if (validateCandidate(manifest, reports, expected) !== target) throw new Error('Release directory/architecture mismatch.')
    candidates.push({ target, directory, manifest, reports })
  }
  // Verify the entire set before making a publishable directory.
  await mkdir(output, { recursive: false })
  const files = [], inventory = []
  for (const { target, directory, manifest, reports } of candidates) {
    for (const file of manifest.files) { await copyFile(join(directory, file.name), join(output, file.name)); files.push(file) }
    for (const file of manifest.inventory.files) { await copyFile(join(directory, file.name), join(output, file.name)); inventory.push(file) }
    await writeFile(join(output, `${target}.json`), JSON.stringify({ manifest, lifecycle: reports }, null, 2) + '\n')
  }
  await writeFile(join(output, 'release.json'), JSON.stringify({ schema: 1, ...expected, targets: releaseTargets, files, inventory }, null, 2) + '\n')
  await writeFile(join(output, 'SHA256SUMS'), [...files, ...inventory].map(file => `${file.sha256}  ${file.name}\n`).join(''))
  console.log(`Verified all four native targets for Db Commander ${expected.version}.`)
}

if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } })
  if (!values.input || !values.output) throw new Error('Supply --input and --output directories.')
  await promoteRelease(resolve(values.input), resolve(values.output))
}
