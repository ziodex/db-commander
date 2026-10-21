import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopSettings } from '../../src/main/desktop-settings'

it('defaults to ordinary minimization and persists the application option independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-desktop-settings-'))
  try {
    const settings = new DesktopSettings(root); await settings.load()
    expect(settings.minimizeToTray).toBe(false)
    await settings.setMinimizeToTray(true)
    const reopened = new DesktopSettings(root); await reopened.load()
    expect(reopened.minimizeToTray).toBe(true)
    await reopened.setMinimizeToTray(false)
    expect(JSON.parse(await readFile(join(root, 'desktop-settings.json'), 'utf8'))).toEqual({ minimizeToTray: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps malformed, oversized and non-regular settings until repaired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-desktop-settings-damaged-')), path = join(root, 'desktop-settings.json')
  try {
    for (const contents of ['{broken', '{"minimizeToTray":"yes"}', '{"minimizeToTray":true,"extra":1}', ' '.repeat(4097)]) {
      await writeFile(path, contents)
      const settings = new DesktopSettings(root)
      await expect(settings.load()).rejects.toThrow('saved settings have been kept')
      expect(settings.minimizeToTray).toBe(false)
      await expect(settings.setMinimizeToTray(true)).rejects.toThrow('saved settings have been kept')
      expect(await readFile(path, 'utf8')).toBe(contents)
      await writeFile(path, '{"minimizeToTray":false}')
      await settings.setMinimizeToTray(true)
      expect(settings.minimizeToTray).toBe(true)
    }
    await rm(path); await mkdir(path)
    const settings = new DesktopSettings(root)
    await expect(settings.load()).rejects.toThrow('saved settings have been kept')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps the applied preference when publication fails and permits retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-desktop-settings-write-')), path = join(root, 'desktop-settings.json')
  try {
    const settings = new DesktopSettings(root)
    await settings.setMinimizeToTray(true)
    await rm(path); await mkdir(path)
    await expect(settings.setMinimizeToTray(false)).rejects.toThrow('regular file')
    expect(settings.minimizeToTray).toBe(true)
    await rm(path, { recursive: true }); await settings.setMinimizeToTray(false)
    expect(settings.minimizeToTray).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
