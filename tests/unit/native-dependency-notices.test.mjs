import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeDependencyNoticeSources, pinnedNativeNoticeSource } from '../../scripts/release/config.cjs'

const require = createRequire(import.meta.url)
const provenance = require('../../build/vendor-notices/native-dependency-provenance.json')
const duckdbProvenance = require('../../build/vendor-notices/duckdb-dependency-provenance.json')
const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture(target = provenance.targets[0]) {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-crate-notices-')); directories.push(root)
  const file = { ...target }, binary = Buffer.from('reviewed native fixture')
  file.binarySha256 = createHash('sha256').update(binary).digest('hex')
  const folder = join(root, 'node_modules', file.package)
  await mkdir(folder, { recursive: true }); await writeFile(join(root, 'package.json'), '{}')
  for (const parent of file.parents) {
    const wrapper = join(root, 'node_modules', parent); await mkdir(wrapper, { recursive: true })
    await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: parent, main: 'index.js' }))
    await writeFile(join(wrapper, 'index.js'), '')
  }
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: file.package, version: file.version }))
  await writeFile(join(folder, file.binary), binary)
  const source = join(root, 'build/vendor-notices', file.source)
  await mkdir(dirname(source), { recursive: true }); await copyFile(new URL(`../../build/vendor-notices/${file.source}`, import.meta.url), source)
  return { root, file, folder, source }
}

it('preserves complete upstream Rust notices and the copyright text omitted from the napi crate archive', async () => {
  const { root, file } = await fixture()
  const source = pinnedNativeNoticeSource(file, root), text = await readFile(source.sourcePath, 'utf8')
  expect(source.destination).toBe(`licenses/${file.source}`)
  expect(source.binaryPath).toBe(`node_modules/${file.package}/${file.binary}`)
  for (const crate of file.crates) expect(text).toContain(`===== ${crate.name}-${crate.version} /`)
  expect(text).toContain('Copyright (c) 2015 Steven Fackler')
  expect(text).toContain('Copyright (c) 2016 keyring Developers')
  expect(text).toContain('Copyright (c) 2020-present LongYinan')
  expect(text).toContain('Copyright (c) 2018 GitHub')
})

it('requires renewed notice review after a package or native binary changes', async () => {
  const { root, file, folder } = await fixture()
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: file.package, version: '9.0.0' }))
  expect(() => pinnedNativeNoticeSource(file, root)).toThrow('Review native dependency notices')
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: file.package, version: file.version }))
  await writeFile(join(folder, file.binary), 'different same-version binary')
  expect(() => pinnedNativeNoticeSource(file, root)).toThrow('changed binary')
})

it('rejects altered notice texts or provenance paths and keeps unreviewed targets separate', async () => {
  const { root, file, source } = await fixture()
  await writeFile(source, 'incomplete license')
  expect(() => pinnedNativeNoticeSource(file, root)).toThrow('pinned upstream texts')
  expect(() => pinnedNativeNoticeSource({ ...file, source: '../notice.txt' }, root)).toThrow('Invalid native dependency notice provenance')
  for (const [platform, arch] of [['darwin', 'ia32'], ['win32', 'arm64'], ['linux', 'arm64']]) expect(nativeDependencyNoticeSources(platform, arch, root)).toEqual([])
})

it('retains the full target-specific notice texts for every inspected release binary', async () => {
  expect(provenance.targets.map(file => `${file.platform}/${file.arch}`).sort()).toEqual(['darwin/arm64', 'darwin/x64', 'linux/x64', 'win32/x64'])
  for (const target of provenance.targets) {
    const { root, file } = await fixture(target), notice = pinnedNativeNoticeSource(file, root)
    const text = await readFile(notice.sourcePath, 'utf8')
    for (const crate of file.crates) expect(text).toContain(`===== ${crate.name}-${crate.version} /`)
    if (target.platform === 'win32') expect(text).toContain('===== napi-sys-3.4.0 / LICENSE.upstream =====')
    if (target.platform === 'linux') { expect(text).toContain('===== aes-0.8.4 /'); expect(text).toContain('===== aes-0.9.3 /') }
  }
})

it('retains complete libdbus source notices for the positively identified Linux C library', async () => {
  const target = provenance.targets.find(file => file.platform === 'linux'), library = target.nativeLibraries[0]
  const { root, file } = await fixture(target), notice = pinnedNativeNoticeSource(file, root), bytes = await readFile(notice.sourcePath)
  expect(library.name).toBe('libdbus'); expect(library.version).toBe('1.14.4')
  expect(library.sourceHeaders).toHaveLength(library.referenceCSourceFiles + library.referenceLibraryHeaders)
  for (const record of [...library.noticeFiles, ...library.sourceHeaders.map(header => ({ ...header, name: `${header.path} original header` }))]) {
    const marker = Buffer.from(`===== libdbus-${library.version} / ${record.name} =====\n`)
    const index = bytes.indexOf(marker); expect(index, record.name).toBeGreaterThanOrEqual(0)
    expect(bytes.indexOf(marker, index + 1), record.name).toBe(-1)
    const actual = bytes.subarray(index + marker.length, index + marker.length + record.bytes)
    expect(actual.length, record.name).toBe(record.bytes)
    expect(createHash('sha256').update(actual).digest('hex'), record.name).toBe(record.sha256)
  }
})

it('retains exact DuckDB source and addon-header notices bound to both binaries on all four release targets', async () => {
  expect(duckdbProvenance.targets.filter(file => file.binary === 'duckdb.node').map(file => `${file.platform}/${file.arch}`).sort()).toEqual(['darwin/arm64', 'darwin/x64', 'linux/x64', 'win32/x64'])
  for (const target of duckdbProvenance.targets) {
    const { root, file, folder } = await fixture(target), notice = pinnedNativeNoticeSource(file, root), bytes = await readFile(notice.sourcePath)
    if (file.binary === 'duckdb.node') {
      expect(bytes.length).toBe(duckdbProvenance.nodeAddonApi.notice.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(duckdbProvenance.nodeAddonApi.notice.sha256)
      expect(bytes.toString()).toContain('Copyright (c) 2017 [Node.js API collaborators]')
    } else {
      expect(bytes.toString()).toContain('conservative source-notice superset')
      for (const record of duckdbProvenance.duckdb.sourceNoticeFiles) {
        const marker = Buffer.from(`===== DuckDB-1.5.6 source / ${record.path} =====\n`), index = bytes.indexOf(marker)
        expect(index, record.path).toBeGreaterThanOrEqual(0); expect(bytes.indexOf(marker, index + 1), record.path).toBe(-1)
        const original = bytes.subarray(index + marker.length, index + marker.length + record.bytes)
        expect(createHash('sha256').update(original).digest('hex'), record.path).toBe(record.sha256)
      }
    }
    await writeFile(join(folder, file.binary), 'changed same-version binary')
    expect(() => pinnedNativeNoticeSource(file, root)).toThrow('changed binary')
  }
})
