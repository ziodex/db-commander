import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../build/macos-icon/', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'dbcommander-macos-icon-'))
try {
  execFileSync('xcrun', [
    'actool', '--compile', output,
    '--output-partial-info-plist', join(output, 'Info.plist'),
    '--platform', 'macosx', '--minimum-deployment-target', '13.0',
    '--app-icon', 'DbCommanderIcon', join(source, 'DbCommanderIcon.icon')
  ], { stdio: 'inherit' })
  copyFileSync(join(output, 'Assets.car'), join(source, 'Assets.car'))
} finally {
  rmSync(output, { recursive: true, force: true })
}
