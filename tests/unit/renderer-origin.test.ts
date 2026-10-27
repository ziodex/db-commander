import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rendererOrigin } from '../../src/main/renderer-origin'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-origin-')); directories.push(directory)
  const installation = join(directory, 'Application with spaces % and # é')
  mkdirSync(installation)
  const file = join(installation, 'index.html'); writeFileSync(file, 'trusted')
  const other = join(installation, 'other.html'); writeFileSync(other, 'untrusted')
  return { directory, installation, file, other }
}

it('loads and accepts the exact installed file with URL-sensitive characters and fragments', () => {
  const { file } = fixture(), origin = rendererOrigin(file)
  expect(origin.url).toBe(pathToFileURL(realpathSync(file)).href)
  expect(origin.accepts(origin.url)).toBe(true)
  expect(origin.accepts(origin.url + '#query')).toBe(true)
  expect(origin.accepts(origin.url.replace('index.html', '%69ndex.html'))).toBe(true)
})

it('accepts a resolved installation alias without accepting another file in that directory', () => {
  const { directory, installation, file } = fixture(), alias = join(directory, 'installation-alias')
  symlinkSync(installation, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const origin = rendererOrigin(file)
  expect(origin.accepts(pathToFileURL(join(alias, 'index.html')).href)).toBe(true)
  expect(origin.accepts(pathToFileURL(join(alias, 'other.html')).href)).toBe(false)
})

it('rejects other local files, remote URLs, query strings and malformed URLs', () => {
  const { file, other } = fixture(), origin = rendererOrigin(file)
  for (const candidate of [undefined, '', 'bad url', 'about:blank', 'https://example.invalid/index.html',
    pathToFileURL(other).href, origin.url + '?untrusted=1', origin.url.replace('file:///', 'file://example.invalid/'),
    origin.url.replace('index.html', '%2Findex.html')]) expect(origin.accepts(candidate)).toBe(false)
})

it('limits development URLs to the configured origin', () => {
  const file = join(tmpdir(), 'not-built-yet', 'index.html'), origin = rendererOrigin(file, 'http://localhost:5173')
  expect(origin.accepts('http://localhost:5173/index.html#query')).toBe(true)
  expect(origin.accepts('http://localhost:5174')).toBe(false)
  expect(origin.accepts('https://localhost:5173')).toBe(false)
  expect(origin.accepts(pathToFileURL(file).href)).toBe(false)
})
