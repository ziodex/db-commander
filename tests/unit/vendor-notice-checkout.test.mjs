import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { vendorNotices, nativeDependencyNotices } from '../../scripts/release/config.cjs'

const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

it('preserves exact vendored notice bytes with Windows automatic CRLF checkout enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-notice-checkout-')); directories.push(root)
  const attributes = join(root, 'empty-global-attributes'); await writeFile(attributes, '')
  const git = args => execFileSync('git', ['-c', `core.attributesFile=${attributes}`, ...args], { cwd: root, stdio: 'pipe', timeout: 10000 })
  git(['init', '--quiet'])
  const files = [...new Set([...vendorNotices, ...nativeDependencyNotices].map(file => file.source))]
  const originals = new Map()
  for (const name of files) {
    const bytes = await readFile(new URL(`../../build/vendor-notices/${name}`, import.meta.url))
    const file = join(root, 'build/vendor-notices', name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes)
    originals.set(name, bytes)
  }
  git(['-c', 'core.autocrlf=false', 'add', 'build/vendor-notices'])
  const before = join(root, 'without-rule').replaceAll('\\', '/') + '/'
  git(['-c', 'core.autocrlf=true', 'checkout-index', `--prefix=${before}`, '--all'])
  // A mixed-newline upstream notice may already resist Git's automatic
  // conversion. The native Windows failure is reproduced by the LF-only
  // framework file; every source must remain exact once the rule is present.
  expect(await readFile(join(before, 'build/vendor-notices/Mantle-LICENSE.md'))).not.toEqual(originals.get('Mantle-LICENSE.md'))
  await writeFile(join(root, '.gitattributes'), await readFile(new URL('../../.gitattributes', import.meta.url)))
  git(['-c', 'core.autocrlf=false', 'add', '.gitattributes'])
  const after = join(root, 'with-rule').replaceAll('\\', '/') + '/'
  git(['-c', 'core.autocrlf=true', 'checkout-index', `--prefix=${after}`, '--all'])
  for (const name of files) expect(await readFile(join(after, 'build/vendor-notices', name))).toEqual(originals.get(name))
})
