import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

it('cleans only the script project outputs when invoked from another directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-clean-'))
  const project = join(directory, 'Project with spaces'), caller = join(directory, 'caller')
  try {
    for (const name of ['scripts', 'src', 'node_modules', 'release', 'out', '.test-artifacts']) mkdirSync(join(project, name), { recursive: true })
    mkdirSync(join(caller, 'release'), { recursive: true })
    const script = join(project, 'scripts/clean.mjs')
    copyFileSync(new URL('../../scripts/clean.mjs', import.meta.url), script)
    writeFileSync(join(project, 'src/keep.ts'), 'source')
    writeFileSync(join(project, 'release/generated.zip'), 'generated')
    writeFileSync(join(caller, 'release/keep.txt'), 'outside project')
    execFileSync(process.execPath, [script], { cwd: caller })
    for (const name of ['release', 'out', '.test-artifacts']) expect(existsSync(join(project, name))).toBe(false)
    expect(readFileSync(join(project, 'src/keep.ts'), 'utf8')).toBe('source')
    expect(existsSync(join(project, 'node_modules'))).toBe(true)
    expect(readFileSync(join(caller, 'release/keep.txt'), 'utf8')).toBe('outside project')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
