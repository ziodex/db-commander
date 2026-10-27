import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { root, nativeTarget, run } from './release/common.mjs'

await nativeTarget('x64')
if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.SQLCOMMANDER_DISPOSABLE_INSTALL_TEST !== '1') throw new Error('RPM lifecycle tests require a disposable native Linux CI worker.')
const uid = process.getuid(), dockerfile = await readFile(join(root, 'tests/installers/Dockerfile.rpm'))
const tag = `dbcommander-rpm-tests:${createHash('sha256').update(dockerfile).update(String(uid)).digest('hex').slice(0, 16)}`
const exists = await run('docker', ['image', 'inspect', tag], { capture: true }).then(() => true, () => false)
if (!exists) await run('docker', ['build', '--pull=false', '--build-arg', `TEST_UID=${uid}`, '-t', tag, '-f', 'tests/installers/Dockerfile.rpm', '.'], { timeout: 15 * 60_000 })
await run('docker', ['run', '--rm', '--init', '--network=none', '--shm-size=1g', '-v', `${root}:/workspace`, tag,
  'bash', 'scripts/with-test-keyring.sh', 'node', 'scripts/with-test-desktop.mjs', 'node', 'scripts/test-installers.mjs', '--format', 'rpm', '--report', 'release/candidate/lifecycle-rpm.json'], { timeout: 15 * 60_000 })
