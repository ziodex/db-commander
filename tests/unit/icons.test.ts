import { expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve('build/icons'), require = createRequire(import.meta.url)
const pngSize = (buffer: Buffer) => {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
}

it('ships all desktop icon sizes as real square PNGs', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) expect(pngSize(readFileSync(join(root, `${size}x${size}.png`)))).toEqual([size, size])
})
it('ships standard and Retina menu bar template images', () => {
  expect(pngSize(readFileSync(join(root, 'trayTemplate.png')))).toEqual([18, 18])
  expect(pngSize(readFileSync(join(root, 'trayTemplate@2x.png')))).toEqual([36, 36])
})
it('ships a complete multiresolution Windows ICO with bounded PNG entries', () => {
  const file = readFileSync(join(root, 'icon.ico'))
  expect(file.readUInt16LE(0)).toBe(0); expect(file.readUInt16LE(2)).toBe(1); expect(file.readUInt16LE(4)).toBe(7)
  for (let index = 0; index < 7; index++) {
    const start = 6 + index * 16, size = file[start] || 256, bytes = file.readUInt32LE(start + 8), offset = file.readUInt32LE(start + 12)
    expect(offset).toBeGreaterThanOrEqual(6 + 7 * 16); expect(offset + bytes).toBeLessThanOrEqual(file.length)
    expect(pngSize(file.subarray(offset, offset + bytes))).toEqual([size, size])
  }
})
it('ships a complete macOS ICNS with the master and small-size representations', () => {
  const file = readFileSync(join(root, 'icon.icns')), sizes: number[] = []
  expect(file.toString('ascii', 0, 4)).toBe('icns'); expect(file.readUInt32BE(4)).toBe(file.length)
  let offset = 8
  while (offset < file.length) {
    const length = file.readUInt32BE(offset + 4); expect(length).toBeGreaterThan(8); expect(offset + length).toBeLessThanOrEqual(file.length)
    sizes.push(pngSize(file.subarray(offset + 8, offset + length))[0]); offset += length
  }
  expect(offset).toBe(file.length); expect(sizes).toEqual([16, 32, 64, 128, 256, 512, 1024])
})
it('uses custom app and runtime icons in unsigned and signed package configurations', () => {
  const { builderConfig } = require('../../scripts/release/config.cjs')
  for (const signed of ['0', '1']) {
    const config = builderConfig({ SQLCOMMANDER_SIGNED_RELEASE: signed })
    expect(existsSync(config.mac.icon)).toBe(true); expect(config.mac.icon).toBe('build/icons/icon.icns')
    expect(existsSync(config.win.icon)).toBe(true); expect(config.win.icon).toBe('build/icons/icon.ico')
    expect(config.linux.icon).toBe('build/icons')
    expect(config.extraResources).toContainEqual({ from: 'build/icons/1024x1024.png', to: 'icon.png' })
    for (const name of ['trayTemplate.png', 'trayTemplate@2x.png']) expect(config.extraResources).toContainEqual({ from: `build/icons/${name}`, to: name })
  }
})
