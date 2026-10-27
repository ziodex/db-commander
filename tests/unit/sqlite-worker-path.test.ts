import { expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { sqliteWorkerPath } from '../../src/driver/sqlite-worker-path'

it('resolves the physical packaged worker for Windows, macOS and Linux Unicode installations', () => {
  for (const [paths, resources] of [
    [win32, 'C:\\Users\\Test é\\App with spaces % #\\resources'],
    [posix, '/Applications/SQL é.app/Contents/Resources'],
    [posix, '/opt/Application with spaces % # é/resources']
  ] as const) {
    expect(sqliteWorkerPath(paths.join(resources, 'app.asar', 'out', 'main'), paths)).toBe(paths.join(resources, 'workers', 'sqlite-worker.cjs'))
  }
})

it('keeps development workers beside the host and does not treat similarly named folders as ASAR', () => {
  for (const directory of ['/project/out/main', '/project/app.asar-copy/out/main', '/project/app.asar/out/other', '/project/app.asar/other/main']) {
    expect(sqliteWorkerPath(directory, posix)).toBe(posix.join(directory, 'sqlite-worker.cjs'))
  }
})
