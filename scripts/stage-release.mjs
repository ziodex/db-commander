import { mkdir, copyFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readManifest, isMain } from './release/common.mjs'
import { validateLifecycleReports } from './release/lifecycle.mjs'

export async function stageRelease(source, output, { baseline = false } = {}) {
  const manifest = await readManifest(source)
  const reports = baseline ? [] : ['lifecycle.json', ...(manifest.platform === 'linux' ? ['lifecycle-rpm.json'] : [])]
  if (!baseline) {
    if (manifest.inventory.schema !== 5) throw new Error('Missing current release runtime inventory evidence.')
    validateLifecycleReports(manifest, await Promise.all(reports.map(async name => JSON.parse(await readFile(join(source, name), 'utf8')))))
  }
  await mkdir(output, { recursive: false })
  // Whitelist published files. Never include signing keychains, credentials,
  // unpacked applications, debug configuration or the upgrade fixture by accident.
  for (const name of ['manifest.json', 'SHA256SUMS', ...manifest.files.map(file => file.name), ...manifest.inventory.files.map(file => file.name), ...reports]) await copyFile(join(source, name), join(output, name))
}
if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { source: { type: 'string', default: 'release/candidate' }, output: { type: 'string' }, baseline: { type: 'boolean' } } })
  if (!values.output) throw new Error('Supply --output.')
  await stageRelease(resolve(values.source), resolve(values.output), values)
}
